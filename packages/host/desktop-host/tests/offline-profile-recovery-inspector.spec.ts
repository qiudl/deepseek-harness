import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { create as createArchive, Header } from 'tar'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { readBundledPluginPatch, verifyCopiedBundledPlugin, verifyProfileRollbackArchive } from '../src/bundled-plugin-recovery.ts'
import { prepareBundledPluginUpgrade } from '../src/plugin-upgrade-plan.ts'
import { pluginBundleEntries } from '../src/plugin-bundle-entries.ts'
import { parseDocument } from 'yaml'
import { initProfile, loadProfileDirectory, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot/src/profile.ts'
import { fileURLToPath } from 'node:url'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { acquireSingleHostLock, type SingleHostLock } from '../src/single-instance.ts'
import { RestrictedProfileFence } from '../src/restricted-profile-fence.ts'
import { withRestrictedProfileReader } from '../src/restricted-profile-reader.ts'
import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import { RestrictedAccountSessionService } from '../src/restricted-account-session.ts'
import { ProfileExtensionOperations, type ExtensionReceipt } from '../src/extension-operations.ts'
import { LegacyClaimWorkerGate } from '../src/legacy-claim-worker-gate.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { HostControlRequestId, HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'

const readFaults = vi.hoisted(() => new Map<string, 'short' | 'changed' | 'manyEntries'>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args)
    const fault = readFaults.get(String(args[0]))
    if (fault === 'short') vi.spyOn(handle, 'read').mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) })
    if (fault === 'changed') {
      const original = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(() => original()).mockImplementationOnce(async () => {
        const stat = await original()
        stat.mtimeMs += 1
        return stat
      })
    }
    return handle
  }
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    const entries = await actual.readdir(...args)
    if (readFaults.get(String(args[0])) === 'manyEntries') {
      const file = entries.find(entry => entry.isFile())!
      return Array.from({ length: 8193 }, () => file)
    }
    return entries
  }
  return { ...actual, open, readdir }
})
import {
  FileOwnerJsonlMigrationGenerationTarget,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { SessionWriteLease } from '@deepseek-ai/dsh-session-persistence-jsonl/src/lease.ts'
import { ExistingSessionLock } from '@deepseek-ai/dsh-session-persistence-jsonl/src/existing-session-lock.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import {
  existingProfilePatch,
  OfflineProfileRecoveryInspector,
  packagedRuntimeAppRoot,
} from '../src/offline-profile-recovery.ts'
import type { PersonProfileRecord, ProfileWorkerFactory } from '../src/types.ts'
import { HostAuthorityError, ProfileWorkerExitUnconfirmedError } from '../src/types.ts'
import { BundledPluginCatalog, bundledDependencySpec } from '../src/bundled-plugins.ts'

const uid = process.getuid?.() ?? 0
function testFence(root: string, ownership: SingleHostLock) {
  return { fence: new RestrictedProfileFence(root, uid, ownership), assertAllWritersQuiescent: () => {},
    withAllWritersExcluded: async <T>(operationOrProfile: (() => Promise<T>) | string, operation?: () => Promise<T>) =>
      (typeof operationOrProfile === 'function' ? operationOrProfile : operation!)() }
}
async function isolatedTestNode(root: string): Promise<string> {
  if (process.env.DSH_TEST_DENY_FORK !== '1') return process.execPath
  if (process.platform !== 'darwin' || /["$`\\]/u.test(process.execPath)) throw new Error('unsupported sandbox fixture')
  const wrapper = join(root, 'sandbox-node')
  const probe = join(root, 'fork-probe.cjs')
  const forbidden = join(root, 'forbidden-sandbox-write')
  const original = join(root, 'sandbox-original')
  await writeFile(original, 'unchanged', { mode: 0o600 })
  if (/["$`\\]/u.test(probe)) throw new Error('unsupported sandbox fixture path')
  await writeFile(probe, `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');let fork,write,link,hardlink;try { fork=cp.spawnSync('/usr/bin/true').error?.code ?? 'allowed' } catch(e) { fork=e.code } try { fs.writeFileSync(${JSON.stringify(forbidden)},'bad');write='allowed' } catch(e) { write=e.code } try { const p=path.join(process.env.DSH_HOME,'probe-link');fs.symlinkSync(${JSON.stringify(original)},p);fs.writeFileSync(p,'bad');link='allowed' } catch(e) { link=e.code } try { fs.linkSync(${JSON.stringify(original)},path.join(process.env.DSH_HOME,'probe-hardlink'));hardlink='allowed' } catch(e) { hardlink=e.code } fs.writeFileSync(path.join(process.env.DSH_HOME,'sandbox-probe-result'),JSON.stringify({fork,write,link,hardlink}));`, { mode: 0o600 })
  await appendFile(probe, `\nconst socket=require('node:net').connect(9,'198.51.100.1');
    socket.once('error',e=>fs.writeFileSync(path.join(process.env.DSH_HOME,'sandbox-network-result'),e.code));
    socket.once('connect',()=>{fs.writeFileSync(path.join(process.env.DSH_HOME,'sandbox-network-result'),'allowed');socket.destroy()});
    const udp=require('node:dgram').createSocket('udp4');
    udp.send(Buffer.from('x'),9,'198.51.100.1',e=>{fs.writeFileSync(path.join(process.env.DSH_HOME,'sandbox-udp-result'),e?.code ?? 'allowed');udp.close()});`)
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" --require "${probe}" "$@"\n`, { mode: 0o700 })
  return wrapper
}
function extensionBarrier() {
  const records = new Map<string, ExtensionReceipt>()
  return new ProfileExtensionOperations({
    read: id => records.get(id),
    write: receipt => { records.set(receipt.operationId, receipt) },
    list: id => [...records.values()].filter(receipt => receipt.profileId === id),
  }, { revision: async () => 'fixture', execute: async () => ({ state: 'succeeded' }) }, { now: () => 1_000 })
}
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150'
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3151'
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

function profile(): PersonProfileRecord {
  return {
    profileId: profileId as PersonProfileRecord['profileId'], kind: 'account',
    personIndex: 'person-index', keyHandle: 'keychain:fixture', unlockVerifier: 'verifier',
    accountBindings: [], bindingGeneration: 3, createdAt: 1,
  }
}

async function fixture(externalRuntime = false) {
  // Keep the root short enough for macOS's 104-byte Unix-domain socket limit.
  const hostRoot = await realpath(await mkdtemp(join(tmpdir(), 'd-')))
  onTestFinished(async () => { await rm(hostRoot, { recursive: true, force: true }) })
  const profileRoot = join(hostRoot, 'profiles', profileId)
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
  const persistence = await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  const ownerStateApplicator = new MigrationOwnerStateApplicator(uid)
  const ownerPaths = await ownerStateApplicator.apply(profileRoot, 1, ownerState)
  await writeFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot, persistence, ownerPaths), { mode: 0o600 })
  const web = join(profileRoot, 'profiles', 'web')
  await mkdir(join(web, 'node_modules'), { recursive: true, mode: 0o700 })
  await writeFile(join(web, 'package.json'), `${JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } })}\n`)
  await writeFile(join(web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const currentRuntime = join(hostRoot, 'current', 'dsh-runtime', 'app')
  const legacyRuntime = join(hostRoot, 'legacy', 'dsh-runtime', 'app')
  const dependency = join(externalRuntime ? legacyRuntime : currentRuntime, 'node_modules', 'fixture-plugin')
  await mkdir(dependency, { recursive: true, mode: 0o700 })
  await symlink(dependency, join(web, 'node_modules', 'fixture-plugin'))
  const inspector = new OfflineProfileRecoveryInspector({
    hostRoot, installationId, expectedUid: uid, currentRuntimeAppRoot: currentRuntime,
    targetFor: () => target, ownerStateApplicator,
  })
  return { hostRoot, profileRoot, inspector, target, ownerStateApplicator, currentRuntime, legacyRuntime, web, persistence, ownerPaths }
}

async function releasedPatch(value: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  // Captured from the signed 0.1.6-alpha.2 baseline; only absolute paths are substituted.
  let text = await readFile(new URL('./fixtures/released-owner-settings.patch.yml', import.meta.url), 'utf8')
  const paths = {
    profileRoot: value.profileRoot, persistenceRoot: value.persistence.root,
    storageRoot: value.ownerPaths.storageRoot, settingsPath: value.ownerPaths.settingsPath,
    credentialsPath: value.ownerPaths.credentialsPath,
  }
  for (const [name, path] of Object.entries(paths)) text = text.replaceAll(`"{{${name}}}"`, JSON.stringify(path))
  return text
}

const bundledFiles = {
  'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', bundledDependencies: ['nested'] }),
  'index.js': 'export const fixture = true\n',
  'empty.js': '',
  'node_modules/nested/package.json': JSON.stringify({ name: 'nested', version: '1.0.0' }),
  'node_modules/nested/index.js': 'export const nested = true\n',
}

async function bundledFixture(archiveBytes?: Buffer, files: Record<string, string> = bundledFiles, withNewerVersion = false) {
  const value = await fixture()
  const installed = join(value.web, 'node_modules', 'fixture-plugin')
  await unlink(installed)
  const source = join(value.hostRoot, 'archive-source')
  for (const [path, content] of Object.entries(files)) {
    for (const root of [join(source, 'package'), installed]) {
      await mkdir(join(root, path, '..'), { recursive: true, mode: 0o700 })
      await writeFile(join(root, path), content, { mode: 0o600 })
    }
  }
  const embedding = join(value.hostRoot, 'bundled')
  await mkdir(embedding, { mode: 0o700 })
  const archive = join(embedding, 'fixture.tgz')
  if (archiveBytes) await writeFile(archive, archiveBytes)
  else await createArchive({ gzip: true, cwd: source, file: archive }, ['package'])
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  const historical = {
    name: 'fixture-plugin', version: '1.0.0', file: 'fixture.tgz', sha256: digest,
    repository: 'https://example.com/fixture', sourceSha: 'a'.repeat(40), entryIds: [],
  }
  let newer: typeof historical | undefined
  if (withNewerVersion) {
    await writeFile(join(source, 'package', 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '2.0.0' }))
    const currentArchive = join(embedding, 'fixture-2.tgz')
    await createArchive({ gzip: true, cwd: source, file: currentArchive }, ['package'])
    newer = { ...historical, version: '2.0.0', file: 'fixture-2.tgz',
      sha256: createHash('sha256').update(await readFile(currentArchive)).digest('hex') }
  }
  await writeFile(join(embedding, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1,
    plugins: newer ? [newer, historical] : [historical] }))
  await mkdir(join(value.web, '.bundled-plugins'), { mode: 0o700 })
  await writeFile(join(value.web, '.bundled-plugins', `${digest}.tgz`), await readFile(archive), { mode: 0o600 })
  await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': bundledDependencySpec(digest) } }))
  const options = {
    hostRoot: value.hostRoot, installationId, expectedUid: uid, currentRuntimeAppRoot: value.currentRuntime,
    targetFor: () => value.target, ownerStateApplicator: value.ownerStateApplicator,
    bundledCatalog: BundledPluginCatalog.load(embedding, uid),
  }
  return { ...value, installed, archive, digest, inspector: new OfflineProfileRecoveryInspector(options), files,
    catalog: options.bundledCatalog }
}

