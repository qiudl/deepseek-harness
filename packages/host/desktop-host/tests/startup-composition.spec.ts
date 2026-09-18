import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
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

const mocks = vi.hoisted(() => ({
  loadProfileDirectory: vi.fn(() => ({ layers: [], patches: [] })),
  loadOverlayPatches: vi.fn(() => []),
  pluginCommand: vi.fn(async (_input: unknown) => undefined),
  pluginRuntime: vi.fn(async () => undefined),
  pluginEntries: vi.fn(() => []),
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
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadProfileDirectory: mocks.loadProfileDirectory,
  loadOverlayPatches: mocks.loadOverlayPatches,
}))
vi.mock('../src/plugin-command.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-command.ts')>(),
  runProfilePluginCommand: mocks.pluginCommand,
}))
vi.mock('../src/plugin-runtime-ack.ts', () => ({ waitForPluginRuntime: mocks.pluginRuntime }))
vi.mock('../src/plugin-bundle-entries.ts', () => ({ pluginBundleEntries: mocks.pluginEntries }))
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
  mkdirSync(join(root, '.dsh/sessions'), { recursive: true, mode: 0o700 })
  vi.stubEnv('HOME', root)
  let serverOptions: UnixHostServerOptions | undefined
  const workerSpecs: ProfileWorkerSpec[] = []
  const workerEvents: string[] = []
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
  onTestFinished(async () => {
    await application.close()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })
  expect(serverStart).toHaveBeenCalledOnce()
  if (!serverOptions) throw new Error('missing captured server options')
  expect(await serverOptions.inspectModelClaimSource?.()).toMatchObject({ candidates: [] })
  expect(await serverOptions.inspectModelClaimSource?.(new AbortController().signal)).toMatchObject({ candidates: [] })

  const profile = await application.host.bootstrapLocalProfile({
    keyHandle: 'keychain:startup', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ownerId: 'owner',
  })
  expect(serverOptions.modelClaimRecovery?.status({ candidateId: 'llm-deepseek:deepseek',
    authorizeAccountProfile: () => profile.profileId })).toBeNull()
  expect(workerSpecs).toHaveLength(1)
  const opened = await application.host.openLocalProfile({ profileId: profile.profileId, ownerId: 'owner' })
  expect((await application.host.activateView({
    ...opened,
    ownerId: 'owner',
  })).origin).toBe('http://127.0.0.1:43123')
  expect(await serverOptions.profilePersistenceGeneration(profile.profileId)).toBe(1)
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
    operations.commit(authority, plan.planId, operationId)
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
    const input = raw as { profileRoot: string; spec: string; action?: string }
    if (input.action === 'repair') return
    const path = join(input.profileRoot, 'profiles/web/package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    const name = input.action === 'remove' ? input.spec : input.spec.slice(0, input.spec.lastIndexOf('@'))
    if (input.action === 'remove') {
      manifest.dependencies = Object.fromEntries(
        Object.entries(manifest.dependencies).filter(([packageName]) => packageName !== name),
      )
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(bundle => bundle !== name)
    } else {
      manifest.dependencies[name] = '1.0.0'
      if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
    }
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 })
    if (input.action === 'remove' && failRemoval) {
      failRemoval = false
      throw new Error('interrupted removal')
    }
  })
  await runOperation('plugin', JSON.stringify({ packageName: 'startup-plugin', spec: 'startup-plugin@1.0.0' }))
  await runOperation('plugin', JSON.stringify({
    action: 'toggle', packageName: 'startup-plugin', enabled: false,
  }))
  await runOperation('plugin', JSON.stringify({ action: 'remove', packageName: 'startup-plugin' }))
  await runOperation('plugin', JSON.stringify({ packageName: 'startup-plugin', spec: 'startup-plugin@1.0.0' }))
  failRemoval = true
  const interruptedPlan = await operations.prepare(authority, 'plugin', JSON.stringify({
    action: 'remove', packageName: 'startup-plugin',
  }))
  const interruptedId = randomUUID()
  operations.commit(authority, interruptedPlan.planId, interruptedId)
  await operations.settled()
  expect(operations.status(authority, interruptedId).state).toBe('unknown')
  await runOperation('plugin', JSON.stringify({ action: 'complete-package', operationId: interruptedId }))
  expect(mocks.mcpRuntime).toHaveBeenCalled()
  expect(mocks.skillRuntime).toHaveBeenCalled()
  expect(mocks.pluginRuntime).toHaveBeenCalled()

  const exporter = await serverOptions.createMigrationExport?.('owner', profile.profileId)
  if (!exporter) throw new Error('missing current exporter')
  const inventory = await exporter.inventory()
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
  await importer.commit(verified.importId, verified.version, 1)
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
  expect(serverOptions?.inspectModelClaimSource).toBeUndefined()
  expect(() => { serverOptions?.modelClaimRecovery?.status({ candidateId: 'llm-deepseek:deepseek',
    authorizeAccountProfile: () => randomUUID() }) }).toThrow(/unavailable/u)
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
