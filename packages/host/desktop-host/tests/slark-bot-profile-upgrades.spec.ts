import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { create as createArchive } from 'tar'
import { parse } from 'yaml'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { BotUpgradePolicies } from '../src/slark-bot-upgrade-policy.ts'
import { BotProfileUpgrades } from '../src/slark-bot-profile-upgrades.ts'
import { ProfileUpgradeJournal } from '../src/profile-upgrade-journal.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfilePluginExecutor, type ProfilePluginUpgradeParticipant } from '../src/profile-plugin-executor.ts'
import { capturePluginTree } from '../src/plugin-tree-snapshot.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { existingProfilePatch } from '../src/offline-profile-recovery.ts'
import type { PersonProfileId, PersonProfileRecord } from '../src/types.ts'

const posixIt = it.skipIf(process.platform === 'win32') // These are the POSIX private-file and worker channels.
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Failure = 'none' | 'install' | 'after-activation' | 'after-selection' | 'rollback-interrupted' | 'store-loss' | 'preparation' | 'revoked'

async function fixture(failure: Failure = 'none', sourceVersion = '0.2.0', kind: 'local-anonymous' | 'account' = 'local-anonymous') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bot-profile-upgrade-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const uid = process.getuid!(), profileRoot = join(root, 'profile'), control = join(root, 'control'), resources = join(root, 'resources')
  const web = join(profileRoot, 'profiles/web')
  for (const path of [profileRoot, control, resources, web]) await mkdir(path, { recursive: true, mode: 0o700 })
  const source = async (version: string, target: boolean) => {
    const staging = join(root, `code-${version}`), pkg = join(staging, 'package')
    await mkdir(join(pkg, 'src/host'), { recursive: true, mode: 0o700 })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'ds-bot', version, type: 'module', dsh: { bundle: { patch: 'cordis.patch.yml' } } }), { mode: 0o600 })
    await writeFile(join(pkg, 'cordis.patch.yml'), '- insert: [{id: bot, name: ds-bot}]\n', { mode: 0o600 })
    await writeFile(join(pkg, 'src/host/constants.js'), 'export const TEXT_KEPT=2000\n', { mode: 0o600 })
    await writeFile(join(pkg, 'src/host/store.js'), `import {readFile,writeFile} from 'node:fs/promises';
export function install(rt){let state;rt.load=async()=>{state=JSON.parse(await readFile(rt.statePath,'utf8'));};
rt.hasExclusiveWriter=()=>true;rt.readOnly=()=>undefined;rt.save=async()=>{${target ? `state.revision++;state.additiveDefault=true;${failure === 'store-loss' ? 'delete state.rooms;' : ''}` : ''}
await writeFile(rt.statePath,JSON.stringify(state));};rt.ctx.effect(()=>()=>Promise.resolve());}\n`, { mode: 0o600 })
    const file = join(resources, `ds-bot-${version}.tgz`)
    await createArchive({ cwd: staging, file, gzip: true }, ['package'])
    return { pkg, file, version, sha256: hash(await readFile(file)) }
  }
  const old = await source(sourceVersion, false), next = await source('0.3.8-slark.1', true)
  let predecessor = { ...old }
  const row = { name: 'ds-bot', version: next.version, file: `ds-bot-${next.version}.tgz`, sha256: next.sha256,
    repository: 'https://example.com/fixture', sourceSha: '1'.repeat(40), entryIds: ['bot'] }
  await writeFile(join(resources, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [row] }), { mode: 0o600 })
  await writeFile(join(resources, 'profile-upgrades.v1.json'), JSON.stringify({ schemaVersion: 1, upgrades: [{
    policy: 'ds-bot-v1', name: 'ds-bot', targetVersion: next.version, targetSha256: next.sha256,
    sources: [{ version: old.version, sha256: old.sha256 }],
  }] }), { mode: 0o600 })
  let catalog = BundledPluginCatalog.load(resources, uid)
  let policies = BotUpgradePolicies.load(resources, uid, catalog)
  await mkdir(join(web, '.bundled-plugins'), { mode: 0o700 })
  await cp(old.file, join(web, '.bundled-plugins', `${old.sha256}.tgz`))
  const installed = join(web, 'node_modules/ds-bot')
  await mkdir(join(web, 'node_modules'), { mode: 0o700 }); await cp(old.pkg, installed, { recursive: true })
  const manifest = (digest: string) => JSON.stringify({ dependencies: { 'ds-bot': `file:.bundled-plugins/${digest}.tgz` }, dsh: { profile: { bundles: ['ds-bot'] } } })
  await writeFile(join(web, 'package.json'), manifest(old.sha256), { mode: 0o600 })
  await writeFile(join(web, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
  const originalHome = join(profileRoot, 'bot'); await mkdir(originalHome, { mode: 0o700 })
  const state = { version: 1, revision: 1, mainBotIds: ['b'], bots: { b: { id: 'b', name: 'Bot', sessionId: 'history' } },
    rooms: { r: { id: 'r', name: 'Named group', named: true, members: ['b'], log: [{ seq: 1, text: '历史消息', attachments: ['photo.bin'] }] } }, prefs: { theme: 'dark' } }
  const original = JSON.stringify(state)
  await writeFile(join(originalHome, 'state.json'), original, { mode: 0o600 })
  await writeFile(join(originalHome, 'photo.bin'), Buffer.from([0, 255, 128, 1]), { mode: 0o600 })
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid)
  await target.activePersistenceConfig()
  const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
    { kind: 'settings', schemaVersion: 1, value: { theme: 'dark' } },
    { kind: 'credentials', schemaVersion: 1, value: { refs: { KEY: 'fixture-reference' }, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ] }
  await target.importOwnerState(1, ownerState)
  await target.importSession(1, { version: SESSION_FORMAT_VERSION, id: SessionId('history'), createdAt: 1, isSeeded: false }, [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const owners = new MigrationOwnerStateApplicator(uid)
  const paths = await owners.apply(profileRoot, 1, ownerState)
  await writeFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot,
    await target.activePersistenceConfig(), paths), { mode: 0o600 })
  let profile: PersonProfileRecord = { profileId: randomUUID() as PersonProfileId, kind,
    personIndex: 'fixture-owner', keyHandle: 'fixture-key', unlockVerifier: null, bindingGeneration: 1, createdAt: 1 }
  const id = profile.profileId
  const home = () => {
    const patches = parse(readFileSync(join(web, 'cordis.patch.yml'), 'utf8')) as Array<{ id?: string; config?: { home?: string } }>
    const selected = patches.filter(row => row.id === 'bot' && row.config?.home).at(-1)?.config?.home
    return selected ? relative(profileRoot, selected).split('\\').join('/') : 'bot'
  }
  const receipts = new FileExtensionReceipts(join(control, 'receipts'), uid)
  const journalRoot = join(control, 'upgrades'), journal = new ProfileUpgradeJournal(journalRoot, uid)
  let generation = 0, installCalls = 0, rollbackCalls = 0, failAck = failure === 'after-activation', failSelected = failure === 'after-selection', authorized = true
  let releaseInstall!: () => void, enteredInstall!: () => void
  const installedBarrier = new Promise<void>((resolve) => { enteredInstall = resolve })
  const installReleased = new Promise<void>((resolve) => { releaseInstall = resolve })
  const workers = new ProfileWorkerSupervisor(async () => ({ generation: ++generation,
    viewOrigin: `http://127.0.0.1:${33000 + generation}`, bootstrapCookie: { name: 'fixture', value: 'private' },
    closeNotifications() {}, abort() {}, done: Promise.resolve(),
  }))
  onTestFinished(() => workers.disposeAll())
  const options = {
    uid, journal, catalog, policies, installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150',
    profile: () => profile, profileRoot: () => profileRoot, home: (): string | undefined => home(), target: () => target, workers, receipts,
    materialize: async (selected: PersonProfileRecord, permit: Parameters<Parameters<typeof workers.withProfileMaintenance>[1]>[0]) => {
      const persistence = await target.activePersistenceConfig()
      const paths = await owners.inspectExisting(profileRoot, persistence.generation)
      await writeFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot, persistence, paths))
      await permit.ensure({ profileId: selected.profileId, profileRoot, credentialHandle: selected.keyHandle, pluginRoots: [] })
    },
    recoverPackage: (...args: Parameters<ProfilePluginExecutor['recoverDataUpgrade']>) => executor.recoverDataUpgrade(...args),
  }
  let upgrades = new BotProfileUpgrades(options)
  const executorOptions: ConstructorParameters<typeof ProfilePluginExecutor>[0] = { resolve: () => profileRoot, uid, dataUpgrade: {
    handles: (...args) => upgrades.handles(...args), validate: (...args) =>{  upgrades.validate(...args) },
    run: (...args) => upgrades.run(...args),
  },
  togglePlan: () => ({ patch: '', expected: [], disabled: [], previousExpected: [], previousDisabled: [] }),
  acknowledgeToggle: async () => {},
  upgradePlan: async () => ({ patch: '[]\n', rollback: { spec: `bundled:ds-bot@${predecessor.version}`, digest: predecessor.sha256 } }),
  bundledPlugin: () => ({ entryIds: ['bot'], dependency: `file:.bundled-plugins/${next.sha256}.tgz` }),
  verifyUpgradeTarget: async () => {
    const identity: unknown = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
    expect(identity).toMatchObject({ version: next.version })
  },
  install: async () => {
    installCalls++
    catalog.materialize(catalog.get('ds-bot', next.version)!, web)
    await rm(installed, { recursive: true }); await cp(next.pkg, installed, { recursive: true })
    await writeFile(join(web, 'package.json'), manifest(next.sha256))
    if (failure === 'revoked') { enteredInstall(); await installReleased }
    if (failure === 'install' || failure === 'rollback-interrupted') throw Error('command response lost')
  },
  rollbackUpgrade: async () => {
    rollbackCalls++
    if (failure === 'rollback-interrupted' && rollbackCalls === 1) throw Error('rollback process exited before response')
    await rm(installed, { recursive: true }); await cp(predecessor.pkg, installed, { recursive: true })
    await writeFile(join(web, 'package.json'), manifest(predecessor.sha256))
    return capturePluginTree(installed, uid).digest
  },
  acknowledge: async (_profileId, _packageName, _context, participant) => {
    if (!participant) throw Error('data participant required')
    if (failSelected) { failSelected = false; throw Error('interrupted after selector publication, before activation') }
    await participant.restart()
    await expect(workers.activate(id)).rejects.toMatchObject({ code: 'unavailable' })
    if (failAck) {
      failAck = false
      const path = join(profileRoot, home(), 'state.json')
      const data = JSON.parse(await readFile(path, 'utf8')) as typeof state
      data.rooms.r.log.push({ seq: 2, text: '升级后新消息', attachments: [] })
      await writeFile(path, JSON.stringify(data))
      throw Error('ACK response lost after a target write')
    }
  },
  }
  const executor = new ProfilePluginExecutor(executorOptions)
  const operations = new ProfileExtensionOperations(receipts, executor, { now: Date.now })
  onTestFinished(() => operations.dispose())
  const start = async () => {
    const authority = () => { if (!authorized) throw Error('authority revoked'); return id }
    const plan = await operations.prepare(authority, 'plugin', JSON.stringify({ action: 'update', packageName: 'ds-bot', spec: `bundled:ds-bot@${next.version}` }))
    const operationId = randomUUID(); operations.commit(authority, plan.planId, operationId); await operations.settled()
    return operationId
  }
  const nextTarget = async (restoreBeforeActivation = false) => {
    predecessor = { ...next }
    const successor = await source('0.3.9-fixture', true)
    const successorRow = { ...row, version: successor.version, file: `ds-bot-${successor.version}.tgz`, sha256: successor.sha256 }
    await writeFile(join(resources, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [row, successorRow] }))
    await writeFile(join(resources, 'profile-upgrades.v1.json'), JSON.stringify({ schemaVersion: 1, upgrades: [{
      policy: 'ds-bot-v1', name: 'ds-bot', targetVersion: successor.version, targetSha256: successor.sha256,
      sources: [{ version: predecessor.version, sha256: predecessor.sha256 }],
    }] }))
    Object.assign(next, successor)
    catalog = BundledPluginCatalog.load(resources, uid)
    policies = BotUpgradePolicies.load(resources, uid, catalog)
    const currentOptions = { ...options, catalog, policies }
    upgrades = new BotProfileUpgrades(currentOptions)
    failSelected = restoreBeforeActivation
    return { upgrades, options: currentOptions }
  }
  if (failure === 'preparation') await writeFile(join(originalHome, 'state.lock'), '{}', { mode: 0o600 })
  const run = async (operation: (participant: ProfilePluginUpgradeParticipant) => Promise<{ state: 'succeeded' | 'failed' }>,
    guard: () => void = () => {}) => {
    const operationId = randomUUID()
    receipts.write({ version: 1, operationId, profileId: id, planId: randomUUID(), kind: 'plugin',
      digest: 'a'.repeat(64), state: 'running', cancellationRequested: false, createdAt: 1, updatedAt: 1 })
    return upgrades.run(id, `bundled:ds-bot@${next.version}`,
      { kind: 'plugin', operationId, guard, signal: new AbortController().signal }, operation)
  }
  return { nextTarget, executor, executorOptions, originalManifest: manifest(old.sha256), targetManifest: manifest(next.sha256),
    installedBarrier, releaseInstall, revoke: () => { authorized = false },
    root, profileRoot, web, target, journal, receipts, workers, upgrades, options, start, run, home, original, originalHome,
    calls: () => ({ installCalls, rollbackCalls }), changeOwner: () => { profile = { ...profile, personIndex: 'another-owner' } }, id }
}