async function accountService(value: Awaited<ReturnType<typeof bundledFixture>>, createWorker: ProfileWorkerFactory,
  inspectPersistence = () => value.target.inspectRestrictedPersistence()) {
  const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
    processNonce: 'restricted-account-service-fixture' })
  const workers = new ProfileWorkerSupervisor(async () => { throw new Error('unexpected regular worker') })
  const extensions = extensionBarrier()
  onTestFinished(async () => { await extensions.dispose(); await workers.disposeAll(); await ownership.release() })
  return new RestrictedAccountSessionService({ hostRoot: value.hostRoot, expectedUid: uid,
    runtimeGeneration: 5, schemaGeneration: 1, ownership, workers, extensions,
    ...testFence(value.hostRoot, ownership),
    claims: new LegacyClaimWorkerGate(() => false), inspector: value.inspector,
    ownerStateApplicator: value.ownerStateApplicator, inspectPersistence, createWorker, onCleanupFailure: () => {} })
}

function restrictedAccountRead(service: RestrictedAccountSessionService, authorize: () => PersonProfileRecord,
  command: HostRemoteSessionCommand, signal: AbortSignal) {
  return service.read({ authorizeRestrictedAccountHistory: authorize }, {
    issuer: 'fixture', subject: 'fixture', accountAccessToken: 'fixture',
    authorityEnvironmentId: 'fixture', accountBindingHandle: 'fixture', authorityBindingVersion: 1,
    keyHandle: 'fixture', unlockMaterial: 'fixture',
  }, () => {}, command, signal)
}

function verifyBundle(value: Awaited<ReturnType<typeof bundledFixture>>) {
  return verifyCopiedBundledPlugin(value.catalog, value.catalog.get('fixture-plugin', '1.0.0')!, value.web, uid)
}

it('verifies a Profile-owned historical archive without installing it', async () => {
  const value = await bundledFixture()
  const dependency = bundledDependencySpec(value.digest)
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid))
    .resolves.toEqual({ spec: 'bundled:fixture-plugin@1.0.0', digest: value.digest })
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid, true))
    .resolves.toEqual({ spec: 'bundled:fixture-plugin@1.0.0', digest: value.digest })
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid, true, value.installed))
    .resolves.toEqual({ spec: 'bundled:fixture-plugin@1.0.0', digest: value.digest })
  await writeFile(join(value.installed, 'index.js'), 'local modification')
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid, true))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'other', uid)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  await expect(verifyProfileRollbackArchive(value.web, 'file:../other.tgz', 'fixture-plugin', uid)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  await writeFile(join(value.web, '.bundled-plugins', `${value.digest}.tgz`), 'changed')
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid)).rejects.toMatchObject({ code: 'runtime_incompatible' })
})

it('reads a verified bundled patch without installing or extracting it', async () => {
  const patch = '- insert:\n    - id: bot\n      name: fixture\n'
  const value = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': patch })
  const plugin = value.catalog.get('fixture-plugin', '1.0.0')!
  expect(await readBundledPluginPatch(value.catalog, plugin)).toBe(patch)
  await writeFile(value.archive, 'changed archive')
  await expect(readBundledPluginPatch(value.catalog, plugin)).rejects.toMatchObject({ code: 'runtime_incompatible' })
})

it('plans preservation from the verified target archive before changing the Profile', async () => {
  const patch = '- insert:\n    - id: bot\n      name: fixture-plugin\n'
  const value = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': patch })
  const plugin = value.catalog.get('fixture-plugin', '1.0.0')!
  const layers = [
    { packageName: 'base', patches: [{ insert: [{ id: 'web', name: 'web', config: { searchProvider: 'official' } }] }] },
    { packageName: 'fixture-plugin', patches: [{ insert: [{ id: 'bot', name: 'fixture-plugin' }] }, { id: 'web', config: { searchProvider: 'auto' } }] },
  ]
  const before = await readFile(join(value.web, 'package.json'), 'utf8')
  const result = await prepareBundledPluginUpgrade(value.catalog, plugin, layers, '[]\n', [])
  expect(result.patch).toContain('searchProvider: auto')
  const nextLayers = layers.map(layer => layer.packageName === plugin.name ? { ...layer, patches: result.patches } : layer)
  const parsedPatch = parseDocument(result.patch).toJSON() as Parameters<typeof pluginBundleEntries>[1]
  expect(pluginBundleEntries(nextLayers, parsedPatch, plugin.name)).toEqual([
    { entryId: 'include:bot', moduleName: 'fixture-plugin' },
  ])
  expect(await readFile(join(value.web, 'package.json'), 'utf8')).toBe(before)
})

