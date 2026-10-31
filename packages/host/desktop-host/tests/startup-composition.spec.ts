import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parseHostCollaborationSourceTarget, parseHostGroupInputFenceChallenge } from '@deepseek-ai/dsh-host-control-protocol'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { UnixHostServer, UnixHostServerOptions } from '../src/unix-transport.ts'
import type { Config } from '../src/startup.ts'
import type { ProfileWorkerHandle, ProfileWorkerSpec } from '../src/types.ts'
import { FileProfileClaimMarkerFiles, ProfileClaimMarker } from '../src/legacy-claim-marker.ts'
import { FileLegacyClaimEventStore } from '../src/legacy-claim-store.ts'
import { LegacyClaimLedger } from '../src/legacy-claim-ledger.ts'
import { FileLegacyClaimRecoveryFiles } from '../src/legacy-claim-recovery-files.ts'
import { LegacyClaimRecoveryStore } from '../src/legacy-claim-recovery.ts'
import { FileLegacyClaimTargetFiles } from '../src/legacy-claim-target-files.ts'
import { LegacyClaimTarget } from '../src/legacy-claim-target.ts'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'

const mocks = vi.hoisted(() => ({
  loadProfileDirectory: vi.fn(() => ({ layers: [], patches: [] })),
  loadOverlayPatches: vi.fn(() => []),
  pluginCommand: vi.fn(async (_input: unknown) => undefined),
  pluginRuntime: vi.fn(async () => undefined),
  pluginEntries: vi.fn<() => { entryId: string; moduleName: string }[]>(() => []),
  composedIds: vi.fn((_layers: unknown, _overrides: unknown): ReadonlySet<string> => new Set<string>()),
  pluginTogglePlan: vi.fn((_layers: unknown, patch: string, _overrides: unknown, _name: string, enabled: boolean) => ({
    patch: enabled ? patch : '- id: startup-tool\n  disabled: true\n',
    previousExpected: [{ entryId: 'include:startup-tool', moduleName: 'startup-tool' }],
    previousDisabled: [],
    expected: enabled ? [{ entryId: 'include:startup-tool', moduleName: 'startup-tool' }] : [],
    disabled: enabled ? [] : [{ entryId: 'include:startup-tool', moduleName: 'startup-tool' }],
  })),
  mcpRuntime: vi.fn<(
    options: unknown, profileId: string, signal: AbortSignal, entryIds: readonly string[],
    guard: () => void, removedIds: readonly string[],
  ) => Promise<void>>(async () => undefined),
  skillCatalog: vi.fn(async () => ({ complete: true, skills: [] })),
  skillRuntime: vi.fn<(worker: unknown, name: string, signal: AbortSignal) => Promise<unknown>>(async () => null),
  recoveryInspect: vi.fn(async (_profile: unknown, _expected: unknown) => ({
    state: 'recoverable' as const,
    persistenceGeneration: 1,
    sessionCount: 0,
    pluginCount: 0,
    compatibility: 'current' as const,
    preflightDigest: 'a'.repeat(64),
  })),
  recoveryPrepare: vi.fn(async (_profile: unknown, _preflight: unknown) => undefined),
  packagedRuntimeAppRoot: vi.fn(() => '/fixture/runtime-app'),
  pluginOptions: undefined as ConstructorParameters<typeof import('../src/profile-plugin-executor.ts').ProfilePluginExecutor>[0] | undefined,
  verifyRollback: vi.fn(async () => ({ spec: 'bundled:ds-bot@0.2.10', digest: 'd'.repeat(64) })),
  verifyTarget: vi.fn(async () => 'e'.repeat(64)),
  captureTree: vi.fn(() => ({ bytes: Buffer.from('tree'), digest: 'f'.repeat(64) })),
  prepareUpgrade: vi.fn(async () => ({ patch: '[]\n', patches: [] })),
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadProfileDirectory: mocks.loadProfileDirectory,
  loadOverlayPatches: mocks.loadOverlayPatches,
}))
vi.mock('../src/plugin-command.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-command.ts')>(),
  runProfilePluginCommand: mocks.pluginCommand,
}))
vi.mock('../src/profile-plugin-executor.ts', async (load) => {
  const actual = await load<typeof import('../src/profile-plugin-executor.ts')>()
  return { ...actual, ProfilePluginExecutor: class extends actual.ProfilePluginExecutor {
    constructor(options: ConstructorParameters<typeof actual.ProfilePluginExecutor>[0]) {
      super(options); mocks.pluginOptions = options
    }
  } }
})
vi.mock('../src/bundled-plugin-recovery.ts', async load => ({
  ...await load<typeof import('../src/bundled-plugin-recovery.ts')>(),
  verifyProfileRollbackArchive: mocks.verifyRollback, verifyCopiedBundledPlugin: mocks.verifyTarget,
}))
vi.mock('../src/plugin-tree-snapshot.ts', async load => ({
  ...await load<typeof import('../src/plugin-tree-snapshot.ts')>(), capturePluginTree: mocks.captureTree,
}))
vi.mock('../src/plugin-upgrade-plan.ts', async load => ({
  ...await load<typeof import('../src/plugin-upgrade-plan.ts')>(), prepareBundledPluginUpgrade: mocks.prepareUpgrade,
}))
vi.mock('../src/plugin-runtime-ack.ts', () => ({ waitForPluginRuntime: mocks.pluginRuntime }))
vi.mock('../src/plugin-bundle-entries.ts', () => ({ pluginBundleEntries: mocks.pluginEntries, composedEntryIds: mocks.composedIds }))
vi.mock('../src/plugin-toggle-plan.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-toggle-plan.ts')>(),
  planPluginToggle: mocks.pluginTogglePlan,
}))
vi.mock('../src/mcp-runtime-ack.ts', () => ({ reloadProfileMcpRuntime: mocks.mcpRuntime }))
vi.mock('../src/skill-worker-client.ts', () => ({
  readProfileSkillCatalog: mocks.skillCatalog,
  readProfileSkillRuntime: mocks.skillRuntime,
}))
vi.mock('../src/offline-profile-recovery.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/offline-profile-recovery.ts')>()
  return {
    ...actual,
    OfflineProfileRecoveryInspector: class {
      inspect(profile: unknown, expected: unknown) { return mocks.recoveryInspect(profile, expected) }
      prepareConfirmedProfile(profile: unknown, preflight: unknown) { return mocks.recoveryPrepare(profile, preflight) }
    },
    packagedRuntimeAppRoot: mocks.packagedRuntimeAppRoot,
  }
})

const NOW = 1_780_000_000_000