posixIt('commits exact package and separate Bot/session generations while retaining original history and attachments', async () => {
  const f = await fixture(), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  expect(f.journal.read(f.id, op).phase).toBe('committed')
  expect(await f.target.activeGeneration()).toBe(2)
  expect(f.home()).toBe(`bot-upgrades/${op}`)
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  expect(await readFile(join(f.profileRoot, f.home(), 'photo.bin'))).toEqual(Buffer.from([0, 255, 128, 1]))
  await expect(f.workers.activate(f.id)).resolves.toMatchObject({ generation: 1 })
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('restores package, configuration and the original data selection when installation fails before activation', async () => {
  const f = await fixture('install'), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(await f.target.activeGeneration()).toBe(1)
  expect(f.home()).toBe('bot')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 1 })
})

posixIt('recovers the original operation forward without reinstalling or overwriting a post-activation message', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.journal.read(f.id, op).phase).toBe('activating')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
  const recovered = new BotProfileUpgrades({ ...f.options, journal: new ProfileUpgradeJournal(join(f.root, 'control/upgrades'), process.getuid!()) })
  await recovered.recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  expect(f.journal.read(f.id, op).phase).toBe('committed')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses recovery after Profile ownership changes and preserves both data sets', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  f.changeOwner()
  await expect(new BotProfileUpgrades(f.options).recover(f.id)).rejects.toThrow('profile_upgrade_owner_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt.each(['0.2.0', '0.2.27'])('supports the declared %s source on an Account Profile and verifies its committed selection', async (source) => {
  const f = await fixture('none', source, 'account'), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  await expect(new BotProfileUpgrades(f.options).assertCompatible(f.id)).resolves.toBeUndefined()
  await expect(new BotProfileUpgrades(f.options).recover(f.id)).resolves.toBeUndefined()
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt.each(['after-selection', 'store-loss'] as const)('restores the original package and data without activation after %s', async (failure) => {
  const f = await fixture(failure), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(await f.target.activeGeneration()).toBe(1)
  expect(f.home()).toBe('bot')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 1 })
})