it('rejects bundled metadata missing a patch or declaring a different identity', async () => {
  const missing = await bundledFixture()
  await expect(readBundledPluginPatch(missing.catalog, missing.catalog.get('fixture-plugin', '1.0.0')!))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
  const wrong = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify({ name: 'other', version: '1.0.0' }), 'cordis.patch.yml': '[]\n' })
  await expect(readBundledPluginPatch(wrong.catalog, wrong.catalog.get('fixture-plugin', '1.0.0')!))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
  const differentPatch = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: 'other.yml' } } }),
    'cordis.patch.yml': '[]\n' })
  await expect(readBundledPluginPatch(differentPatch.catalog, differentPatch.catalog.get('fixture-plugin', '1.0.0')!))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
})

it.each([
  { name: 'fixture-plugin', version: '1.0.0' },
  { name: 'fixture-plugin', version: '1.0.0', dsh: {} },
])('rejects target archives without a valid bundle declaration', async (identity) => {
  const value = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify(identity), 'cordis.patch.yml': '[]\n' })
  await expect(readBundledPluginPatch(value.catalog, value.catalog.get('fixture-plugin', '1.0.0')!))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
})

it('rejects oversized metadata before extracting an archive', async () => {
  const value = await bundledFixture(undefined, { ...bundledFiles,
    'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': randomBytes(800_000).toString('base64') })
  await expect(readBundledPluginPatch(value.catalog, value.catalog.get('fixture-plugin', '1.0.0')!))
    .rejects.toMatchObject({ code: 'runtime_incompatible' })
})

it.each(['null', '{', JSON.stringify({ name: 'fixture-plugin', version: '1.0.0-beta' })])(
  'rejects invalid historical package identity', async (manifest) => {
    const value = await bundledFixture(undefined, { ...bundledFiles, 'package.json': manifest })
    await expect(verifyProfileRollbackArchive(value.web, bundledDependencySpec(value.digest), 'fixture-plugin', uid))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  },
)

it('rejects an unsafe historical archive directory and missing archive', async () => {
  const value = await bundledFixture(); const directory = join(value.web, '.bundled-plugins')
  const dependency = bundledDependencySpec(value.digest)
  await chmod(directory, 0o777)
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  await chmod(directory, 0o700)
  await unlink(join(directory, `${value.digest}.tgz`))
  await expect(verifyProfileRollbackArchive(value.web, dependency, 'fixture-plugin', uid)).rejects.toMatchObject({ code: 'runtime_incompatible' })
})

function unsafeArchive(path: string, type: 'File' | 'SymbolicLink' | 'CharacterDevice' | 'ExtendedHeader' = 'File', size = 1, includeBase = true): Buffer {
  const valid: Buffer[] = []
  for (const [name, content] of Object.entries(includeBase ? bundledFiles : {})) {
    const data = Buffer.from(content)
    const header = new Header({ path: `package/${name}`, type: 'File', size: data.length, mode: 0o600, uid, gid: uid })
    const block = Buffer.alloc(512)
    header.encode(block)
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
    data.copy(padded)
    valid.push(block, padded)
  }
  const header = new Header({ path, type, size, mode: 0o600, uid, gid: uid,
    ...(type === 'SymbolicLink' ? { linkpath: 'index.js' } : {}) })
  const block = Buffer.alloc(512)
  header.encode(block)
  return gzipSync(Buffer.concat([...valid, block, Buffer.alloc(512), Buffer.alloc(1024)]))
}

async function treeInventory(root: string): Promise<unknown[]> {
  const result: unknown[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const stat = await lstat(path)
      result.push([path, stat.mode, stat.size, stat.mtimeMs, stat.isFile()
        ? createHash('sha256').update(await readFile(path)).digest('hex') : null])
      if (stat.isDirectory()) await visit(path)
    }
  }
  await visit(root)
  return result
}