function accountToken(key: KeyObject, subject: string): string {
  const issuedAt = Math.floor(NOW / 1_000)
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256', kid: 'fixture', typ: 'dsh-access+jwt',
  })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ag: 1, aud: 'dsh-host', exp: issuedAt + 600, iat: issuedAt,
    iss: 'https://accounts.dsh.colorbuyai.com', jti: randomUUID(), kg: 1, nbf: issuedAt,
    sg: 1, sid: randomUUID(), sub: subject, typ: 'dsh-access+jwt',
  })).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${sign('sha256', Buffer.from(input, 'ascii'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

const BUNDLED_ARCHIVE = Buffer.from('bundled duet archive')
const BUNDLED_DIGEST = createHash('sha256').update(BUNDLED_ARCHIVE).digest('hex')
function fixture(): { config: Config; root: string; accountPrivateKey: KeyObject } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-composition-'))
  const artifact = join(root, 'runtime-artifact')
  const deviceKey = join(root, 'device-index.key')
  const accountKeyringPath = join(root, 'account-keyring.json')
  const installationPrivateKeyPath = join(root, 'installation-private.pem')
  const account = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const installation = generateKeyPairSync('ed25519')
  const keyring = `${JSON.stringify({
    version: 2,
    issuer: 'https://accounts.dsh.colorbuyai.com',
    keys: [{ kid: 'fixture', publicJwk: account.publicKey.export({ format: 'jwk' }) }],
  })}\n`
  writeFileSync(artifact, 'fixture', { mode: 0o700 })
  const bundledPluginsRoot = join(root, 'bundled-plugins'); mkdirSync(bundledPluginsRoot, { mode: 0o755 })
  writeFileSync(join(bundledPluginsRoot, 'dsh-duet-0.3.0.tgz'), BUNDLED_ARCHIVE, { mode: 0o644 })
  const botArchive = Buffer.from('bundled bot archive'); const botDigest = createHash('sha256').update(botArchive).digest('hex')
  writeFileSync(join(bundledPluginsRoot, 'ds-bot-0.2.16.tgz'), botArchive, { mode: 0o644 })
  writeFileSync(join(bundledPluginsRoot, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [{
    name: 'dsh-duet', version: '0.3.0', file: 'dsh-duet-0.3.0.tgz', sha256: BUNDLED_DIGEST,
    repository: 'https://github.com/qiudl/dsh-duet.git', sourceSha: 'c'.repeat(40), entryIds: ['duplex-harness-control'] }, {
    name: 'ds-bot', version: '0.2.16', file: 'ds-bot-0.2.16.tgz', sha256: botDigest,
    repository: 'https://github.com/qiudl/ds-bot.git', sourceSha: 'd'.repeat(40), entryIds: ['bot', 'web-search-auto'] }] }), { mode: 0o644 })
  writeFileSync(deviceKey, Buffer.alloc(32, 7), { mode: 0o600 })
  writeFileSync(accountKeyringPath, keyring, { mode: 0o600 })
  writeFileSync(installationPrivateKeyPath,
    installation.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const installationPublicKey = (installation.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    .subarray(-32).toString('base64url')
  return {
    root,
    accountPrivateKey: account.privateKey,
    config: {
      root,
      registrationRoot: join(root, 'registration'),
      nodeExecutablePath: artifact,
      dshEntrypointPath: artifact,
      pnpmEntrypointPath: artifact,
      bundledPluginsRoot,
      deviceIndexKeyPath: deviceKey,
      accountKeyringPath,
      accountKeyringSha256: createHash('sha256').update(keyring).digest('hex'),
      installationPrivateKeyPath,
      installationPublicKey,
      installationId: randomUUID(),
      endpointRegistrationId: randomUUID(),
      hostInstanceId: randomUUID(),
      processNonce: Buffer.alloc(32, 8).toString('base64url'),
      executableSignatureDigest: '1'.repeat(64),
      desktopTeamIdentifiers: ['TEAM123'],
      desktopExecutableDigests: ['2'.repeat(64)],
      runtimeGeneration: 3,
      schemaGeneration: 1,
      legacySourceQuiescent: true,
    },
  }
}

it.skipIf(process.platform === 'win32')('wires profile, extension, and migration owners into one disposable application', async () => {
  const { config, root, accountPrivateKey } = fixture()
  const cleanup = { closeApplication: undefined as (() => Promise<void>) | undefined }
  let manifestRequests = 0
  const fetchManifest = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== 'https://registry.npmjs.org/startup-plugin/1.0.0') throw new Error(`unexpected request: ${url}`)
    manifestRequests += 1
    return new Response(JSON.stringify({ name: 'startup-plugin', version: '1.0.0',
      ...(manifestRequests === 1 ? { scripts: { postinstall: 'node build.js' } } : {}) }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchManifest)
  onTestFinished(async () => {
    await cleanup.closeApplication?.()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, '.dsh/sessions'), { recursive: true, mode: 0o700 })
  vi.stubEnv('HOME', root)
  let serverOptions: UnixHostServerOptions | undefined
  const workerSpecs: ProfileWorkerSpec[] = []
  const workerEvents: string[] = []
  const generateText = vi.fn(async (text: string, _signal: AbortSignal) => ({
    provider: 'deepseek', model: 'deepseek-chat', text: `answer: ${text}`,
  }))
  const sourceTarget = parseHostCollaborationSourceTarget({ workspace_id: randomUUID(), session_id: 'original',
    source_message_id: 'message', source_revision: '1' })
  const sourceDescriptor = { ...sourceTarget, snapshot_digest: 'a'.repeat(64) }
  const sourceSnapshot = { descriptor: sourceDescriptor, snapshot_json: JSON.stringify({ ...sourceTarget,
    original_message: '@Guide · Project repair', active_mentions: [], model_snapshot: { provider: 'deepseek', model: 'chat' },
    host_journal_commit: { journal_id: 'journal', commit_version: '1', content_digest: 'b'.repeat(64) },
  }) }
  const inspectWorkspaceModelSelection = vi.fn<NonNullable<ProfileWorkerHandle['inspectWorkspaceModelSelection']>>(
    async target => ({ ...target, provider: 'deepseek', model: 'chat' }))
  const resolveBotIdentity = vi.fn<NonNullable<ProfileWorkerHandle['resolveBotIdentity']>>(
    async botId => ({ bot_id: botId, actor_ref: `deepseek-bot:${botId}`, display_name: 'My Bot' }))
  const listBotRoster = vi.fn<NonNullable<ProfileWorkerHandle['listBotRoster']>>(
    async () => ({ bots: [{ bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1',
      display_name: 'My Bot' }], next_cursor: null }))
  const inspectCollaborationArchiveState = vi.fn<NonNullable<ProfileWorkerHandle['inspectCollaborationArchiveState']>>(
    async () => ({ archive_phase: 'archived' }))
  const inspectCollaborationArchiveIntent = vi.fn<NonNullable<ProfileWorkerHandle['inspectCollaborationArchiveIntent']>>(
    async () => ({ archive_phase: 'missing', archive_token: null }))
  const transitionCollaborationArchive = vi.fn<NonNullable<ProfileWorkerHandle['transitionCollaborationArchive']>>(
    async () => ({ archive_phase: 'staged' }))
  const installGroupInputFence = vi.fn<NonNullable<ProfileWorkerHandle['installGroupInputFence']>>(
    async challenge => ({ workspace_id: challenge.workspace_id, session_id: challenge.session_id,
      group_id: challenge.group_id, group_version: challenge.group_version }))
  const inspectCollaborationSource = vi.fn<NonNullable<ProfileWorkerHandle['inspectCollaborationSource']>>(
    async () => sourceDescriptor)
  const readCollaborationSourceSnapshot = vi.fn<NonNullable<ProfileWorkerHandle['readCollaborationSourceSnapshot']>>(
    async () => sourceSnapshot)
  const collaborationAnalysis = vi.fn<NonNullable<ProfileWorkerHandle['collaborationAnalysis']>>(async command => command)
  const receiveCollaborationDelivery = vi.fn<NonNullable<ProfileWorkerHandle['receiveCollaborationDelivery']>>(async () => null)
  const serverStart = vi.fn(async () => undefined)
  const serverClose = vi.fn(async () => undefined)
  const server = {
    start: serverStart,
    close: serverClose,
  } as unknown as UnixHostServer
  const profileWorkerFactory = async (spec: ProfileWorkerSpec): Promise<ProfileWorkerHandle> => {
    workerSpecs.push(spec)
    if (spec.credentialHandle === 'keychain:startup') {
      mkdirSync(join(spec.profileRoot, 'profiles/web'), { recursive: true, mode: 0o700 })
      const manifest = join(spec.profileRoot, 'profiles/web/package.json')
      if (!existsSync(manifest)) {
        writeFileSync(manifest, JSON.stringify({
          dependencies: {}, dsh: { profile: { bundles: [] } },
        }), { mode: 0o600 })
      }
    }
    let rejectDone: ((error: Error) => void) | undefined
    const done = spec.credentialHandle === 'keychain:account-startup'
      ? new Promise<void>((_resolve, reject) => { rejectDone = reject })
      : Promise.resolve()
    return {
      viewOrigin: 'http://127.0.0.1:43123',
      generation: workerSpecs.length,
      bootstrapCookie: { name: 'fixture', value: 'private' },
      generateText, resolveBotIdentity, listBotRoster,
      inspectWorkspaceModelSelection, inspectCollaborationArchiveState, inspectCollaborationArchiveIntent,
      transitionCollaborationArchive,
      installGroupInputFence,
      inspectCollaborationSource, readCollaborationSourceSnapshot,
      collaborationAnalysis, receiveCollaborationDelivery,
      closeNotifications: () => { workerEvents.push(`notifications:${spec.profileId}`) },
      abort: () => { workerEvents.push(`abort:${spec.profileId}`); rejectDone?.(new Error('worker exit failed')) },
      done,
    }
  }
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin',
    profileWorkerFactory,
    attestPeer: async () => ({ uid: process.getuid!(), executableSignatureDigest: '2'.repeat(64) }),
    createServer: (options) => { serverOptions = options; return server },
  })
  cleanup.closeApplication = () => application.close()
  expect(serverStart).toHaveBeenCalledOnce()
  expect(application.restrictedHistory).toBeUndefined()
  if (!serverOptions) throw new Error('missing captured server options')
  const capturedServerOptions = serverOptions
  expect(await serverOptions.inspectModelClaimSource?.()).toMatchObject({ candidates: [] })
  expect(await serverOptions.inspectModelClaimSource?.(new AbortController().signal)).toMatchObject({ candidates: [] })

  const profile = await application.host.bootstrapLocalProfile({
    keyHandle: 'keychain:startup', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ownerId: 'owner',
  })
  const packagesRoot = join(root, 'profiles', profile.profileId, 'skillhub-packages')
  mkdirSync(packagesRoot, { mode: 0o700 })
  expect(() => capturedServerOptions.createSkillHubPackageStore?.(randomUUID(), '1', 'a'.repeat(64)))
    .toThrow()
  expect(await serverOptions.createSkillHubPackageStore?.(profile.profileId, '1', 'a'.repeat(64)))
    .toBeDefined()
  expect(serverOptions.modelClaimRecovery?.status({ candidateId: 'llm-deepseek:deepseek',
    authorizeAccountProfile: () => profile.profileId })).toBeNull()
  expect(serverOptions.modelClaimRecovery?.pendingReceipts({
    authorizeAccountProfile: () => profile.profileId,
  })).toEqual([])
  expect(serverOptions.modelClaimTransaction).toBeDefined()
  expect(serverOptions.modelClaimTransaction?.retry).toBeDefined()
  expect(workerSpecs).toHaveLength(1)
  const fencePath = join(root, 'restricted-fences', `${profile.profileId}.json`)
  writeFileSync(fencePath, JSON.stringify({ version: 1, profileId: profile.profileId,
    operationId: randomUUID(), state: 'pending' }), { mode: 0o600 })
  expect(application.workers.isProfileBlocked(profile.profileId)).toBe(true)
  await expect(application.workers.withPreparation(profile.profileId, async () => {}))
    .rejects.toMatchObject({ code: 'unavailable' })
  unlinkSync(fencePath)
  const opened = await application.host.openLocalProfile({ profileId: profile.profileId, ownerId: 'owner' })
  expect((await application.host.activateView({
    ...opened,
    ownerId: 'owner',
  })).origin).toBe('http://127.0.0.1:43123')
  const pluginOptions = mocks.pluginOptions
  if (!pluginOptions || !pluginOptions.upgradePlan || !pluginOptions.rollbackUpgrade
    || !pluginOptions.verifyUpgradeTarget || !pluginOptions.verifyRollbackTree || !pluginOptions.verifyRetainedRollbackTree) {
    throw Error('missing bundled upgrade capabilities')
  }
  const signal = new AbortController().signal
  const lifetime = { kind: 'plugin' as const, signal, guard() {} }
  const profileRoot = join(root, 'profiles', profile.profileId)
  const homePatch = join(profileRoot, 'cordis.patch.yml')
  if (existsSync(homePatch)) unlinkSync(homePatch)
  mocks.loadProfileDirectory.mockReturnValueOnce({ layers: [], patches: [], skippedBundles: [] } as never)
  mocks.pluginEntries.mockReturnValueOnce([]).mockReturnValueOnce([
    { entryId: 'include:bot', moduleName: 'ds-bot' }, { entryId: 'include:web-search-auto', moduleName: 'ds-bot/web-search' },
  ])
  await expect(pluginOptions.upgradePlan(profile.profileId, 'ds-bot', 'bundled:ds-bot@0.2.16', '[]\n', 'file:old.tgz'))
    .resolves.toMatchObject({ patch: '[]\n', rollback: { spec: 'bundled:ds-bot@0.2.10' } })
  await expect(pluginOptions.upgradePlan(profile.profileId, 'other', 'bundled:other@0.2.16', '[]\n', 'file:old.tgz'))
    .rejects.toThrow('upgrade_required')
  const catalogGet = vi.spyOn(BundledPluginCatalog.prototype, 'get').mockReturnValueOnce(undefined)
  await expect(pluginOptions.upgradePlan(profile.profileId, 'ds-bot', 'bundled:ds-bot@0.2.16', '[]\n', 'file:old.tgz'))
    .rejects.toThrow('bundled_plugin_unavailable')
  catalogGet.mockRestore()
  mocks.loadProfileDirectory.mockReturnValueOnce({ layers: [], patches: [], skippedBundles: [{}] } as never)
  await expect(pluginOptions.upgradePlan(profile.profileId, 'ds-bot', 'bundled:ds-bot@0.2.16', '[]\n', 'file:old.tgz'))
    .rejects.toThrow('plugin_bundle_missing')
  mocks.loadProfileDirectory.mockReturnValueOnce({ layers: [], patches: [], skippedBundles: [] } as never)
  mocks.prepareUpgrade.mockResolvedValueOnce({ patch: '[', patches: [] })
  await expect(pluginOptions.upgradePlan(profile.profileId, 'ds-bot', 'bundled:ds-bot@0.2.16', '[]\n', 'file:old.tgz'))
    .rejects.toThrow('invalid_patch')
  mocks.loadProfileDirectory.mockReturnValueOnce({ layers: [
    { packageName: 'ds-bot', patches: [] }, { packageName: 'base', patches: [] },
  ], patches: [], skippedBundles: [] } as never)
  writeFileSync(homePatch, '[]\n', { mode: 0o600 })
  mocks.pluginEntries.mockReturnValueOnce([]).mockReturnValueOnce([])
  await expect(pluginOptions.upgradePlan(profile.profileId, 'ds-bot', 'bundled:ds-bot@0.2.16', '[]\n', 'file:old.tgz'))
    .rejects.toThrow('plugin_entry_conflict')
  const upgrade = { operationId: randomUUID(), beforeDigest: 'a'.repeat(64), afterDigest: 'b'.repeat(64),
    rollbackSpec: 'bundled:ds-bot@0.2.10', rollbackDigest: 'd'.repeat(64), treeDigest: 'c'.repeat(64) }
  await expect(pluginOptions.rollbackUpgrade(profileRoot, upgrade, lifetime)).resolves.toBe('f'.repeat(64))
  await expect(pluginOptions.verifyRollbackTree(profileRoot, upgrade, lifetime)).resolves.toBe('f'.repeat(64))
  await expect(pluginOptions.verifyRetainedRollbackTree(profileRoot, upgrade, '/retained', lifetime)).resolves.toBe('f'.repeat(64))
  await expect(pluginOptions.rollbackUpgrade(profileRoot, { ...upgrade, rollbackSpec: 'invalid' }, lifetime)).rejects.toThrow('invalid_recovery')
  await expect(pluginOptions.verifyRollbackTree(profileRoot, { ...upgrade, rollbackSpec: 'invalid' }, lifetime)).rejects.toThrow('invalid_recovery')
  await expect(pluginOptions.verifyRetainedRollbackTree(profileRoot, { ...upgrade, rollbackSpec: 'invalid' }, '/retained', lifetime))
    .rejects.toThrow('invalid_recovery')
  mocks.verifyRollback.mockResolvedValueOnce({ spec: 'bundled:ds-bot@0.2.9', digest: 'd'.repeat(64) })
  await expect(pluginOptions.rollbackUpgrade(profileRoot, upgrade, lifetime)).rejects.toThrow('invalid_recovery')
  mocks.verifyRollback.mockResolvedValueOnce({ spec: 'bundled:ds-bot@0.2.9', digest: 'd'.repeat(64) })
  await expect(pluginOptions.verifyRollbackTree(profileRoot, upgrade, lifetime)).rejects.toThrow('invalid_recovery')
  mocks.verifyRollback.mockResolvedValueOnce({ spec: 'bundled:ds-bot@0.2.9', digest: 'd'.repeat(64) })
  await expect(pluginOptions.verifyRetainedRollbackTree(profileRoot, upgrade, '/retained', lifetime)).rejects.toThrow('invalid_recovery')
  await expect(pluginOptions.verifyUpgradeTarget(profileRoot, 'bundled:ds-bot@0.2.16', lifetime)).resolves.toBeUndefined()
  await expect(pluginOptions.verifyUpgradeTarget(profileRoot, 'bundled:other@0.2.16', lifetime)).rejects.toThrow('bundled_plugin_unavailable')
  mocks.pluginCommand.mockClear(); mocks.pluginEntries.mockClear()
  const tree = (directory: string): unknown[] => readdirSync(directory).sort().map((name) => {
    const path = join(directory, name), metadata = lstatSync(path)
    return [name, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs,
      metadata.isSymbolicLink() ? readlinkSync(path)
        : metadata.isDirectory() ? tree(path) : createHash('sha256').update(readFileSync(path)).digest('hex')]
  })
  const beforeMissing = tree(root)
  expect(serverOptions.recoveryMaterialsPersistenceGeneration).toBeDefined()
  await expect(serverOptions.recoveryMaterialsPersistenceGeneration?.(randomUUID(), new AbortController().signal))
    .rejects.toThrow()
  expect(tree(root)).toEqual(beforeMissing)
  const aborted = new AbortController()
  aborted.abort()
  await expect(serverOptions.recoveryMaterialsPersistenceGeneration?.(profile.profileId, aborted.signal)).rejects.toThrow()
  expect(tree(root)).toEqual(beforeMissing)
  expect(await serverOptions.profilePersistenceGeneration(profile.profileId)).toBe(1)
  const beforeExisting = tree(root)
  await expect(serverOptions.recoveryMaterialsPersistenceGeneration?.(profile.profileId, new AbortController().signal))
    .resolves.toBe(1)
  expect(tree(root)).toEqual(beforeExisting)
  const cancelledRead = new AbortController()
  const inspect = vi.spyOn(FileOwnerJsonlMigrationGenerationTarget.prototype, 'inspectExistingPersistence')
  inspect.mockImplementationOnce(async function (this: FileOwnerJsonlMigrationGenerationTarget) {
    // The one-shot hook is consumed before this call, so it reaches the original disk reader.
    const existing = await this.inspectExistingPersistence()
    cancelledRead.abort()
    return existing
  })
  try {
    await expect(serverOptions.recoveryMaterialsPersistenceGeneration?.(profile.profileId, cancelledRead.signal))
      .rejects.toThrow(expect.objectContaining({ name: 'AbortError' }))
  } finally { inspect.mockRestore() }
  expect(tree(root)).toEqual(beforeExisting)
  await expect(serverOptions.generateModelText?.(profile.profileId, 'question', new AbortController().signal))
    .resolves.toEqual({ provider: 'deepseek', model: 'deepseek-chat', text: 'answer: question' })
  expect(generateText).toHaveBeenCalledWith('question', expect.any(AbortSignal))
  const collaborationSignal = new AbortController().signal
  await expect(serverOptions.resolveBotIdentity?.(profile.profileId, 'bot_1', collaborationSignal))
    .resolves.toEqual({ bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' })
  expect(resolveBotIdentity).toHaveBeenCalledWith('bot_1', collaborationSignal)
  await expect(serverOptions.listBotRoster?.(profile.profileId, '', 50, collaborationSignal))
    .resolves.toEqual({ bots: [{ bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1',
      display_name: 'My Bot' }], next_cursor: null })
  expect(listBotRoster).toHaveBeenCalledWith('', 50, collaborationSignal)
  const selectionTarget = { workspace_id: sourceTarget.workspace_id, session_id: sourceTarget.session_id }
  await expect(serverOptions.inspectWorkspaceModelSelection?.(profile.profileId, selectionTarget, collaborationSignal))
    .resolves.toEqual({ ...selectionTarget, provider: 'deepseek', model: 'chat' })
  expect(inspectWorkspaceModelSelection).toHaveBeenCalledWith(selectionTarget, collaborationSignal)
  const archiveTarget = { ...selectionTarget, archive_token: randomUUID(),
    environment_id: randomUUID(), account_issuer: 'issuer', account_subject: 'subject' }
  await expect(serverOptions.inspectCollaborationArchiveState?.(profile.profileId, archiveTarget, collaborationSignal))
    .resolves.toEqual({ archive_phase: 'archived' })
  expect(inspectCollaborationArchiveState).toHaveBeenCalledWith(archiveTarget, collaborationSignal)
  const intentTarget = { workspace_id: archiveTarget.workspace_id, session_id: archiveTarget.session_id,
    environment_id: archiveTarget.environment_id, account_issuer: archiveTarget.account_issuer,
    account_subject: archiveTarget.account_subject }
  await expect(serverOptions.inspectCollaborationArchiveIntent?.(profile.profileId, intentTarget, collaborationSignal))
    .resolves.toEqual({ archive_phase: 'missing', archive_token: null })
  expect(inspectCollaborationArchiveIntent).toHaveBeenCalledWith(intentTarget, collaborationSignal)
  const transitionTarget = { ...archiveTarget, action: 'stage' as const }
  await expect(serverOptions.transitionCollaborationArchive?.(profile.profileId, transitionTarget, collaborationSignal))
    .resolves.toEqual({ archive_phase: 'staged' })
  expect(transitionCollaborationArchive).toHaveBeenCalledWith(transitionTarget, collaborationSignal)
  const challenge = parseHostGroupInputFenceChallenge({
    request_id: '10000000-0000-4000-8000-000000000001', challenge_nonce: 'A'.repeat(43),
    expires_at: 2000, audience: 'https://slark.example.test',
    environment_id: archiveTarget.environment_id, account_issuer: 'https://accounts.example.test',
    account_subject: '30000000-0000-4000-8000-000000000003', workspace_id: archiveTarget.workspace_id,
    session_id: archiveTarget.session_id,
    group_id: '70000000-0000-4000-8000-000000000007', group_version: 1,
  })
  await expect(serverOptions.installGroupInputFence?.(profile.profileId, challenge, collaborationSignal))
    .resolves.toEqual({ workspace_id: challenge.workspace_id, session_id: challenge.session_id,
      group_id: challenge.group_id, group_version: challenge.group_version })
  expect(installGroupInputFence).toHaveBeenCalledWith(challenge, collaborationSignal)
  await expect(serverOptions.inspectCollaborationSource?.(profile.profileId, sourceTarget, collaborationSignal))
    .resolves.toEqual(sourceDescriptor)
  expect(inspectCollaborationSource).toHaveBeenCalledWith(sourceTarget, collaborationSignal)
  await expect(serverOptions.readCollaborationSourceSnapshot?.(profile.profileId, sourceTarget, collaborationSignal))
    .resolves.toEqual(sourceSnapshot)
  expect(readCollaborationSourceSnapshot).toHaveBeenCalledWith(sourceTarget, collaborationSignal)
  const analysisCommand = { action: 'prepare', input: { source_message_id: sourceTarget.source_message_id } }
  await expect(serverOptions.collaborationAnalysis?.(profile.profileId, analysisCommand, collaborationSignal))
    .resolves.toEqual(analysisCommand)
  expect(collaborationAnalysis).toHaveBeenCalledWith(analysisCommand, collaborationSignal)
  const deliveryReceiver = serverOptions.collaborationDeliveryReceiver?.(profile.profileId)
  if (!deliveryReceiver) throw new Error('missing original delivery receiver')
  expect(() => { deliveryReceiver.assertCurrent() }).not.toThrow()
  await expect(serverOptions.inspectCollaborationSource?.(randomUUID(), sourceTarget, collaborationSignal))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(inspectCollaborationSource).toHaveBeenCalledOnce()
  await expect(serverOptions.remoteSession?.(profile.profileId, {
    operation: 'session.list', command_id: randomUUID() as never,
  }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  await expect(serverOptions.remoteUiRead?.(profile.profileId, 'boot/injections', { args: {} },
    new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  const remoteUiStream = serverOptions.remoteUiStream
  if (!remoteUiStream) throw new Error('missing remote UI stream owner')
  expect(() => remoteUiStream(profile.profileId, 'session/follow', { args: {} },
    new AbortController().signal)).toThrow(expect.objectContaining({ code: 'unavailable' }))
  expect(await serverOptions.extensions?.inventory(profile.profileId, 'mcp')).toEqual([])
  expect(await serverOptions.extensions?.inventory(profile.profileId, 'skill')).toEqual([])
  expect(await serverOptions.extensions?.inventory(profile.profileId, 'plugin')).toEqual([])
  await expect(serverOptions.extensions?.inventory(randomUUID(), 'mcp')).rejects.toMatchObject({ code: 'stale' })
  await expect(serverOptions.extensions?.inventory(randomUUID(), 'skill')).rejects.toMatchObject({ code: 'stale' })
  await expect(serverOptions.extensions?.inventory(randomUUID(), 'plugin')).rejects.toMatchObject({ code: 'stale' })

  const operations = serverOptions.extensions?.operations
  if (!operations) throw new Error('missing extension operations')
  const authority = () => profile.profileId
  mocks.mcpRuntime.mockImplementation(async (raw, profileId, _signal, _entryIds, _guard, _removedIds) => {
    const options = raw as { resolveProfile(id: string): unknown }
    expect(options.resolveProfile(profileId)).toBeTruthy()
  })
  const runOperation = async (kind: 'mcp' | 'skill' | 'plugin', payload: string): Promise<void> => {
    const plan = await operations.prepare(authority, kind, payload)
    const operationId = randomUUID()
    operations.commit(authority, plan.planId, operationId, undefined, plan.scriptApproval?.digest)
    await operations.settled()
    const status = operations.status(authority, operationId)
    if (status.state !== 'succeeded') throw new Error(JSON.stringify(status))
  }
  await runOperation('mcp', JSON.stringify({
    mcpServers: { startup: { url: 'https://example.com/mcp' } },
  }))
  mocks.skillRuntime.mockImplementation(async (_worker, name, _signal) => {
    const path = join(workerSpecs.at(-1)!.profileRoot, 'skills', name, 'SKILL.md')
    return {
      path, source: 'user-dsh', name, description: 'Startup composition', whenToUse: undefined,
      content: 'Use this fixture.', invocation: { modelInvocable: true, userInvocable: false },
    }
  })
  await runOperation('skill', JSON.stringify({
    name: 'startup-skill', description: 'Startup composition', body: 'Use this fixture.',
    modelInvocable: true, userInvocable: false,
  }))
  let failRemoval = false
  mocks.pluginCommand.mockImplementation(async (raw) => {
    const input = raw as { profileRoot: string; spec: string; action?: string; allowBuild?: string }
    if (input.action === 'repair') return
    const path = join(input.profileRoot, 'profiles/web/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    const name = input.action === 'remove' ? input.spec : input.spec.replace(/^bundled:/u, '').slice(0, input.spec.replace(/^bundled:/u, '').lastIndexOf('@'))
    if (input.action === 'remove') {
      manifest.dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies).filter(([packageName]) => packageName !== name),
      )
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== name)
    } else {
      manifest.dependencies[name] = input.spec.startsWith('bundled:') ? `file:.bundled-plugins/${BUNDLED_DIGEST}.tgz` : '1.0.0'
      if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
    }
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
    if (input.action === 'remove' && failRemoval) {
      failRemoval = false
      throw new Error('interrupted removal')
    }
  })
  await runOperation('plugin', JSON.stringify({ packageName: 'startup-plugin', spec: 'startup-plugin@1.0.0' }))
  expect(mocks.pluginCommand).toHaveBeenCalledWith(expect.objectContaining({ allowBuild: 'startup-plugin@1.0.0' }))
  await runOperation('plugin', JSON.stringify({
    action: 'toggle', packageName: 'startup-plugin', enabled: false,
  }))
  await runOperation('plugin', JSON.stringify({ action: 'remove', packageName: 'startup-plugin' }))
  await runOperation('plugin', JSON.stringify({ packageName: 'startup-plugin', spec: 'startup-plugin@1.0.0' }))
  expect(fetchManifest).toHaveBeenCalledTimes(2)
  failRemoval = true
  const interruptedPlan = await operations.prepare(authority, 'plugin', JSON.stringify({
    action: 'remove', packageName: 'startup-plugin',
  }))
  const interruptedId = randomUUID()
  operations.commit(authority, interruptedPlan.planId, interruptedId)
  await operations.settled()
  expect(operations.status(authority, interruptedId).state).toBe('unknown')
  await runOperation('plugin', JSON.stringify({ action: 'complete-package', operationId: interruptedId }))
  mocks.composedIds.mockReturnValueOnce(new Set(['duplex-harness-control']))
  await expect(operations.prepare(authority, 'plugin', JSON.stringify({ packageName: 'dsh-duet', spec: 'bundled:dsh-duet@0.3.0' })))
    .rejects.toThrow('plugin_entry_conflict')
  await expect(operations.prepare(authority, 'plugin', JSON.stringify({ packageName: 'dsh-duet', spec: 'bundled:dsh-duet@0.2.7' })))
    .rejects.toThrow('bundled_plugin_unavailable')
  await runOperation('plugin', JSON.stringify({ packageName: 'dsh-duet', spec: 'bundled:dsh-duet@0.3.0' }))
  const bundledArchive = join(root, 'profiles', profile.profileId, 'profiles/web/.bundled-plugins', `${BUNDLED_DIGEST}.tgz`)
  expect(mocks.pluginCommand).toHaveBeenLastCalledWith(expect.objectContaining({ spec: 'bundled:dsh-duet@0.3.0', archivePath: bundledArchive }))
  expect(readFileSync(bundledArchive)).toEqual(BUNDLED_ARCHIVE)
  expect(mocks.mcpRuntime).toHaveBeenCalled()
  expect(mocks.skillRuntime).toHaveBeenCalled()
  expect(mocks.pluginRuntime).toHaveBeenCalled()

  const exporter = await serverOptions.createMigrationExport?.('owner', profile.profileId)
  if (!exporter) throw new Error('missing current exporter')
  let enterExport!: () => void, releaseExport!: () => void
  const exportEntered = new Promise<void>(resolve => { enterExport = resolve })
  const originalApply = MigrationOwnerStateApplicator.prototype.apply
  const applySpy = vi.spyOn(MigrationOwnerStateApplicator.prototype, 'apply').mockImplementationOnce(async function (this: MigrationOwnerStateApplicator, ...args) {
    enterExport()
    await new Promise<void>(resolve => { releaseExport = resolve })
    return originalApply.apply(this, args)
  })
  const pendingInventory = exporter.inventory()
  await exportEntered
  let isolatedEntered = false
  const isolated = application.workers.withQuiescent(profile.profileId, async () => { isolatedEntered = true })
  let inventory: Awaited<typeof pendingInventory>
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(isolatedEntered).toBe(false)
  } finally {
    releaseExport()
    inventory = await pendingInventory
    await isolated
    applySpy.mockRestore()
  }
  expect(inventory.schemaVersion).toBe(0)
  const receipt = await exporter.begin({
    expectedInventoryDigest: inventory.inventoryDigest,
    maxRecords: inventory.requiredMaxRecords,
    maxBytes: inventory.requiredMaxBytes,
  })
  expect(exporter.read({ exportId: receipt.exportId, chunkIndex: 0 }).final).toBe(true)
  expect(() => serverOptions!.createMigrationExport?.('owner', randomUUID())).toThrow('stale')
  expect(workerSpecs.length).toBeGreaterThan(1)

  const legacy = await serverOptions.createLegacyMigrationExport?.('owner', profile.profileId)
  if (!legacy) throw new Error('missing legacy exporter')
  const legacyInventory = await legacy.inventory()
  expect(legacyInventory.schemaVersion).toBe(0)
  const legacyReceipt = await legacy.begin({
    expectedInventoryDigest: legacyInventory.inventoryDigest,
    maxRecords: legacyInventory.requiredMaxRecords,
    maxBytes: legacyInventory.requiredMaxBytes,
  })
  expect(legacy.read({ exportId: legacyReceipt.exportId, chunkIndex: 0 }).final).toBe(true)

  const importer = serverOptions.createMigrationImport?.('owner', profile.profileId)
  if (!importer) throw new Error('missing importer')
  expect(serverOptions.createMigrationImport?.('owner', profile.profileId)).toBeDefined()
  const staged = await importer.stage({
    transferId: receipt.transferId,
    transferDigest: receipt.transferDigest,
    sourceInstallationId: config.installationId,
    sourceInventoryDigest: inventory.inventoryDigest,
    targetProfileSelectorHash: 'a'.repeat(64),
    sourceGeneration: receipt.sourceGeneration,
    sourceSchemaVersion: receipt.schemaVersion,
    targetGeneration: 2,
    recordCount: receipt.recordCount,
    semanticDigest: receipt.semanticDigest,
  })
  expect((await importer.status({
    transferId: receipt.transferId, targetGeneration: 2,
    sourceInstallationId: config.installationId, targetProfileSelectorHash: 'a'.repeat(64),
  })).importId).toBe(staged.importId)
  await importer.commit(staged.importId, staged.version + 1, 1).catch(() => undefined)
  await importer.verify(staged.importId, staged.version)
  const verified = await importer.status({
    transferId: receipt.transferId, targetGeneration: 2,
    sourceInstallationId: config.installationId, targetProfileSelectorHash: 'a'.repeat(64),
  })
  const failedCutover = vi.spyOn(FileOwnerJsonlMigrationGenerationTarget.prototype, 'commitGeneration')
    .mockRejectedValueOnce(new Error('fixture generation switch failed'))
  try {
    await expect(importer.commit(verified.importId, verified.version, 1)).rejects.toThrow('fixture generation switch failed')
    expect((await application.workers.activate(profile.profileId)).origin).toBe('http://127.0.0.1:43123')
  } finally { failedCutover.mockRestore() }
  let enterCommit!: () => void, releaseCommit!: () => void
  const commitEntered = new Promise<void>(resolve => { enterCommit = resolve })
  const originalCommit = FileOwnerJsonlMigrationGenerationTarget.prototype.commitGeneration
  const commitSpy = vi.spyOn(FileOwnerJsonlMigrationGenerationTarget.prototype, 'commitGeneration')
    .mockImplementationOnce(async function (this: FileOwnerJsonlMigrationGenerationTarget, ...args) {
      enterCommit()
      await new Promise<void>(resolve => { releaseCommit = resolve })
      return originalCommit.apply(this, args)
    })
  const pendingCommit = importer.commit(verified.importId, verified.version, 1)
  await commitEntered
  let isolatedDuringCommit = false
  const commitIsolation = application.workers.withQuiescent(profile.profileId, async () => { isolatedDuringCommit = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(isolatedDuringCommit).toBe(false)
  } finally {
    releaseCommit()
    await pendingCommit
    await commitIsolation
    commitSpy.mockRestore()
  }
  await expect(importer.abort(staged.importId, staged.version)).rejects.toThrow()

  const accountSubject = randomUUID()
  const accountUnlock = Buffer.alloc(32, 10).toString('base64url')
  const accountProfile = await application.host.ensureAccountProfile({
    issuer: 'https://accounts.dsh.colorbuyai.com', subject: accountSubject,
    authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:startup', authorityBindingVersion: 1,
    accountAccessToken: accountToken(accountPrivateKey, accountSubject),
    keyHandle: 'keychain:account-startup', unlockMaterial: accountUnlock, ownerId: 'connected-owner',
  })
  application.host.revokeOwner('connected-owner')
  const inspected = await application.host.inspectOfflineAccountProfiles({
    keyHandles: ['keychain:account-startup'], expectedRuntimeGeneration: 3,
    expectedSchemaGeneration: 1, ownerId: 'offline-owner',
  })
  expect(inspected.candidates).toHaveLength(1)
  const candidate = inspected.candidates[0]!
  expect(await application.host.recoverOfflineAccountProfile({
    candidateId: candidate.candidateId,
    preflightDigest: candidate.preflightDigest,
    keyHandle: 'keychain:account-startup', unlockMaterial: accountUnlock,
    operationId: randomUUID(), ownerId: 'offline-owner',
  })).toMatchObject({ state: 'offline_ready', profileId: accountProfile.profileId })

  application.host.revokeOwner('offline-owner')
  const failedInspection = await application.host.inspectOfflineAccountProfiles({
    keyHandles: ['keychain:account-startup'], expectedRuntimeGeneration: 3,
    expectedSchemaGeneration: 1, ownerId: 'retry-owner',
  })
  mocks.recoveryInspect
    .mockResolvedValueOnce({
      state: 'recoverable', persistenceGeneration: 1, sessionCount: 0, pluginCount: 0,
      compatibility: 'current', preflightDigest: 'a'.repeat(64),
    })
    .mockRejectedValueOnce(new Error('stabilization failed'))
  await expect(application.host.recoverOfflineAccountProfile({
    candidateId: failedInspection.candidates[0]!.candidateId,
    preflightDigest: failedInspection.candidates[0]!.preflightDigest,
    keyHandle: 'keychain:account-startup', unlockMaterial: accountUnlock,
    operationId: randomUUID(), ownerId: 'retry-owner',
  })).rejects.toBeDefined()

  const marker = new ProfileClaimMarker(new FileProfileClaimMarkerFiles(join(root, 'profiles'), process.getuid!()))
  const pending = { profileId: profile.profileId, candidateId: 'llm-deepseek:deepseek', operationId: randomUUID() }
  marker.mark(pending)
  await expect(application.host.restoreLocalProfile({ ...profile,
    keyHandle: 'keychain:startup', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ownerId: 'retry-owner',
  })).rejects.toMatchObject({ code: 'unavailable' })
  marker.clear(pending)

  await application.close()
  await application.close()
  expect(serverClose).toHaveBeenCalledOnce()
  expect(workerEvents.some(event => event.startsWith('abort:'))).toBe(true)
}, 20_000)

it.skipIf(process.platform === 'win32')('keeps Host startup available when the global claim ledger is corrupt', async () => {
  const { config, root } = fixture()
  const recoveringConfig = Object.assign({}, config, { legacySourceQuiescent: false })
  const ledgerRoot = join(root, 'control', 'legacy-model-claims')
  mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(ledgerRoot, 'legacy-claims.v1.json'), 'corrupt', { mode: 0o600 })
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  let serverOptions: UnixHostServerOptions | undefined
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(recoveringConfig, { now: () => NOW }, {
    platform: 'darwin', createServer: (options) => { serverOptions = options; return server },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  expect(serverOptions?.modelClaimRecovery).toBeDefined()
  expect(serverOptions?.modelClaimTransaction).toBeUndefined()
  expect(serverOptions?.inspectModelClaimSource).toBeUndefined()
  expect(() => { serverOptions?.modelClaimRecovery?.status({ candidateId: 'llm-deepseek:deepseek',
    authorizeAccountProfile: () => randomUUID() }) }).toThrow(/unavailable/u)
})

it.skipIf(process.platform === 'win32')('composes and closes restricted history only with an explicit trusted adapter', async () => {
  const { config, root } = fixture()
  const serverClose = vi.fn(async () => undefined)
  const server = { start: async () => undefined, close: serverClose } as unknown as UnixHostServer
  let capturedOptions: UnixHostServerOptions | undefined
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: options => { capturedOptions = options; return server },
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, operation) => operation(),
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  const reader = application.restrictedHistory
  if (!reader) throw new Error('missing restricted reader')
  expect(capturedOptions).not.toHaveProperty('restrictedHistory')
  const readerClose = vi.spyOn(reader, 'close')
  await application.close()
  expect(serverClose).toHaveBeenCalledOnce()
  expect(readerClose).toHaveBeenCalledOnce()
  await expect(reader.read(application.host, {} as never, () => {}, {
    operation: 'session.list', command_id: randomUUID() as never,
  }, new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
})

it.skipIf(process.platform === 'win32')('stops Profile workers and retains ownership when server close fails', async () => {
  const { config, root } = fixture()
  const failure = new Error('server close failed')
  const stopWorker = vi.fn()
  const server = { start: async () => undefined, close: async () => { throw failure } } as unknown as UnixHostServer
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    profileWorkerFactory: async () => ({ closeNotifications() {}, abort: stopWorker, done: Promise.resolve() }),
  })
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  await application.workers.start({ profileId: randomUUID(), profileRoot: root, credentialHandle: 'fixture', pluginRoots: [] })
  await expect(application.close()).rejects.toBe(failure)
  expect(stopWorker).toHaveBeenCalledOnce()
  expect(existsSync(join(root, 'host.lock'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('cancels pending fence reconciliation before releasing Host ownership', async () => {
  const { config, root } = fixture()
  const profileId = randomUUID()
  const directory = join(root, 'restricted-fences')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, `${profileId}.json`)
  writeFileSync(path, JSON.stringify({ version: 2, profileId, operationId: randomUUID(), state: 'pending',
    phase: 'reserved', ownerGeneration: randomUUID(), ownerPid: 2147483647 }), { mode: 0o600 })
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, _operation, signal) => {
        enter()
        return await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  if (!application.restrictedHistory) throw new Error('missing restricted reader')
  const pending = application.restrictedHistory.reconcileEmptyFence(profileId)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  await entered
  await application.close()
  await rejected
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('pending')
  expect(existsSync(join(root, 'host.lock'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('retains the fence and Host ownership if reconciliation guard release fails', async () => {
  const { config, root } = fixture()
  const profileId = randomUUID()
  const directory = join(root, 'restricted-fences')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, `${profileId}.json`)
  writeFileSync(path, JSON.stringify({ version: 2, profileId, operationId: randomUUID(), state: 'pending',
    phase: 'worker_gone', ownerGeneration: randomUUID(), ownerPid: 2147483647 }), { mode: 0o600 })
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, operation) => { await operation(); throw new Error('release failed') },
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  if (!application.restrictedHistory) throw new Error('missing restricted reader')
  await expect(application.restrictedHistory.reconcileEmptyFence(profileId)).rejects.toThrow('release failed')
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('pending')
  expect(application.workers.isProfileBlocked(profileId)).toBe(true)
  await expect(application.close()).rejects.toMatchObject({ code: 'unavailable' })
  expect(existsSync(join(root, 'host.lock'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('fails closed when the reconciliation guard swallows a validation failure', async () => {
  const { config, root } = fixture()
  const profileId = randomUUID(), operationId = randomUUID()
  const directory = join(root, 'restricted-fences')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, `${profileId}.json`)
  writeFileSync(path, JSON.stringify({ version: 2, profileId, operationId, state: 'pending',
    phase: 'worker_gone', ownerGeneration: randomUUID(), ownerPid: 2147483647 }), { mode: 0o600 })
  const staged = join(root, `restricted-${operationId}`)
  mkdirSync(staged, { mode: 0o700 })
  const sentinel = join(staged, 'preserve')
  writeFileSync(sentinel, 'existing', { mode: 0o600 })
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, operation) => {
        try { return await operation() } catch { return false as never }
      },
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  if (!application.restrictedHistory) throw new Error('missing restricted reader')
  await expect(application.restrictedHistory.reconcileEmptyFence(profileId)).rejects.toMatchObject({ code: 'unavailable' })
  expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('pending')
  expect(readFileSync(sentinel, 'utf8')).toBe('existing')
  await expect(application.close()).rejects.toMatchObject({ code: 'unavailable' })
  expect(existsSync(join(root, 'host.lock'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('recovers an empty old-Host fence before restoring the original Profile', async () => {
  const { config, root } = fixture()
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  let starts = 0, exclusions = 0
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    profileWorkerFactory: async () => { starts += 1; return { closeNotifications() {}, abort() {}, done: Promise.resolve() } },
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, operation) => { exclusions += 1; return operation() },
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
  const profile = await application.host.bootstrapLocalProfile({ keyHandle: 'keychain:startup', unlockMaterial, ownerId: 'owner' })
  await application.workers.dispose(profile.profileId)
  const fencePath = join(root, 'restricted-fences', `${profile.profileId}.json`)
  const operationId = randomUUID()
  writeFileSync(fencePath, JSON.stringify({ version: 2, profileId: profile.profileId, operationId,
    state: 'pending', phase: 'worker_gone', ownerGeneration: randomUUID(), ownerPid: 2147483647 }), { mode: 0o600 })
  expect(application.workers.isProfileBlocked(profile.profileId)).toBe(true)
  await expect(application.host.restoreLocalProfile({ ...profile, keyHandle: 'keychain:startup', unlockMaterial,
    ownerId: 'owner' })).resolves.toMatchObject(profile)
  expect(exclusions).toBe(1)
  expect(starts).toBe(2)
  expect(application.workers.isProfileBlocked(profile.profileId)).toBe(false)
})

it.skipIf(process.platform === 'win32')('keeps Host ownership when startup cleanup is unconfirmed', async () => {
  const { config, root } = fixture()
  const failure = new Error('server start failed')
  const server = { start: async () => { throw failure }, close: async () => { throw new Error('server close failed') } } as unknown as UnixHostServer
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  await expect(startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
  })).rejects.toMatchObject({ message: 'host_startup_cleanup_unconfirmed', errors: [failure, expect.any(Error)] })
  expect(existsSync(join(root, 'host.lock'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('keeps Host ownership when restricted reader cleanup is unconfirmed', async () => {
  const { config, root } = fixture()
  const stopWorker = vi.fn()
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    profileWorkerFactory: async () => ({ closeNotifications() {}, abort: stopWorker, done: Promise.resolve() }),
    restrictedHistory: {
      withAllWritersExcluded: async (_profileId, operation) => operation(),
      assertAllWritersQuiescent: () => {}, onCleanupFailure: () => {},
    },
  })
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  if (!application.restrictedHistory) throw new Error('missing restricted reader')
  await application.workers.start({ profileId: randomUUID(), profileRoot: root, credentialHandle: 'fixture', pluginRoots: [] })
  vi.spyOn(application.restrictedHistory, 'close').mockRejectedValue(new Error('cleanup unconfirmed'))
  const closing = application.close()
  await expect(closing).rejects.toThrow('cleanup unconfirmed')
  expect(application.close()).toBe(closing)
  expect(stopWorker).toHaveBeenCalledOnce()
  expect(existsSync(join(root, 'host.lock'))).toBe(true)
})

it.skipIf(process.platform === 'win32')('shares one Host close when server shutdown reenters it', async () => {
  const { config, root } = fixture()
  let application: Awaited<ReturnType<typeof import('../src/startup.ts').startDesktopHostApplication>>
  let nested: Promise<void> | undefined
  let entered = false
  const server = { start: async () => undefined, close: async () => {
    if (!entered) { entered = true; nested = application.close() }
  } } as unknown as UnixHostServer
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  const closing = application.close()
  await closing
  expect(nested).toBe(closing)
})

it.skipIf(process.platform === 'win32')('restores a per-Profile restricted fence when Host starts again', async () => {
  const { config, root } = fixture()
  const profileId = randomUUID()
  const otherId = randomUUID()
  const directory = join(root, 'restricted-fences')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, `${profileId}.json`), JSON.stringify({ version: 1, profileId,
    operationId: randomUUID(), state: 'pending' }), { mode: 0o600 })
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  const started: string[] = []
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: () => server,
    profileWorkerFactory: async spec => {
      started.push(spec.profileId)
      return { closeNotifications() {}, abort() {}, done: Promise.resolve() }
    },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  const input = (id: string) => ({ profileId: id, profileRoot: root, credentialHandle: 'fixture', pluginRoots: [] })
  await expect(application.workers.start(input(profileId))).rejects.toMatchObject({ code: 'unavailable' })
  await application.workers.start(input(otherId))
  expect(started).toEqual([otherId])
})

it.skipIf(process.platform === 'win32')('restores a partially written Account claim through production Host composition', async () => {
  const { config, root, accountPrivateKey } = fixture()
  const server = { start: async () => undefined, close: async () => undefined } as unknown as UnixHostServer
  let serverOptions: UnixHostServerOptions | undefined
  let workerStarts = 0
  const { startDesktopHostApplication } = await import('../src/startup.ts')
  const application = await startDesktopHostApplication(config, { now: () => NOW }, {
    platform: 'darwin', createServer: (options) => { serverOptions = options; return server },
    profileWorkerFactory: async (): Promise<ProfileWorkerHandle> => {
      workerStarts += 1
      return { viewOrigin: 'http://127.0.0.1:43123', generation: workerStarts,
        bootstrapCookie: { name: 'fixture', value: 'private' },
        closeNotifications: () => undefined, abort: () => undefined, done: Promise.resolve() }
    },
  })
  onTestFinished(async () => { await application.close(); rmSync(root, { recursive: true, force: true }) })
  const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:claim-recovery',
    authorityBindingVersion: 1 }
  const material = Buffer.alloc(32, 9).toString('base64url')
  const subject = randomUUID()
  const token = accountToken(accountPrivateKey, subject)
  const account = { issuer: 'https://accounts.dsh.colorbuyai.com', subject,
    accountAccessToken: token, keyHandle: 'keychain:claim-recovery', unlockMaterial: material, ...binding }
  const profile = await application.host.ensureAccountProfile({ ...account, ownerId: 'owner' })
  await application.workers.dispose(profile.profileId)
  const startsBeforeRestrictedAuthorization = workerStarts
  expect(application.host.authorizeRestrictedAccountHistory(account).profileId).toBe(profile.profileId)
  expect(() => application.host.authorizeRestrictedAccountHistory({ ...account, accountAccessToken: 'invalid' })).toThrow()
  expect(() => application.host.authorizeRestrictedAccountHistory({ ...account, subject: randomUUID() })).toThrow()
  expect(() => application.host.authorizeRestrictedAccountHistory({ ...account, authorityBindingVersion: 2 })).toThrow()
  expect(() => application.host.authorizeRestrictedAccountHistory({ ...account, keyHandle: 'keychain:other' })).toThrow()
  expect(() => application.host.authorizeRestrictedAccountHistory({ ...account,
    unlockMaterial: Buffer.alloc(32, 8).toString('base64url') })).toThrow()
  expect(workerStarts).toBe(startsBeforeRestrictedAuthorization)
  expect(serverOptions?.listBotRoster).toBeDefined()
  await expect(serverOptions!.listBotRoster!(profile.profileId, '', 50, new AbortController().signal))
    .rejects.toThrow()
  expect(serverOptions?.prepareNativeRoom).toBeDefined()
  await expect(serverOptions!.prepareNativeRoom!(profile.profileId, 'room_1', new AbortController().signal))
    .rejects.toMatchObject({ code: 'unavailable' })
  const profileRoot = join(root, 'profiles', profile.profileId)
  const ownerRoot = join(profileRoot, 'migration-owner-state', '1')
  const uid = process.getuid!()
  const recovery = new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(join(root, 'profiles'), uid))
  const files = new FileLegacyClaimTargetFiles({ generation: 1, settingsPath: join(ownerRoot, 'settings.yaml'),
    credentialsPath: join(ownerRoot, '.credentials.yaml'), storageRoot: join(ownerRoot, 'storages') }, uid)
  const target = new LegacyClaimTarget(files, recovery)
  const candidateId = 'llm-deepseek:deepseek'
  const operationId = randomUUID()
  const sourceDigest = 'a'.repeat(64)
  const before = { settings: files.read('settings'), credentials: files.read('credentials') }
  const prepared = target.prepare({ profileId: profile.profileId, candidateId, operationId,
    targetGeneration: 1, sourceSettings: { 'llm-deepseek': { apiKeyEnv: 'OLD_KEY' } },
    sourceCredentials: { refs: { OLD_KEY: 'legacy-secret' }, records: {} }, guard: () => undefined })
  const ledger = new LegacyClaimLedger(new FileLegacyClaimEventStore({
    root: join(root, 'control', 'legacy-model-claims'), uid, maximumBytes: 4 * 1024 * 1024,
  }), () => NOW)
  ledger.reserve({ profileId: profile.profileId, candidateId, operationId, sourceDigest, targetGeneration: 1 })
  const marker = new ProfileClaimMarker(new FileProfileClaimMarkerFiles(join(root, 'profiles'), uid))
  marker.mark({ profileId: profile.profileId, candidateId, operationId })
  files.replace('credentials', prepared.credentialsAfter)
  const claims = serverOptions?.modelClaimRecovery
  if (!claims) throw Error('missing model claim recovery')
  const authorizeAccountProfile = () => application.host.authorizeAccountModelClaimRecovery(account)
  expect(claims.status({ candidateId, authorizeAccountProfile })?.status).toBe('pending')
  expect(await claims.restore({ candidateId, operationId, authorizeAccountProfile })).toEqual({
    state: 'restored', cleanupPending: false,
  })
  expect(files.read('settings')).toEqual(before.settings)
  expect(files.read('credentials')).toEqual(before.credentials)
  expect(marker.pending(profile.profileId)).toBe(false)
  expect(workerStarts).toBe(2)
  expect(claims.status({ candidateId, authorizeAccountProfile })).toBeNull()
})