posixIt('resumes an interrupted pre-activation restoration on the same operation without reinstalling the target', async () => {
  const f = await fixture('rollback-interrupted'), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.journal.read(f.id, op).phase).toBe('restoring')
  await new BotProfileUpgrades(f.options).recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(f.home()).toBe('bot')
  expect(await f.target.activeGeneration()).toBe(1)
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 2 })
})

posixIt('retains original data when preparing finds a writer lock and never invokes package installation', async () => {
  const f = await fixture('preparation'), op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt('stops when original authority is revoked during installation and recovers only after a fresh same-owner unlock', async () => {
  const f = await fixture('revoked'), starting = f.start()
  await f.installedBarrier
  f.revoke(); f.releaseInstall()
  const op = await starting
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.journal.read(f.id, op).phase).toBe('prepared')
  await new BotProfileUpgrades(f.options).recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.home()).toBe('bot')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 1 })
})

posixIt('refuses a package-only downgrade while retaining the selected upgraded data', async () => {
  const f = await fixture(), op = await f.start()
  await writeFile(join(f.web, 'package.json'), f.originalManifest)
  await expect(new BotProfileUpgrades(f.options).assertCompatible(f.id)).rejects.toThrow('profile_upgrade_selection_changed')
  expect(f.home()).toBe(`bot-upgrades/${op}`)
  expect(await f.target.activeGeneration()).toBe(2)
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt('permits explicit removal to leave managed data retained while other plugins can start', async () => {
  const f = await fixture(), op = await f.start()
  await writeFile(join(f.web, 'package.json'), '{"dependencies":{}}')
  await expect(new BotProfileUpgrades(f.options).assertCompatible(f.id)).resolves.toBeUndefined()
  expect(f.home()).toBe(`bot-upgrades/${op}`)
  await expect(readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).resolves.toContain('历史消息')
})

posixIt('refuses alternate update sources and reinstallation over retained Bot data before mutation', async () => {
  const f = await fixture()
  for (const spec of ['ds-bot@9.0.0', 'github:custom/bot#' + '1'.repeat(40), 'bundled:ds-bot@9.0.0']) {
    expect(() =>{  f.upgrades.validate(f.id, 'update', spec) }).toThrow('profile_upgrade_policy_unavailable')
  }
  expect(() =>{  f.upgrades.validate(f.id, 'install', 'bundled:ds-bot@0.3.8-slark.1') }).toThrow('profile_upgrade_existing_data_requires_recovery')
  expect(() =>{  f.upgrades.validate(f.id, 'remove') }).not.toThrow()
  expect(() =>{  f.upgrades.validate(f.id, 'toggle') }).not.toThrow()
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt.each([false, true])('preserves the first upgraded generation through a second declared upgrade (restore=%s)', async (restore) => {
  const f = await fixture(), first = await f.start(), firstHome = join(f.profileRoot, f.home())
  const state = JSON.parse(await readFile(join(firstHome, 'state.json'), 'utf8')) as { rooms: { r: { log: object[] } } }
  state.rooms.r.log.push({ seq: 2, text: 'first upgrade new message' })
  const retained = JSON.stringify(state)
  await writeFile(join(firstHome, 'state.json'), retained)
  const future = await f.nextTarget(restore), second = await f.start()
  expect(f.receipts.read(first)?.state).toBe('succeeded')
  expect(f.receipts.read(second)?.state).toBe(restore ? 'failed' : 'succeeded')
  expect(await f.target.activeGeneration()).toBe(restore ? 2 : 3)
  expect(f.home()).toBe(`bot-upgrades/${restore ? first : second}`)
  expect(await readFile(join(firstHome, 'state.json'), 'utf8')).toBe(retained)
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('first upgrade new message')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  await expect(new BotProfileUpgrades(future.options).assertCompatible(f.id)).resolves.toBeUndefined()
  expect(f.calls()).toEqual({ installCalls: 2, rollbackCalls: restore ? 1 : 0 })
})

posixIt('reports an unsupported source before mutation as failed so it can be corrected without an unrecoverable unknown operation', async () => {
  const f = await fixture(), stray = join(dirname(f.target.generationRoot(1)), 'unowned-generation')
  await mkdir(stray, { mode: 0o700 })
  const refused = await f.start()
  expect(f.receipts.read(refused)?.state).toBe('failed')
  expect(f.journal.entries(f.id)).toEqual([])
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
  await rm(stray, { recursive: true })
  const corrected = await f.start()
  expect(f.receipts.read(corrected)?.state).toBe('succeeded')
})

posixIt('prevents legacy package-completion receipts from bypassing data migration or reinstalling over retained Bot data', async () => {
  const f = await fixture(), op = await f.start(), receipt = f.receipts.read(op)!
  const evidence = receipt.pluginPackage!, { data: _data, ...upgrade } = evidence.upgrade!
  const legacyUpdate = { ...receipt, pluginPackage: { ...evidence, upgrade } }
  await expect(f.executor.validatePluginCompletion(f.id, legacyUpdate)).rejects.toThrow('profile_upgrade_recovery_required')
  const { upgrade: _upgrade, ...packageOnly } = evidence
  const legacyInstall = { ...receipt, pluginPackage: { ...packageOnly, action: 'install' as const } }
  await expect(f.executor.validatePluginCompletion(f.id, legacyInstall)).rejects.toThrow('profile_upgrade_existing_data_requires_recovery')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt.each(['failed', 'succeeded'] as const)('refuses an activating journal that contradicts a terminal %s receipt', async (state) => {
  const f = await fixture('after-activation'), op = await f.start(), original = f.receipts.read(op)!
  f.receipts.write({ ...original, state })
  await expect(new BotProfileUpgrades(f.options).recover(f.id)).rejects.toThrow('profile_upgrade_receipt_changed')
  expect(f.receipts.read(op)?.state).toBe(state)
  expect(f.journal.read(f.id, op).phase).toBe('activating')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
})

posixIt('refuses unknown sources and custom Home settings without calling the package manager', async () => {
  const f = await fixture(), spec = 'bundled:ds-bot@0.3.8-slark.1'
  expect(f.upgrades.handles('other')).toBe(false)
  expect(f.upgrades.pending(f.id)).toBe(false)
  const { policies: _policies, catalog: _catalog, ...withoutPolicy } = f.options
  expect(() =>{  new BotProfileUpgrades(withoutPolicy).validate(f.id, 'update', spec) }).toThrow('profile_upgrade_policy_unavailable')
  for (const home of [undefined, '../outside']) {
    expect(() =>{  new BotProfileUpgrades({ ...f.options, home: () => home }).validate(f.id, 'update', spec) })
      .toThrow('profile_upgrade_custom_home')
  }
  for (const manifest of [null, [], { dependencies: [] }, { dependencies: { 'ds-bot': 42 } }]) {
    await writeFile(join(f.web, 'package.json'), JSON.stringify(manifest))
    expect(() =>{  f.upgrades.validate(f.id, 'update', spec) }).toThrow('invalid_profile_manifest')
  }
  for (const manifest of [{}, { dependencies: { 'ds-bot': 'ds-bot@0.2.0' } }]) {
    await writeFile(join(f.web, 'package.json'), JSON.stringify(manifest))
    expect(() =>{  f.upgrades.validate(f.id, 'update', spec) }).toThrow('profile_upgrade_source_unsupported')
  }
  await writeFile(join(f.web, 'package.json'), f.originalManifest)
  expect(() =>{  f.upgrades.validate(f.id, 'update') }).toThrow('profile_upgrade_policy_unavailable')
  await rm(f.originalHome, { recursive: true })
  expect(() =>{  f.upgrades.validate(f.id, 'install', spec) }).not.toThrow()
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})

posixIt('refuses changed original receipt identity without discarding newer data', async () => {
  const f = await fixture('after-activation'), op = await f.start(), original = f.receipts.read(op)!
  const { pluginPackage: _package, ...withoutPackage } = original
  for (const replacement of [
    { ...original, profileId: randomUUID() }, { ...original, digest: 'b'.repeat(64) }, { ...withoutPackage, restores: randomUUID() },
  ]) {
    f.receipts.write(replacement)
    await expect(new BotProfileUpgrades(f.options).recover(f.id)).rejects.toThrow('profile_upgrade_receipt_changed')
    expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
  }
  f.receipts.write(original)
  expect(f.upgrades.pending(f.id)).toBe(true)
  expect(() =>{  f.upgrades.validate(f.id, 'update', 'bundled:ds-bot@0.3.8-slark.1') }).toThrow('profile_upgrade_pending')
  await new BotProfileUpgrades(f.options).recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses conflicting immutable package intent between the journal and original receipt', async () => {
  const f = await fixture('after-activation'), op = await f.start(), receipt = f.receipts.read(op)!
  f.receipts.write({ ...receipt, pluginPackage: { ...receipt.pluginPackage!, scopeDigest: 'b'.repeat(64) } })
  await expect(new BotProfileUpgrades(f.options).recover(f.id)).rejects.toThrow('profile_upgrade_receipt_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.journal.read(f.id, op).phase).toBe('activating')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
})

posixIt('restores a prepared original operation whose package checkpoint did not reach its receipt', async () => {
  const f = await fixture('revoked'), starting = f.start()
  await f.installedBarrier; f.revoke(); f.releaseInstall()
  const op = await starting, original = f.receipts.read(op)!, { pluginPackage: _package, ...withoutCheckpoint } = original
  expect(f.journal.read(f.id, op).phase).toBe('prepared')
  f.receipts.write(withoutCheckpoint)
  await new BotProfileUpgrades(f.options).recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.receipts.read(op)?.pluginPackage?.stage).toBe('restoration_verified')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(await f.target.activeGeneration()).toBe(1)
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})


posixIt('rejects malformed package patches and out-of-order participant calls before any publication', async () => {
  const f = await fixture()
  await expect(f.run(async (participant) => {
    for (const patch of ['[broken', 'name: wrong-shape', '- value: ' + 'x'.repeat(1_048_576)]) {
      expect(() => participant.rewritePatch(patch)).toThrow('invalid_patch')
    }
    expect(parse(participant.rewritePatch(''))).toMatchObject([{ id: 'bot' }])
    await expect(participant.selectData()).rejects.toThrow('profile_upgrade_phase')
    await expect(participant.restart()).rejects.toThrow('profile_upgrade_phase')
    throw Error('stop before installation')
  })).resolves.toEqual({ state: 'failed' })
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
  expect(await f.target.activeGeneration()).toBe(1)
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt('requires an original operation identity and refuses a source that becomes unavailable during preflight', async () => {
  const f = await fixture()
  await expect(f.upgrades.run(f.id, 'bundled:ds-bot@0.3.8-slark.1', {
    kind: 'plugin', signal: new AbortController().signal, guard() {},
  }, async () => ({ state: 'succeeded' }))).rejects.toThrow('profile_upgrade_receipt_required')
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(f.target, 'inspectExistingPersistence').mockRejectedValueOnce(Error('storage unavailable'))
  const refused = await f.start()
  expect(f.receipts.read(refused)?.state).toBe('failed')
  expect(f.journal.entries(f.id)).toEqual([])
  expect(f.calls().installCalls).toBe(0)
})

posixIt.each(['preparing', 'restoring'] as const)('recovers a %s journal before any package checkpoint without replaying preparation', async (phase) => {
  const f = await fixture('preparation')
  onTestFinished(() => { vi.restoreAllMocks() })
  const advance = f.journal.advance.bind(f.journal)
  vi.spyOn(f.journal, 'advance').mockImplementation((entry, next, ...args) => {
    if (next === (phase === 'preparing' ? 'restoring' : 'restored')) throw Error('journal response interrupted')
    return advance(entry, next, ...args)
  })
  const op = await f.start()
  vi.restoreAllMocks()
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.journal.read(f.id, op).phase).toBe(phase)
  await f.upgrades.recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})

posixIt.each(['preparation', 'install'] as const)('settles a restored %s operation after its terminal receipt response was lost', async (failure) => {
  const f = await fixture(failure), op = await f.start(), original = f.receipts.read(op)!
  f.receipts.write({ ...original, state: 'unknown' })
  await f.upgrades.recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(await f.target.activeGeneration()).toBe(1)
})

posixIt('recovers a committed journal with a lost receipt and permanently refuses predecessor restoration', async () => {
  const f = await fixture(), op = await f.start(), original = f.receipts.read(op)!
  f.receipts.write({ ...original, state: 'unknown' })
  const recovering = new BotProfileUpgrades({ ...f.options, recoverPackage: async (...args) => {
    await expect(args[3].restoreData()).rejects.toThrow('profile_upgrade_rollback_blocked')
    return f.options.recoverPackage(...args)
  } })
  await recovering.recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt.each(['root', 'generation'] as const)('refuses target activation after the selected %s changes', async (changed) => {
  const f = await fixture('after-activation'), op = await f.start()
  if (changed === 'root') await writeFile(join(f.profileRoot, 'cordis.patch.yml'), '[]\n')
  else await f.target.commitGeneration(2, 1)
  const recovering = new BotProfileUpgrades({ ...f.options, recoverPackage: async (...args) => {
    await args[3].restart()
    throw Error('a changed selection must not activate')
  } })
  await expect(recovering.recover(f.id)).rejects.toThrow('profile_upgrade_selection_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses a private Profile root that becomes publicly readable during recovery', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  const { chmod } = await import('node:fs/promises')
  await chmod(f.profileRoot, 0o755)
  onTestFinished(() => chmod(f.profileRoot, 0o700))
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('unsafe_profile_upgrade_state')
  expect(f.receipts.read(op)?.state).toBe('unknown')
})

posixIt('refuses a changed source during interrupted preparation instead of restoring over it', async () => {
  const f = await fixture('preparation')
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(f.journal, 'advance').mockImplementationOnce(() => { throw Error('interrupted before restoring') })
  const op = await f.start()
  vi.restoreAllMocks()
  await writeFile(join(f.web, 'package.json'), '{"dependencies":{}}')
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('profile_upgrade_source_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})

posixIt('does not restart an old worker after preparation loses its original authority', async () => {
  const f = await fixture()
  let authorized = true
  const guard = () => { if (!authorized) throw Error('original authority revoked') }
  await expect(f.run(async () => {
    authorized = false
    throw Error('preparation interrupted')
  }, guard)).resolves.toEqual({ state: 'failed' })
  await expect(f.workers.activate(f.id)).rejects.toMatchObject({ code: 'unavailable' })
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})

posixIt('refuses generation overflow before publishing any journal or package', async () => {
  const f = await fixture()
  await mkdir(join(dirname(f.target.generationRoot(1)), String(Number.MAX_SAFE_INTEGER)), { mode: 0o700 })
  const op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.entries(f.id)).toEqual([])
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})


posixIt('refuses an activating operation when its original package checkpoint is absent', async () => {
  const f = await fixture('after-activation'), op = await f.start(), original = f.receipts.read(op)!
  const { pluginPackage: _package, ...withoutCheckpoint } = original
  f.receipts.write(withoutCheckpoint)
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('profile_upgrade_receipt_changed')
  expect(f.journal.read(f.id, op).phase).toBe('activating')
})

posixIt('refuses missing or inconsistent data evidence supplied during original-operation recovery', async () => {
  const f = await fixture('after-activation'), op = await f.start(), entry = f.journal.read(f.id, op)
  onTestFinished(() => { vi.restoreAllMocks() })
  const { dataDigest: _dataDigest, ...withoutData } = entry
  vi.spyOn(f.journal, 'pending').mockReturnValueOnce(withoutData)
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('invalid_profile_upgrade_backup')
  const readBlob = f.journal.readBlob.bind(f.journal)
  vi.spyOn(f.journal, 'readBlob').mockImplementation((row, name, expected) => {
    const bytes = readBlob(row, name, expected)
    if (name !== 'data') return bytes
    const data = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    return Buffer.from(JSON.stringify({ ...data, botSnapshotDigest: 'b'.repeat(64) }))
  })
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('invalid_profile_upgrade_backup')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses a preparation response without durable data identity before invoking any package operation', async () => {
  const f = await fixture()
  onTestFinished(() => { vi.restoreAllMocks() })
  const advance = f.journal.advance.bind(f.journal)
  vi.spyOn(f.journal, 'advance').mockImplementation((row, phase, ...args) => {
    const next = advance(row, phase, ...args)
    const { dataDigest: _dataDigest, ...withoutData } = next
    return phase === 'backed_up' ? withoutData : next
  })
  const op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})

posixIt('rejects conflicting unsettled journal responses instead of choosing one to resume', async () => {
  const f = await fixture('after-activation'), op = await f.start(), entry = f.journal.read(f.id, op)
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(f.journal, 'pending').mockReturnValue(entry)
  vi.spyOn(f.journal, 'entries').mockReturnValue([entry, { ...entry, operationId: randomUUID() }])
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('profile_upgrade_conflicting_journals')
  expect(f.receipts.read(op)?.state).toBe('unknown')
})

posixIt('preserves a custom root and refuses the source before journaling any changes', async () => {
  const f = await fixture()
  await writeFile(join(f.profileRoot, 'cordis.patch.yml'), '[]\n')
  const op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.entries(f.id)).toEqual([])
  expect(await readFile(join(f.profileRoot, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
})

posixIt('rejects a source archive whose resolved version is outside the declared policy', async () => {
  const f = await fixture()
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(f.options.policies, 'allows').mockReturnValueOnce(false)
  const op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.entries(f.id)).toEqual([])
})

posixIt('rechecks source dependency, receipt and effective Home after asynchronous preflight', async () => {
  for (const field of ['dependency', 'receipt', 'home'] as const) {
    const f = await fixture()
    onTestFinished(() => { vi.restoreAllMocks() })
    if (field === 'receipt') {
      const read = f.receipts.read.bind(f.receipts)
      vi.spyOn(f.receipts, 'read').mockImplementation((id) => {
        const result = read(id)
        return result?.state === 'running' ? { ...result, kind: 'mcp' } : result
      })
    } else if (field === 'home') {
      let calls = 0
      vi.spyOn(f.options, 'home').mockImplementation(() => ++calls > 2 ? undefined : 'bot')
    } else {
      // Dependency reads are repeated after both validation boundaries, before archive I/O.
      const dependencyFile = join(f.web, 'package.json')
      const { readExtensionStateFile } = await import('../src/posix-extension-files.ts')
      const files = await import('../src/posix-extension-files.ts')
      let calls = 0
      vi.spyOn(files, 'readExtensionStateFile').mockImplementation((path, ...args) =>
        path === dependencyFile && ++calls === 3 ? '{"dependencies":{}}' : readExtensionStateFile(path, ...args))
    }
    const result = await f.run(async () => { throw Error('preflight must refuse before the package executor') })
    vi.restoreAllMocks()
    expect(result).toEqual({ state: 'failed' })
    expect(f.journal.entries(f.id)).toEqual([])
    expect(f.calls().installCalls).toBe(0)
  }
})

posixIt('refuses stale committed predecessors on a later declared upgrade', async () => {
  const f = await fixture(), first = await f.start(), previous = f.journal.read(f.id, first)
  await f.nextTarget()
  onTestFinished(() => { vi.restoreAllMocks() })
  const read = f.journal.read.bind(f.journal)
  vi.spyOn(f.journal, 'read').mockImplementation((profileId, operationId) => {
    const row = read(profileId, operationId)
    return operationId === first ? { ...row, targetGeneration: previous.targetGeneration + 1 } : row
  })
  const second = await f.start()
  expect(f.receipts.read(second)?.state).toBe('failed')
  expect(await f.target.activeGeneration()).toBe(2)
  expect(f.calls().installCalls).toBe(1)
})

posixIt('refuses conflicts or changed code evidence during later startup while allowing independent generations', async () => {
  const f = await fixture(), op = await f.start(), entry = f.journal.read(f.id, op)
  onTestFinished(() => { vi.restoreAllMocks() })
  vi.spyOn(f.journal, 'entries').mockReturnValueOnce([entry, { ...entry, operationId: randomUUID() }])
  await expect(f.upgrades.assertCompatible(f.id)).rejects.toThrow('profile_upgrade_conflicting_journals')
  await f.target.commitGeneration(2, 1)
  await expect(f.upgrades.assertCompatible(f.id)).rejects.toThrow('profile_upgrade_selection_changed')
  await expect(new BotProfileUpgrades({ ...f.options, home: () => undefined }).assertCompatible(f.id)).resolves.toBeUndefined()
  await expect(new BotProfileUpgrades({ ...f.options, home: () => 'bot' }).assertCompatible(f.id)).resolves.toBeUndefined()
  await f.target.commitGeneration(1, 2)
  vi.spyOn(f.journal, 'entries').mockReturnValueOnce([{ ...entry, targetSpec: 'bundled:ds-bot@0.3.9-fixture' }])
  await expect(f.upgrades.assertCompatible(f.id)).rejects.toThrow('profile_upgrade_selection_changed')
})

posixIt('refuses a custom root change detected during pre-activation restoration', async () => {
  const f = await fixture('revoked'), pending = f.start()
  await f.installedBarrier; f.revoke(); f.releaseInstall()
  const op = await pending
  await writeFile(join(f.profileRoot, 'cordis.patch.yml'), '[]\n')
  const recovering = new BotProfileUpgrades({ ...f.options, recoverPackage: async (...args) => {
    await args[3].restoreData()
    throw Error('a custom root must be retained')
  } })
  await expect(recovering.recover(f.id)).rejects.toThrow('profile_upgrade_root_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
})


posixIt('refuses reinstalling over a committed generation even when its original Home is absent', async () => {
  const f = await fixture(), op = await f.start()
  await rm(f.originalHome, { recursive: true })
  expect(() =>{  f.upgrades.validate(f.id, 'install', 'bundled:ds-bot@0.3.8-slark.1') })
    .toThrow('profile_upgrade_existing_data_requires_recovery')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('历史消息')
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  await rm(join(f.web, 'package.json'))
  expect(() =>{  f.upgrades.validate(f.id, 'update', 'bundled:ds-bot@0.3.8-slark.1') }).toThrow('invalid_profile_manifest')
})

posixIt('finishes an already selected pre-package restoration without advancing its phase twice', async () => {
  const f = await fixture()
  await expect(f.run(async () => {
    const current = f.journal.pending(f.id)!
    f.journal.advance(current, 'restoring')
    throw Error('pre-package restoration response lost')
  })).resolves.toEqual({ state: 'failed' })
  expect(f.journal.entries(f.id)[0]?.phase).toBe('restored')
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})


posixIt.each(['none', 'install'] as const)('refuses contradictory terminal receipts even without a pending journal (%s)', async (failure) => {
  const f = await fixture(failure), op = await f.start(), original = f.receipts.read(op)!
  expect(f.journal.pending(f.id)).toBeUndefined()
  f.receipts.write({ ...original, state: failure === 'none' ? 'failed' : 'succeeded' })
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('profile_upgrade_receipt_changed')
  expect(f.calls().installCalls).toBe(1)
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})


posixIt('routes installs, toggles and read-only changed-source refusals through the data owner', async () => {
  const f = await fixture(), spec = 'bundled:ds-bot@0.3.8-slark.1'
  f.executor.validate(f.id, 'plugin', JSON.stringify({ action: 'toggle', packageName: 'ds-bot', enabled: false }))
  await rm(f.originalHome, { recursive: true })
  expect(() =>{  f.executor.validate(f.id, 'plugin', JSON.stringify({ packageName: 'ds-bot', spec })) })
    .toThrow('plugin_already_installed')
  await writeFile(join(f.web, 'package.json'), '{"dependencies":{}}')
  const result = await f.executor.execute(f.id, JSON.stringify({ action: 'update', packageName: 'ds-bot', spec }), {
    kind: 'plugin', operationId: randomUUID(), signal: new AbortController().signal, guard() {},
  })
  expect(result).toEqual({ state: 'failed' })
  expect(f.journal.entries(f.id)).toEqual([])
  expect(f.calls().installCalls).toBe(0)
})

posixIt('refuses data-bearing receipts through the generic completion route', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  await expect(f.executor.validatePluginCompletion(f.id, f.receipts.read(op)!))
    .rejects.toThrow('profile_upgrade_recovery_required')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('requires matching package and participant data intent on every recovery', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  const recovering = new BotProfileUpgrades({ ...f.options, recoverPackage: async (...args) => {
    const [id, evidence, context, participant] = args
    const { data: _data, ...packageOnly } = evidence.upgrade!
    for (const candidate of [evidence, { ...evidence, upgrade: packageOnly }]) {
      await expect(f.executor.recoverDataUpgrade(id, candidate, { ...context, operationId: randomUUID() }, participant))
        .rejects.toThrow('invalid_recovery')
    }
    await expect(f.executor.recoverDataUpgrade(id, evidence, context, {
      ...participant, recovery: { ...participant.recovery, digest: 'b'.repeat(64) },
    })).rejects.toThrow('invalid_recovery')
    await expect(f.executor.recoverDataUpgrade(id, evidence, context, {
      ...participant, rollbackAllowed: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    })).rejects.toThrow('invalid_recovery')
    return f.options.recoverPackage(...args)
  } })
  await recovering.recover(f.id)
  expect(f.receipts.read(op)?.state).toBe('succeeded')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses forward recovery if its target verifier is unavailable', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  delete f.executorOptions.verifyUpgradeTarget
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('plugin_state_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(f.calls()).toEqual({ installCalls: 1, rollbackCalls: 0 })
})

posixIt('refuses a package revision changed after the fresh recovery acknowledgment', async () => {
  const f = await fixture('after-activation'), op = await f.start()
  const acknowledge = f.executorOptions.acknowledge.bind(f.executorOptions)
  f.executorOptions.acknowledge = async (...args) => {
    await acknowledge(...args)
    await writeFile(join(f.web, 'pnpm-lock.yaml'), '# changed after ACK\n', { mode: 0o600 })
  }
  await expect(f.upgrades.recover(f.id)).rejects.toThrow('plugin_state_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(await readFile(join(f.profileRoot, f.home(), 'state.json'), 'utf8')).toContain('升级后新消息')
})

posixIt.each(['dependency', 'tree'] as const)('refuses incomplete %s proof during interrupted predecessor restoration', async (changed) => {
  const f = await fixture('rollback-interrupted'), op = await f.start(), rollback = f.executorOptions.rollbackUpgrade!
  f.executorOptions.rollbackUpgrade = async (...args) => {
    const digest = await rollback(...args)
    if (changed === 'dependency') await writeFile(join(f.web, 'package.json'), f.targetManifest)
    return changed === 'tree' ? 'b'.repeat(64) : digest
  }
  await expect(f.upgrades.recover(f.id)).rejects.toThrow(changed === 'dependency' ? 'plugin_version_mismatch' : 'plugin_state_changed')
  expect(f.receipts.read(op)?.state).toBe('unknown')
  expect(await readFile(join(f.originalHome, 'state.json'), 'utf8')).toBe(f.original)
})


posixIt('retains ordinary validation errors for packages outside the governed Bot identity', async () => {
  const f = await fixture()
  await expect(f.executor.execute(f.id, JSON.stringify({ action: 'update', packageName: 'other', spec: 'other@1.0.0' }), {
    kind: 'plugin', signal: new AbortController().signal, guard() {},
  })).rejects.toThrow('plugin_not_managed_dependency')
  expect(f.calls().installCalls).toBe(0)
})

posixIt('refuses a package capability lost between data preparation and package publication', async () => {
  const f = await fixture(), owner = f.executorOptions.dataUpgrade!
  owner.run = (id, spec, context, operation) => f.upgrades.run(id, spec, context, (participant) => {
    delete f.executorOptions.upgradePlan
    return operation(participant)
  })
  const op = await f.start()
  expect(f.receipts.read(op)?.state).toBe('failed')
  expect(f.journal.read(f.id, op).phase).toBe('restored')
  expect(f.calls()).toEqual({ installCalls: 0, rollbackCalls: 0 })
})