describe('offline Profile existing-only inspector', () => {
  async function releasedEmptyProfile() {
    const value = await fixture()
    await rm(join(value.web, 'node_modules'), { recursive: true })
    await unlink(join(value.web, 'pnpm-lock.yaml'))
    // Signed macOS 0.4.23 layout; the anonymous package name carries no identity.
    const manifest = await readFile(new URL('./fixtures/released-empty-profile.package.json', import.meta.url))
    await writeFile(join(value.web, 'package.json'), manifest)
    return value
  }

  it('recovers the released empty-plugin Profile without creating a lockfile', async () => {
    const value = await releasedEmptyProfile()
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 0, unverifiedPluginCount: 0 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('binds lockfile absence separately from a subsequently installed lockfile', async () => {
    const value = await releasedEmptyProfile()
    const absent = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const before = await treeInventory(value.profileRoot)
    const installed = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(installed.preflightDigest).not.toBe(absent.preflightDigest)
    await expect(value.inspector.prepareConfirmedProfile(profile(), absent))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each(['node_modules', '.bundled-plugins'])('rejects a missing lock with retained %s installation state', async (name) => {
    const value = await releasedEmptyProfile()
    await mkdir(join(value.web, name), { mode: 0o700 })
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each([[], null, { 'fixture-plugin': '1.0.0' }])('rejects a missing lock with invalid or nonempty dependencies: %j', async (dependencies) => {
    const value = await releasedEmptyProfile()
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies }))
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each([
    unsafeArchive('package/../outside'), unsafeArchive('/package/index.js'),
    unsafeArchive('package/index.js'),
    unsafeArchive('package/node_modules/link', 'SymbolicLink', 0),
    unsafeArchive('package/device', 'CharacterDevice', 0),
    unsafeArchive('package/huge', 'File', 128 * 1024 * 1024 + 1),
    unsafeArchive('package/truncated', 'File', 4096),
    unsafeArchive('package/meta', 'ExtendedHeader', 65537),
    Buffer.from('invalid archive'),
    unsafeArchive('package/index.js', 'File', 1, false),
  ])('rejects an unsafe archive even when its digest is catalog-pinned %#', async (archive) => {
    const value = await bundledFixture(archive)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('bounds copied package enumeration even if the filesystem keeps returning entries', async () => {
    const value = await bundledFixture()
    readFaults.set(value.installed, 'manyEntries')
    onTestFinished(() => { readFaults.delete(value.installed) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['short', 'changed'] as const)('rejects a plugin file with a %s read', async (fault) => {
    const value = await bundledFixture()
    const path = join(value.installed, 'index.js')
    readFaults.set(path, fault)
    onTestFinished(() => { readFaults.delete(path) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it.each(['file-mode', 'directory-mode', 'archive-directory-mode', 'extra-directory'])
  ('rejects unsafe copied package metadata: %s', async (kind) => {
    const value = await bundledFixture()
    if (kind === 'file-mode') await chmod(join(value.installed, 'index.js'), 0o666)
    if (kind === 'directory-mode') await chmod(value.installed, 0o777)
    if (kind === 'archive-directory-mode') await chmod(join(value.web, '.bundled-plugins'), 0o777)
    if (kind === 'extra-directory') await mkdir(join(value.installed, 'extra'), { mode: 0o700 })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects an archive whose package identity does not match the catalog', async () => {
    const value = await bundledFixture(undefined, { ...bundledFiles,
      'package.json': JSON.stringify({ name: 'other-plugin', version: '1.0.0' }) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recovers copied catalog plugins including bundled nested dependencies without writing Profile files', async () => {
    const value = await bundledFixture()
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    for (const [path, content] of Object.entries(value.files)) {
      expect(await readFile(join(value.installed, path), 'utf8')).toBe(content)
    }
    await expect(readFile(join(value.profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('recovers the historical archive when the catalog also ships a newer version', async () => {
    const value = await bundledFixture(undefined, bundledFiles, true)
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each(['modified', 'missing', 'extra', 'symlink', 'profile-archive', 'embedding-archive'])
  ('rejects a copied bundled dependency with %s content', async (kind) => {
    const value = await bundledFixture()
    const nested = join(value.installed, 'node_modules', 'nested', 'index.js')
    if (kind === 'modified') await writeFile(nested, 'tampered')
    if (kind === 'missing') await unlink(nested)
    if (kind === 'extra') await writeFile(join(value.installed, 'node_modules', 'nested', 'extra.js'), 'extra')
    if (kind === 'symlink') { await unlink(nested); await symlink(join(value.installed, 'index.js'), nested) }
    if (kind === 'profile-archive') await writeFile(join(value.web, '.bundled-plugins', `${value.digest}.tgz`), 'tampered')
    if (kind === 'embedding-archive') await writeFile(value.archive, 'tampered')
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects a copied plugin changed after its confirmed preflight', async () => {
    const value = await bundledFixture()
    const preflight = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.installed, 'node_modules', 'nested', 'index.js'), 'tampered')
    await expect(value.inspector.prepareConfirmedProfile(profile(), preflight))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it('keeps copied dependencies blocked when their source is not the exact catalog archive', async () => {
    const value = await bundledFixture()
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }))
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'compatibility_blocked', compatibility: 'read_only_export_only',
        unverifiedPluginCount: 1 })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('counts unverified dependencies independently of verified runtime dependencies', async () => {
    const value = await fixture()
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: {
      'fixture-plugin': '1.0.0', 'missing-one': '1.0.0', 'missing-two': '1.0.0',
    } }))
    const before = await treeInventory(value.profileRoot)
    const result = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(result).toMatchObject({ state: 'compatibility_blocked', pluginCount: 3, unverifiedPluginCount: 2 })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('does not execute a copied unverified dependency while counting it', async () => {
    const value = await bundledFixture()
    const sentinel = join(value.hostRoot, 'plugin-executed')
    await writeFile(join(value.installed, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`)
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }))
    const result = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(result).toMatchObject({ state: 'compatibility_blocked', unverifiedPluginCount: 1 })
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('inspects released compressed history for restricted reading without creating a recovery plan', async () => {
    const value = await fixture()
    const id = SessionId('req0002-old-writer-history')
    const path = generationLogPath(value.persistence.root, '/private/tmp/slark-req0002-history-workspace', id, 3, 'zstd')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path,
      await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v3-old-writer.jsonl.zstd', import.meta.url)),
      { mode: 0o600 })
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
    const restricted = await value.inspector.inspectRestricted(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(restricted).toMatchObject({ state: 'compatibility_blocked', compression: 'zstd', unverifiedPluginCount: 1 })
    await expect(value.inspector.prepareConfirmedProfile(profile(), restricted))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('quarantines an external plugin link during restricted inspection without following or executing it', async () => {
    const value = await fixture()
    const external = join(value.hostRoot, 'untrusted-plugin')
    await mkdir(external, { mode: 0o700 })
    const marker = join(value.hostRoot, 'executed')
    await writeFile(join(external, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
    await unlink(join(value.web, 'node_modules', 'fixture-plugin'))
    await symlink(external, join(value.web, 'node_modules', 'fixture-plugin'))
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
    await expect(value.inspector.inspectRestricted(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'compatibility_blocked', unverifiedPluginCount: 1 })
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('can inspect a separate default web composition without reading the original plugin manifest', async () => {
    const value = await bundledFixture()
    const originalManifest = join(value.web, 'package.json')
    await writeFile(originalManifest, 'invalid user manifest')
    const before = await treeInventory(value.profileRoot)
    const isolatedWeb = join(value.hostRoot, 'isolated', 'profiles', 'web')
    initProfile(isolatedWeb, PROFILE_TEMPLATES.web!.bundles)
    const anchor = fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url))
    const loaded = loadProfileDirectory('dsh', isolatedWeb, anchor)
    expect(loaded.skippedBundles).toEqual([])
    expect(loaded.layers.map(layer => layer.packageName)).toEqual(PROFILE_TEMPLATES.web!.bundles)
    expect(loaded.layers.every(layer => !layer.packageDir.startsWith(value.profileRoot))).toBe(true)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('stops the isolated reader before allowing the original Profile worker to restart', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fence-fixture' })
    const events: string[] = []
    const regular = new ProfileWorkerSupervisor(async () => {
      events.push('regular-start')
      return { closeNotifications() {}, abort() { events.push('regular-stop') }, done: Promise.resolve() }
    })
    const spec = { profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] }
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const isolated = withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => { throw new Error('cleanup failed') },
      createWorker: async () => ({ closeNotifications() {}, abort() { events.push('isolated-stop') }, done: Promise.resolve() }),
    }, async () => {
      enter()
      await new Promise<void>(resolve => { release = resolve })
      throw new Error('operation failed')
    })
    const failed = expect(isolated).rejects.toThrow('operation failed')
    await entered
    const restart = regular.start(spec)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual([])
    release()
    await failed
    await restart
    expect(events).toEqual(['isolated-stop', 'regular-start'])
  })

  it('does not interrupt an already running Profile to start a restricted reader', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-healthy-worker-fixture' })
    const stopped = vi.fn()
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort: stopped, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    await regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    await expect(withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), {
      stagingParent: value.hostRoot, expectedUid: uid, profileRoot: value.profileRoot, ownerPaths: value.ownerPaths,
      persistence: value.persistence, inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership),
      profileId, credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker,
    }, async () => {})).rejects.toMatchObject({ code: 'conflict' })
    expect(stopped).not.toHaveBeenCalled()
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('blocks the Profile when the isolated worker exit cannot be confirmed', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-failed-stop-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    await expect(withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker: async () => {
        let fail!: (error: Error) => void
        const done = new Promise<void>((_resolve, reject) => { fail = reject })
        return { closeNotifications() {}, abort() { fail(new Error('worker exit unknown')) }, done }
      },
    }, async () => {})).rejects.toThrow('worker exit unknown')
    await expect(regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('releases the Profile fence after its connection aborts even if the callback stalls', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-abort-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    onTestFinished(async () => { release(); await regular.disposeAll(); await ownership.release() })
    const controller = new AbortController()
    const stopped = vi.fn()
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const isolated = withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: controller.signal, onCleanupFailure: () => {},
      createWorker: async () => ({ closeNotifications() {}, abort: stopped, done: Promise.resolve() }),
    }, async () => { enter(); await stalled })
    const cancelled = expect(isolated).rejects.toMatchObject({ name: 'AbortError' })
    await entered
    const restart = regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
    controller.abort()
    await cancelled
    await restart
    expect(stopped).toHaveBeenCalledOnce()
  })

  it.each(['return', 'throw'] as const)('discards a result when cancellation and callback %s happen together', async (outcome) => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-abort-result-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    const controller = new AbortController()
    await expect(withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: controller.signal, onCleanupFailure: () => {},
      createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
    }, () => {
      controller.abort()
      if (outcome === 'throw') throw new Error('late callback failure')
      return Promise.resolve('private history')
    }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes connection cancellation to an isolated worker that is still starting', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-start-abort-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    const controller = new AbortController()
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const isolated = withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: controller.signal, onCleanupFailure: () => {},
      createWorker: async (_spec, signal) => {
        expect(signal).toBe(controller.signal)
        enter()
        return await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      },
    }, async () => {})
    const cancelled = expect(isolated).rejects.toMatchObject({ name: 'AbortError' })
    await entered
    controller.abort()
    await cancelled
    await regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
  })

  it('retains staging and fences the Profile when a startup child cannot be stopped', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-start-uncertain-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    const extensions = extensionBarrier()
    const authority = () => profileId
    const plan = await extensions.prepare(authority, 'plugin', '{}')
    await expect(withRestrictedProfileReader(regular, extensions, new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker: async () => { throw new ProfileWorkerExitUnconfirmedError(new Error('fixture')) },
    }, async () => {})).rejects.toBeInstanceOf(ProfileWorkerExitUnconfirmedError)
    expect((await readdir(value.hostRoot)).some(name => name.startsWith('restricted-'))).toBe(true)
    expect(new RestrictedProfileFence(value.hostRoot, uid, ownership).pending(profileId)).toBeDefined()
    await expect(regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(() => extensions.commit(authority, plan.planId, randomUUID())).toThrow('busy')
  })

  it('retains the durable fence when external writer quiescence cannot be proven', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-quiescence-fixture' })
    const fence = new RestrictedProfileFence(value.hostRoot, uid, ownership)
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
      id => fence.pending(id) !== undefined)
    const extensions = extensionBarrier()
    let checks = 0
    let writerExclusionHeld = false
    onTestFinished(async () => { await extensions.dispose(); await regular.disposeAll(); await ownership.release() })
    const claims = new LegacyClaimWorkerGate(() => false, id => fence.pending(id) !== undefined)
    await expect(withRestrictedProfileReader(regular, extensions, claims, {
      stagingParent: value.hostRoot, expectedUid: uid, profileRoot: value.profileRoot, ownerPaths: value.ownerPaths,
      persistence: value.persistence, inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership,
      profileId, credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      fence, withAllWritersExcluded: async operation => {
        writerExclusionHeld = true
        try { return await operation() } finally { writerExclusionHeld = false }
      },
      assertAllWritersQuiescent: () => {
        expect(writerExclusionHeld).toBe(true)
        if (++checks > 2) throw new Error('writer_state_unknown')
      }, onCleanupFailure: () => {},
      createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
    }, async () => 'must not return')).rejects.toThrow('writer_state_unknown')
    expect(new RestrictedProfileFence(value.hostRoot, uid, ownership).pending(profileId)).toBeDefined()
    expect(writerExclusionHeld).toBe(false)
    expect(regular.isProfileBlocked(profileId)).toBe(true)
    expect(regular.isProfileBlocked('018f0f4c-87f8-7e2d-a2f8-7b93d34e3152')).toBe(false)
  })

  it('clears its own fence after confirmed worker exit and releases Profile admission', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-cleared-fixture' })
    const fence = new RestrictedProfileFence(value.hostRoot, uid, ownership)
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
      id => fence.pending(id) !== undefined)
    const claims = new LegacyClaimWorkerGate(() => false, id => fence.pending(id) !== undefined)
    const extensions = extensionBarrier()
    let writerExclusionHeld = false
    onTestFinished(async () => { await extensions.dispose(); await regular.disposeAll(); await ownership.release() })
    const result = await withRestrictedProfileReader(regular, extensions, claims, {
      stagingParent: value.hostRoot, expectedUid: uid, profileRoot: value.profileRoot, ownerPaths: value.ownerPaths,
      persistence: value.persistence, inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership,
      profileId, credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      fence, withAllWritersExcluded: async operation => {
        expect(writerExclusionHeld).toBe(false)
        writerExclusionHeld = true
        try { return await operation() } finally { writerExclusionHeld = false }
      }, assertAllWritersQuiescent: () => { expect(writerExclusionHeld).toBe(true) }, onCleanupFailure: () => {},
      createWorker: async () => ({ closeNotifications() {}, abort() { expect(writerExclusionHeld).toBe(true) }, done: Promise.resolve() }),
    }, async () => {
      expect(writerExclusionHeld).toBe(true)
      expect(fence.pending(profileId)).toBeDefined()
      expect(regular.isProfileBlocked(profileId)).toBe(true)
      return 'complete'
    })
    expect(result).toBe('complete')
    expect(writerExclusionHeld).toBe(false)
    expect(fence.pending(profileId)).toBeUndefined()
    await regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
  })

  it('keeps extension mutation admission closed for the entire restricted reader lifetime', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-extension-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const extensions = extensionBarrier()
    let release = () => {}
    onTestFinished(async () => { release(); await extensions.dispose(); await regular.disposeAll(); await ownership.release() })
    const authority = () => profileId
    const plan = await extensions.prepare(authority, 'plugin', '{}')
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const isolated = withRestrictedProfileReader(regular, extensions, new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
    }, async () => { enter(); await new Promise<void>(resolve => { release = resolve }) })
    await entered
    const operationId = randomUUID()
    expect(() => extensions.commit(authority, plan.planId, operationId)).toThrow('busy')
    release()
    await isolated
    extensions.commit(authority, plan.planId, operationId)
    await extensions.settled()
    expect(extensions.status(authority, operationId).state).toBe('succeeded')
  })

  it('keeps extension mutations fenced until the isolated worker has actually exited', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-extension-exit-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const extensions = extensionBarrier()
    let finish = () => {}
    onTestFinished(async () => { finish(); await extensions.dispose(); await regular.disposeAll(); await ownership.release() })
    const authority = () => profileId
    const plan = await extensions.prepare(authority, 'plugin', '{}')
    let stopping!: () => void
    const stopped = new Promise<void>(resolve => { stopping = resolve })
    const done = new Promise<void>(resolve => { finish = resolve })
    const isolated = withRestrictedProfileReader(regular, extensions, new LegacyClaimWorkerGate(() => false), { stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership), profileId,
      credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker: async () => ({ closeNotifications() {}, abort: stopping, done }),
    }, async () => {})
    await stopped
    const operationId = randomUUID()
    expect(() => extensions.commit(authority, plan.planId, operationId)).toThrow('busy')
    finish()
    await isolated
    extensions.commit(authority, plan.planId, operationId)
    await extensions.settled()
    expect(extensions.status(authority, operationId).state).toBe('succeeded')
  })

  it('refuses restricted reading while a durable model claim is pending', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-pending-claim-fixture' })
    const stopRegular = vi.fn()
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort: stopRegular, done: Promise.resolve() }))
    onTestFinished(async () => { await regular.disposeAll(); await ownership.release() })
    await regular.start({ profileId, profileRoot: value.profileRoot, credentialHandle: 'fixture', pluginRoots: [] })
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    await expect(withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => true), {
      stagingParent: value.hostRoot, expectedUid: uid, profileRoot: value.profileRoot, ownerPaths: value.ownerPaths,
      persistence: value.persistence, inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership),
      profileId, credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker,
    }, async () => {})).rejects.toMatchObject({ code: 'unavailable' })
    expect(createWorker).not.toHaveBeenCalled()
    expect(stopRegular).not.toHaveBeenCalled()
  })

  it('discards a restricted result if a model claim starts while reading', async () => {
    const value = await bundledFixture()
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-claim-race-fixture' })
    const regular = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const claims = new LegacyClaimWorkerGate(() => false)
    let release = () => {}
    onTestFinished(async () => { release(); await regular.disposeAll(); await ownership.release() })
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const isolated = withRestrictedProfileReader(regular, extensionBarrier(), claims, {
      stagingParent: value.hostRoot, expectedUid: uid, profileRoot: value.profileRoot, ownerPaths: value.ownerPaths,
      persistence: value.persistence, inspectPersistence: () => value.target.inspectRestrictedPersistence(), ownership, ...testFence(value.hostRoot, ownership),
      profileId, credentialHandle: 'fixture', assertCurrent: () => {}, signal: new AbortController().signal,
      onCleanupFailure: () => {}, createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
    }, async () => { enter(); await new Promise<void>(resolve => { release = resolve }); return 'private history' })
    const denied = expect(isolated).rejects.toMatchObject({ code: 'unavailable' })
    await entered
    const claim = claims.stop(profileId, () => regular.dispose(profileId))
    release()
    await denied
    await claim
  })

  it('revalidates Account ownership around a one-shot restricted history read', async () => {
    const value = await bundledFixture()
    const record = profile()
    const authorize = vi.fn(() => record)
    const stop = vi.fn()
    const service = await accountService(value, async () => ({ closeNotifications() {}, abort: stop,
      done: Promise.resolve(), remoteSession: async () => ({ items: ['fixture history'] }) }))
    const before = await treeInventory(value.profileRoot)
    const command = { operation: 'session.list' as const,
      command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId }
    await expect(restrictedAccountRead(service, authorize, command, new AbortController().signal)).resolves.toEqual({ items: ['fixture history'] })
    expect(authorize.mock.calls.length).toBeGreaterThan(3)
    expect(stop).toHaveBeenCalledOnce()
    expect(await treeInventory(value.profileRoot)).toEqual(before)
    await expect(restrictedAccountRead(service, authorize, { operation: 'session.create',
      command_id: '123e4567-e89b-42d3-a456-426614174001' as HostControlRequestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('requires the trusted broker authority guard before consulting local Account proof', async () => {
    const value = await bundledFixture()
    const host = { authorizeRestrictedAccountHistory: vi.fn(() => profile()) }
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const service = await accountService(value, createWorker)
    await expect(service.read(host, { issuer: 'fixture', subject: 'fixture', accountAccessToken: 'fixture',
      authorityEnvironmentId: 'fixture', accountBindingHandle: 'fixture', authorityBindingVersion: 1,
      keyHandle: 'fixture', unlockMaterial: 'fixture' }, () => { throw new HostAuthorityError('unauthorized') },
    { operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId },
    new AbortController().signal)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(host.authorizeRestrictedAccountHistory).not.toHaveBeenCalled()
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('refuses restricted history while an existing session writer holds its kernel lock', async () => {
    const value = await bundledFixture()
    const id = SessionId('restricted-lock-contention')
    await value.target.importSession(1, { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
      cwd: '/work', isSeeded: false }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const [directory] = (await value.target.inspectRestrictedPersistence()).sessionDirectories
    if (!directory) throw new Error('missing fixture session')
    await writeFile(join(directory, 'session.lock'), '', { mode: 0o600 })
    const writer = await SessionWriteLease.acquire(directory, id)
    onTestFinished(() => writer.release())
    let writerBlockedDuringRead = false
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
      remoteSession: async () => {
        try { const other = await ExistingSessionLock.acquire(directory, uid); other.close() } catch (error) {
          if (!['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          writerBlockedDuringRead = true
        }
        return { items: [] }
      } }))
    const service = await accountService(value, createWorker)
    const record = profile()
    const command = { operation: 'session.list' as const,
      command_id: '123e4567-e89b-42d3-a456-426614174006' as HostControlRequestId }
    await expect(restrictedAccountRead(service, () => record, command, new AbortController().signal))
      .rejects.toMatchObject({ code: 'busy' })
    expect(createWorker).not.toHaveBeenCalled()
    await writer.release()
    const before = await treeInventory(value.profileRoot)
    await expect(restrictedAccountRead(service, () => record, command, new AbortController().signal))
      .resolves.toEqual({ items: [] })
    expect(writerBlockedDuringRead).toBe(true)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('does not return restricted history after a held session lock is replaced', async () => {
    const value = await bundledFixture()
    const id = SessionId('restricted-lock-replacement')
    await value.target.importSession(1, { version: SESSION_FORMAT_VERSION, id, createdAt: 1,
      cwd: '/work', isSeeded: false }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const [directory] = (await value.target.inspectRestrictedPersistence()).sessionDirectories
    if (!directory) throw new Error('missing fixture session')
    const lock = join(directory, 'session.lock')
    await writeFile(lock, '', { mode: 0o600 })
    const service = await accountService(value, async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
      remoteSession: async () => { await unlink(lock); await writeFile(lock, '', { mode: 0o600 }); return { items: ['private'] } } }))
    const record = profile()
    await expect(restrictedAccountRead(service, () => record, { operation: 'session.list',
      command_id: '123e4567-e89b-42d3-a456-426614174007' as HostControlRequestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(JSON.parse(await readFile(join(value.hostRoot, `${profileId}.json`), 'utf8')).state).toBe('pending')
  })

  it('rejects a session directory list that changes without a matching inventory change', async () => {
    const value = await bundledFixture()
    let inspections = 0
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const service = await accountService(value, createWorker, async () => {
      const current = await value.target.inspectRestrictedPersistence()
      return ++inspections === 1 ? current : { ...current, sessionCount: 1,
        sessionDirectories: [join(current.root, 'unexpected-project', 'unexpected-session')] }
    })
    const record = profile()
    await expect(restrictedAccountRead(service, () => record, { operation: 'session.list',
      command_id: '123e4567-e89b-42d3-a456-426614174008' as HostControlRequestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('does not return restricted history if Account authorization is revoked during the read', async () => {
    const value = await bundledFixture()
    const record = profile()
    let authorized = true
    let enter!: () => void, release = () => {}
    const entered = new Promise<void>(resolve => { enter = resolve })
    onTestFinished(() => release())
    const service = await accountService(value, async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
      remoteSession: async () => { enter(); await new Promise<void>(resolve => { release = resolve }); return { items: ['private'] } } }))
    const pending = restrictedAccountRead(service, () => {
      if (!authorized) throw new HostAuthorityError('unauthorized')
      return record
    }, { operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId },
    new AbortController().signal)
    const denied = expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    await entered
    authorized = false
    release()
    await denied
  })

  it('rechecks Account authorization after the isolated worker exits', async () => {
    const value = await bundledFixture()
    const record = profile()
    let authorized = true, finish = () => {}
    let enter!: () => void
    const stopping = new Promise<void>(resolve => { enter = resolve })
    const done = new Promise<void>(resolve => { finish = resolve })
    onTestFinished(() => finish())
    const service = await accountService(value, async () => ({ closeNotifications() {}, abort: enter, done,
      remoteSession: async () => ({ items: ['private'] }) }))
    const pending = restrictedAccountRead(service, () => {
      if (!authorized) throw new HostAuthorityError('unauthorized')
      return record
    }, { operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId },
    new AbortController().signal)
    const denied = expect(pending).rejects.toMatchObject({ code: 'unauthorized' })
    await stopping
    authorized = false
    finish()
    await denied
  })

  it('rejects changed persistence between Account preflight and reader staging', async () => {
    const value = await bundledFixture()
    const record = profile()
    let inspections = 0
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const service = await accountService(value, createWorker, async () => {
      const current = await value.target.inspectRestrictedPersistence()
      inspections += 1
      return inspections === 1 ? current : { ...current, inventoryDigest: 'f'.repeat(64) }
    })
    await expect(restrictedAccountRead(service, () => record, { operation: 'session.list',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('rejects an in-place Account binding generation change during preflight', async () => {
    const value = await bundledFixture()
    const record = profile()
    const createWorker = vi.fn(async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }))
    const service = await accountService(value, createWorker)
    let checks = 0
    const authorize = () => {
      if (++checks === 2) Object.assign(record, { bindingGeneration: record.bindingGeneration + 1 })
      return record
    }
    await expect(restrictedAccountRead(service, authorize, { operation: 'session.list',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'stale' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it.runIf(process.env.DSH_RUN_ISOLATION_SPIKE === '1')('starts a separate default worker without loading the original composition', async () => {
    const value = await bundledFixture()
    const sentinel = join(value.hostRoot, 'plugin-executed')
    await writeFile(join(value.installed, 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`)
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }))
    await writeFile(value.ownerPaths.settingsPath, JSON.stringify({ appearance: { theme: 'fixture-theme' } }), { mode: 0o600 })
    await value.target.importSession(1, { version: SESSION_FORMAT_VERSION, id: SessionId('fixture-session'),
      createdAt: 1, isSeeded: false, cwd: value.hostRoot }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: {
        id: MessageId('fixture-message'), role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'isolated-history-fixture' }],
      } },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const legacyPath = generationLogPath(value.persistence.root, '/work', SessionId('released-v0-real-shapes'), 0, 'none')
    await mkdir(dirname(legacyPath), { recursive: true, mode: 0o700 })
    await writeFile(legacyPath,
      await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v0-real-shapes.jsonl', import.meta.url)),
      { mode: 0o600 })
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'compatibility_blocked', unverifiedPluginCount: 1 })
    const before = await treeInventory(value.profileRoot)
    const ownership = await acquireSingleHostLock({ root: join(value.hostRoot, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    const entry = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
    const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: await isolatedTestNode(value.hostRoot), dshEntrypointPath: entry })
    const regular = new ProfileWorkerSupervisor(async () => { throw new Error('unexpected regular worker') })
    onTestFinished(() => regular.disposeAll())
    await withRestrictedProfileReader(regular, extensionBarrier(), new LegacyClaimWorkerGate(() => false), {
      stagingParent: value.hostRoot, expectedUid: uid,
      profileRoot: value.profileRoot, ownerPaths: value.ownerPaths, persistence: value.persistence,
      inspectPersistence: () => value.target.inspectRestrictedPersistence(),
      ownership, ...testFence(value.hostRoot, ownership), profileId, credentialHandle: 'fixture', createWorker: (spec, signal) => process.env.DSH_TEST_DENY_FORK === '1'
        ? factory.createRestricted(spec, signal) : factory.create(spec, signal), onCleanupFailure: () => {},
      assertCurrent: () => {}, signal: new AbortController().signal }, async reader => {
      const command = { operation: 'session.list' as const,
        command_id: '123e4567-e89b-42d3-a456-426614174000' as HostControlRequestId }
      const history = await reader.read(command, AbortSignal.timeout(10_000))
      expect(JSON.stringify(history)).toContain('fixture-session')
      if (process.env.DSH_TEST_DENY_FORK === '1') {
        const staged = Reflect.get(reader, 'staging') as { root: string }
        expect(JSON.parse(await readFile(join(staged.root, 'sandbox-probe-result'), 'utf8')))
          .toEqual({ fork: 'EPERM', write: 'EPERM', link: 'EPERM', hardlink: 'EPERM' })
        await vi.waitFor(async () => expect(await readFile(join(staged.root, 'sandbox-network-result'), 'utf8')).toBe('EPERM'))
        await vi.waitFor(async () => expect(await readFile(join(staged.root, 'sandbox-udp-result'), 'utf8')).toBe('EPERM'))
        await expect(lstat(join(value.hostRoot, 'forbidden-sandbox-write'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(value.hostRoot, 'sandbox-original'), 'utf8')).toBe('unchanged')
      }
      const events = await reader.read({ operation: 'session.history',
        command_id: '123e4567-e89b-42d3-a456-426614174001' as HostControlRequestId,
        session_id: 'fixture-session', max_events: 100 }, AbortSignal.timeout(10_000))
      expect(JSON.stringify(events)).toContain('isolated-history-fixture')
      await expect(reader.read({ operation: 'session.history',
        command_id: '123e4567-e89b-42d3-a456-426614174003' as HostControlRequestId,
        session_id: 'released-v0-real-shapes', max_events: 100 }, AbortSignal.timeout(10_000)))
        .rejects.toMatchObject({ code: 'unavailable' })
      await expect(reader.read({ operation: 'session.create',
        command_id: '123e4567-e89b-42d3-a456-426614174002' as HostControlRequestId }, AbortSignal.timeout(10_000)))
        .rejects.toMatchObject({ code: 'unauthorized' })
      await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await treeInventory(value.profileRoot)).toEqual(before)
      // A second writer invalidates the staged snapshot; do not return history under stale facts.
      await writeFile(legacyPath, 'changed by another writer', { mode: 0o600 })
      await expect(reader.read(command, AbortSignal.timeout(10_000)))
        .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
      await reader.close()
      await expect(reader.read(command, AbortSignal.timeout(10_000))).rejects.toMatchObject({ code: 'stale' })
    })
  }, 45_000)

  it.runIf(process.env.DSH_RUN_ISOLATION_SPIKE === '1')('reads released compressed history without modifying its generation', async () => {
    const value = await bundledFixture()
    const id = SessionId('req0002-old-writer-history')
    const path = generationLogPath(value.persistence.root, '/private/tmp/slark-req0002-history-workspace', id, 3, 'zstd')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path,
      await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v3-old-writer.jsonl.zstd', import.meta.url)),
      { mode: 0o600 })
    await writeFile(join(dirname(path), 'session.lock'), '', { mode: 0o600 })
    const persistence = await value.target.inspectRestrictedPersistence()
    expect(persistence.compression).toBe('zstd')
    const preflight = await value.inspector.inspectRestricted(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(preflight).toMatchObject({ state: 'compatibility_blocked', compression: 'zstd', unverifiedPluginCount: 1 })
    const before = await treeInventory(value.profileRoot)
    const entry = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
    const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: await isolatedTestNode(value.hostRoot), dshEntrypointPath: entry })
    const service = await accountService(value, (spec, signal) => process.env.DSH_TEST_DENY_FORK === '1'
      ? factory.createRestricted(spec, signal) : factory.create(spec, signal))
    const account = profile()
    const history = await restrictedAccountRead(service, () => account, { operation: 'session.history',
      command_id: '123e4567-e89b-42d3-a456-426614174004' as HostControlRequestId,
      session_id: id, max_events: 100 }, AbortSignal.timeout(30_000))
    expect(JSON.stringify(history)).toContain('old-writer historical prompt')
    if (process.env.DSH_TEST_DENY_FORK === '1') await expect(lstat(join(value.hostRoot, 'forbidden-sandbox-write')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  }, 45_000)

  it.skipIf(process.platform === 'win32')('rejects a group-writable copied dependency', async () => {
    const value = await bundledFixture()
    await chmod(join(value.installed, 'index.js'), 0o666)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('accepts the exact released settings-owner patch without modifying it during preflight', async () => {
    const value = await fixture()
    const path = join(value.profileRoot, 'cordis.patch.yml')
    const patch = await releasedPatch(value)
    await writeFile(path, patch, { mode: 0o600 })
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'recoverable', persistenceGeneration: 1 })
    expect(await readFile(path, 'utf8')).toBe(patch)
  })

  it('rejects a released patch with redirected owner paths', async () => {
    const value = await fixture()
    const patch = (await releasedPatch(value)).replace(JSON.stringify(value.ownerPaths.settingsPath), JSON.stringify('/outside/settings.yaml'))
    await writeFile(join(value.profileRoot, 'cordis.patch.yml'), patch, { mode: 0o600 })
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('reports current compatible plugin inventory without modifying Profile files', async () => {
    const { profileRoot, inspector } = await fixture()
    const patchBefore = await readFile(join(profileRoot, 'cordis.patch.yml'))
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 1,
      sessionCount: 0, pluginCount: 1,
    })
    expect(inspected.preflightDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(join(profileRoot, 'cordis.patch.yml'))).toEqual(patchBefore)
    await expect(inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
  })

  it('needs no compatibility materialization when the Profile has no runtime dependencies', async () => {
    const value = await fixture()
    await unlink(join(value.web, 'node_modules', 'fixture-plugin'))
    await writeFile(join(value.web, 'package.json'), `${JSON.stringify({ dependencies: {} })}\n`)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 1,
      sessionCount: 0, pluginCount: 0,
    })
    await expect(value.inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
    await expect(readFile(join(value.profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects an intact dependency closure owned by a different packaged runtime', async () => {
    const { profileRoot, inspector } = await fixture(true)
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'legacy_runtime_required', pluginCount: 1,
    })
    await inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
    expect(JSON.parse(await readFile(
      join(profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`), 'utf8',
    ))).toMatchObject({ state: 'committed', rewriteCount: 1 })
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
  })

  it('rejects a broken plugin dependency without creating a replacement', async () => {
    const { profileRoot, inspector } = await fixture()
    await symlink('/missing/dsh-runtime/app/plugin', join(profileRoot, 'profiles', 'web', 'node_modules', 'broken'))
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recognizes only packaged runtime app paths', () => {
    expect(packagedRuntimeAppRoot('/Applications/Slark.app/Contents/Resources/dsh-runtime/app/bin/dsh.mjs'))
      .toBe('/Applications/Slark.app/Contents/Resources/dsh-runtime/app')
    expect(packagedRuntimeAppRoot('/tmp/dsh.mjs')).toBeUndefined()
    expect(packagedRuntimeAppRoot('relative/dsh-runtime/app/dsh.mjs')).toBeUndefined()
  })

  it.each([
    ['unsafe Profile directory', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(value.profileRoot, 0o777)],
    ['changed worker patch', async (value: Awaited<ReturnType<typeof fixture>>) => writeFile(join(value.profileRoot, 'cordis.patch.yml'), 'changed\n')],
    ['unsafe manifest', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(join(value.web, 'package.json'), 0o666)],
    ['unsafe ordinary plugin-tree entry', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.web, 'unsafe.txt'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
  ])('rejects %s without preparing a worker', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it.each([
    ['invalid JSON', '{'],
    ['array root', '[]'],
    ['missing dependencies', '{}'],
    ['array dependencies', '{"dependencies":[]}'],
  ])('rejects a manifest with %s', async (_name, manifest) => {
    const value = await fixture()
    await writeFile(join(value.web, 'package.json'), manifest)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('classifies file and link-shaped dependencies but rejects a link outside any DSH runtime', async () => {
    const value = await fixture()
    const file = join(value.currentRuntime, 'file-plugin')
    await writeFile(file, 'plugin')
    await symlink(file, join(value.web, 'node_modules', 'file-plugin'))
    const intermediate = join(value.currentRuntime, 'link-plugin')
    await symlink(file, intermediate)
    await symlink(intermediate, join(value.web, 'node_modules', 'link-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ compatibility: 'current' })
    const outside = join(value.hostRoot, 'outside-plugin')
    await writeFile(outside, 'outside')
    await symlink(outside, join(value.web, 'node_modules', 'outside'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects dependencies split across two legacy runtimes', async () => {
    const value = await fixture(true)
    const other = join(value.hostRoot, 'other', 'dsh-runtime', 'app', 'node_modules', 'other-plugin')
    await mkdir(other, { recursive: true })
    await symlink(other, join(value.web, 'node_modules', 'other-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('binds plan replacement and rejects missing, cross-Profile, changed-runtime, and stale-link plans', async () => {
    const value = await fixture(true)
    const first = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nchanged: true\n')
    const second = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await expect(value.inspector.prepareConfirmedProfile(profile(), first))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await expect(value.inspector.prepareConfirmedProfile(
      { ...profile(), profileId: '018f0f4c-87f8-4e2d-a2f8-7b93d34e3159' as PersonProfileRecord['profileId'] },
      second,
    )).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await writeFile(join(value.legacyRuntime, 'changed'), 'after-inspection')
    await expect(value.inspector.prepareConfirmedProfile(profile(), second))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })

    const fresh = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    const dependencyPath = join(value.web, 'node_modules', 'fixture-plugin')
    await unlink(dependencyPath)
    await symlink(join(value.legacyRuntime, 'node_modules', 'different'), dependencyPath)
    await expect(value.inspector.prepareConfirmedProfile(profile(), fresh))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it('rewrites internal absolute runtime links and reuses a verified published closure', async () => {
    const value = await fixture(true)
    const internalTarget = join(value.legacyRuntime, 'node_modules', 'fixture-plugin')
    await symlink(internalTarget, join(value.legacyRuntime, 'internal-link'))
    await symlink('node_modules/fixture-plugin', join(value.legacyRuntime, 'relative-link'))
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(value.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = dependency.slice(0, dependency.indexOf('/node_modules/'))
    expect(await readlink(join(publishedApp, 'internal-link'))).toBe(join(publishedApp, 'node_modules', 'fixture-plugin'))
    expect(await readlink(join(publishedApp, 'relative-link'))).toBe('node_modules/fixture-plugin')
    await expect(value.inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
  })

  it.each([
    ['escaping runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside'); await writeFile(outside, 'outside')
      await symlink(outside, join(value.currentRuntime, 'escape'))
    }],
    ['runtime link escaping through an internal hop', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside-directory')
      await mkdir(outside)
      await writeFile(join(outside, 'plugin.js'), 'outside')
      await symlink(outside, join(value.currentRuntime, 'internal-hop'))
      await symlink('internal-hop/plugin.js', join(value.currentRuntime, 'escape-through-hop'))
    }],
    ['broken internal runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await symlink('missing-plugin', join(value.currentRuntime, 'broken-internal'))
    }],
    ['unsafe runtime directory', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(value.currentRuntime, 'node_modules'), 0o777)
    }],
    ['unsafe runtime file', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.currentRuntime, 'unsafe'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
    ['special runtime inode', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const server = createServer()
      onTestFinished(async () => {
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(join(value.currentRuntime, 'socket'), resolve)
      })
      await symlink(join(value.currentRuntime, 'socket'), join(value.web, 'node_modules', 'socket-plugin'))
    }],
  ])('rejects %s during runtime content inspection', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('blocks a Profile-contained dependency whose runtime compatibility cannot be proven', async () => {
    const value = await fixture()
    await unlink(join(value.web, 'node_modules', 'fixture-plugin'))
    await mkdir(join(value.web, 'node_modules', 'fixture-plugin'))
    const containedPlugin = join(value.web, 'contained-plugin')
    await mkdir(containedPlugin)
    await symlink(containedPlugin, join(value.web, 'node_modules', 'contained-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({
        state: 'compatibility_blocked',
        compatibility: 'read_only_export_only',
        pluginCount: 1,
        reasonCode: 'dsh_recovery_runtime_incompatible',
      })
  })

  it('rejects a published closure whose directory name does not match its content digest', async () => {
    const value = await fixture()
    const closure = join(value.profileRoot, 'runtime-compat', 'closures', 'a'.repeat(64), 'app')
    const plugin = join(closure, 'node_modules', 'published-plugin')
    await mkdir(plugin, { recursive: true })
    await symlink(plugin, join(value.web, 'node_modules', 'published-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('redacts unexpected adapter errors as Profile integrity failures', async () => {
    const value = await fixture()
    const inspector = new OfflineProfileRecoveryInspector({
      hostRoot: value.hostRoot, installationId, expectedUid: uid,
      currentRuntimeAppRoot: value.currentRuntime,
      targetFor: () => ({ inspectExistingPersistence: async () => { throw new Error('private path') } }) as never,
      ownerStateApplicator: value.ownerStateApplicator,
    })
    try {
      await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
      throw new Error('expected inspection to reject')
    } catch (error) {
      expect(error).toMatchObject({ code: 'profile_integrity_failed' })
      expect(String(error)).not.toContain('private path')
    }
  })

  it('rejects a corrupted or unsafe already-published closure on retry', async () => {
    const first = await fixture(true)
    const inspected = await first.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await first.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(first.web, 'node_modules', 'fixture-plugin'))
    await writeFile(join(dependency, 'corrupt'), 'corrupt')
    await expect(first.inspector.prepareConfirmedProfile(profile(), inspected))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })

    const second = await fixture(true)
    const secondInspection = await second.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await second.inspector.prepareConfirmedProfile(profile(), secondInspection)
    const secondDependency = await readlink(join(second.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = secondDependency.slice(0, secondDependency.indexOf('/node_modules/'))
    await chmod(publishedApp, 0o777)
    await expect(second.inspector.prepareConfirmedProfile(profile(), secondInspection))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })
})
