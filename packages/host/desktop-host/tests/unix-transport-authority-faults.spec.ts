import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type {
  HostControlCapability,
  HostExtensionKind,
  ProfileEnsureRequest,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'
import type { ProfileExtensionOperations } from '../src/extension-operations.ts'
import { HostAuthorityError } from '../src/types.ts'
import {
  HostControlAuthority,
  UnixHostClient,
  type HostClientFrameTransport,
  type MigrationExportService,
  type MigrationImportService,
  type UnixHostServerOptions,
} from '../src/unix-transport.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const ownerId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3198'
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3188'
const operationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3178'
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const identity = {
  hostInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120',
  installationId,
  installationPublicKey: publicKey,
  installationPrivateKey: keys.privateKey,
  processNonce: '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q',
  executableSignatureDigest: '1'.repeat(64),
  runtimeGeneration: 5,
  schemaGeneration: 1,
}
const ready = { profileId, bindingGeneration: 2 }
const opened = { profileId, viewLeaseId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3168',
  viewActivationHandle: 'activation-handle', leaseGeneration: 3, expiresAt: 20_000, runtimeGeneration: 5 }
const proof = { inventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', schemaVersion: 1,
  requiredMaxRecords: 8, requiredMaxBytes: 4_096 }
const receipt = { exportId: 'export-1', transferId: randomUUID(), transferDigest: '3'.repeat(64), schemaVersion: 1,
  sourceGeneration: 'generation-1', recordCount: 1, firstEventSequence: 1, lastEventSequence: 1,
  semanticDigest: '4'.repeat(64), chunkCount: 1 }
const chunk = { exportId: 'export-1', chunkIndex: 0, records: [
  { collection: 'sessions' as const, id: 'session-1', sequence: 0, payloadDigest: '5'.repeat(64) },
  { collection: 'session_events' as const, id: 'event-1', sessionId: 'session-1', sequence: 1,
    payloadDigest: '6'.repeat(64) },
], chunkDigest: '7'.repeat(64), final: true }

function fakeHost(): DesktopHost {
  return {
    supportsOfflineAccountRecovery: () => true,
    bootstrapLocalProfile: vi.fn(async () => ready),
    restoreLocalProfile: vi.fn(async () => ready),
    ensureAccountProfile: vi.fn(async () => ready),
    restoreProfile: vi.fn(async () => ready),
    getProfileStatus: vi.fn(() => ({ state: 'ready', profileId })),
    openProfile: vi.fn(async () => opened),
    openLocalProfile: vi.fn(async () => opened),
    inspectOfflineAccountProfiles: vi.fn(async () => ({ candidates: [] })),
    recoverOfflineAccountProfile: vi.fn(async () => ({ ...ready, persistenceGeneration: 3, runtimeGeneration: 5 })),
    openOfflineAccountProfile: vi.fn(async () => opened),
    getOfflineAccountRecoveryStatus: vi.fn(() => ({ state: 'recovering' })),
    authorizeMigrationProfileSelector: vi.fn((input: { profileId: string }) => input.profileId),
    authorizeExtensionView: vi.fn(() => profileId),
    activateView: vi.fn(async () => ({ origin: 'http://127.0.0.1:43125', activationGeneration: 1,
      expiresAt: 20_000, bootstrapCookie: { name: 'fixture', value: 'private' } })),
    closeOwnedViewLease: vi.fn(),
    revokeOwner: vi.fn(),
  } as unknown as DesktopHost
}

async function authorityClient(options: Partial<UnixHostServerOptions> = {}): Promise<{
  client: UnixHostClient
  lifetime: AbortController
  host: DesktopHost
}> {
  const host = options.host ?? fakeHost()
  const authority = new HostControlAuthority({
    identity,
    host,
    profilePersistenceGeneration: () => 3,
    now: () => 1_000,
    ...options,
  })
  const lifetime = new AbortController()
  const session = authority.openSession(ownerId, lifetime.signal)
  const transport: HostClientFrameTransport = {
    call: frame => session.handleRequest(frame),
    isConnected: () => !lifetime.signal.aborted,
    close: () => { lifetime.abort(); session.close() },
  }
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: installationId,
    trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: identity.executableSignatureDigest,
    now: () => 1_000,
  }, transport)
  return { client, lifetime, host }
}

async function localSelector(client: UnixHostClient): Promise<string> {
  return (await client.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: 'material' })).profileSelector
}

describe('Unix transport authority failures', () => {
  it('maps unavailable migration providers without exposing implementation failures', async () => {
    const absentExport = await authorityClient({ createMigrationExport: async () => undefined as never })
    const selector = await localSelector(absentExport.client)
    await expect(absentExport.client.getMigrationExportInventory({ sourceProfileSelector: selector }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    absentExport.client.close()

    const absentLegacy = await authorityClient({ createLegacyMigrationExport: async () => undefined as never })
    const legacySelector = await localSelector(absentLegacy.client)
    await expect(absentLegacy.client.getExistingMigrationSourceInventory({ targetProfileSelector: legacySelector }))
      .rejects.toMatchObject({ code: 'unavailable' })
    absentLegacy.client.close()

    const absentImport = await authorityClient({ createMigrationImport: () => undefined as never })
    const importSelector = await localSelector(absentImport.client)
    await expect(absentImport.client.stageMigrationImport({ transferId: randomUUID(), transferDigest: '3'.repeat(64),
      sourceInstallationId: installationId, sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1',
      sourceSchemaVersion: 1, targetGeneration: 4, recordCount: 1, semanticDigest: '4'.repeat(64),
      targetProfileSelector: importSelector })).rejects.toMatchObject({ code: 'unavailable' })
    absentImport.client.close()
  })

  it('returns a sanitized error from every migration operation failure', async () => {
    let failure: unknown
    const fail = () => { throw failure }
    const exportService: MigrationExportService = {
      inventory: async () => fail(),
      begin: async () => fail(),
      read: () => fail(),
    }
    const importService: MigrationImportService = {
      stage: async () => fail(), status: async () => fail(), verify: async () => fail(),
      commit: async () => fail(), abort: async () => fail(),
    }
    const { client } = await authorityClient({
      createMigrationExport: async () => exportService,
      createLegacyMigrationExport: async () => exportService,
      createMigrationImport: () => importService,
    })
    const selector = await localSelector(client)
    const migration = { transferId: randomUUID(), transferDigest: '3'.repeat(64), sourceInstallationId: installationId,
      sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', sourceSchemaVersion: 1,
      targetGeneration: 4, recordCount: 1, semanticDigest: '4'.repeat(64), targetProfileSelector: selector }
    const cases: Array<[unknown, () => Promise<unknown>, string]> = [
      [new Error('migration_export_busy'), () => client.getExistingMigrationSourceInventory({ targetProfileSelector: selector }), 'busy'],
      [new Error('migration_export_not_found'), () => client.getMigrationExportInventory({ sourceProfileSelector: selector }), 'stale'],
      [new Error('migration_export_bounds_invalid'), () => client.beginMigrationExport({ sourceProfileSelector: selector,
        expectedInventoryDigest: proof.inventoryDigest, maxRecords: 8, maxBytes: 4_096 }), 'unavailable'],
      [new Error('migration_source_changed'), () => client.readMigrationExport({ sourceProfileSelector: selector,
        exportId: receipt.exportId, chunkIndex: 0 }), 'conflict'],
      [new Error('migration_import_invalid'), () => client.stageMigrationImport(migration), 'unavailable'],
      [new Error('migration_import_not_found'), () => client.getMigrationImportStatus(migration), 'stale'],
      [new Error('migration_import_state'), () => client.verifyMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        targetProfileSelector: selector }), 'conflict'],
      [new Error('migration_import_unsafe'), () => client.commitMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        expectedCurrentGeneration: 3, targetProfileSelector: selector }), 'unauthorized'],
      ['non-error', () => client.abortMigrationImport({ importId: 'import-1', expectedStageVersion: 1,
        targetProfileSelector: selector }), 'unavailable'],
    ]
    for (const [nextFailure, call, code] of cases) {
      failure = nextFailure
      await expect(call()).rejects.toMatchObject({ code })
    }
    client.close()
  })

  it('advertises and projects extension flags only for their matching kind', async () => {
    let currentReceipt: Record<string, unknown> = {
      operationId, state: 'queued', cancellationRequested: false, createdAt: 1_000, updatedAt: 1_000,
    }
    const operations = {
      prepare: (authority: () => string, kind: HostExtensionKind) => ({ planId: 'plan-1', kind,
        digest: '8'.repeat(64), expiresAt: 20_000, profileId: authority() }),
      commit: (authority: () => string) => ({ ...currentReceipt, profileId: authority() }),
      cancel: (authority: () => string) => ({ ...currentReceipt, profileId: authority() }),
      status: (authority: () => string) => ({ ...currentReceipt, profileId: authority() }),
      dispose: async () => undefined,
    } as unknown as ProfileExtensionOperations
    const extensions = { operations, kinds: ['plugin', 'skill', 'mcp'] as const,
      inventory: async () => [], pluginRemove: true, pluginUpdate: true, pluginToggle: true,
      skillArchives: true, skillRemove: true, skillReplace: true, skillFiles: true, skillInvocation: true,
      mcpRemove: true, mcpUpdate: true }
    const { client } = await authorityClient({ extensions })
    const selector = await localSelector(client)
    const profileLease = await client.openLocalProfile({ profileSelector: selector })
    for (const kind of extensions.kinds) {
      await expect(client.extensions({ ...profileLease, command: { action: 'inventory', kind } }))
        .resolves.toMatchObject({ state: 'inventory', kind })
    }
    const prepared = await client.extensions({ ...profileLease, command: { action: 'prepare', kind: 'skill', payload: '{}' } })
    expect(prepared).toMatchObject({ state: 'prepared', kind: 'skill' })
    await expect(client.extensions({ ...profileLease, command: { action: 'cancel', operation_id: operationId as never } }))
      .resolves.toMatchObject({ state: 'receipt', outcome: 'queued' })

    currentReceipt = { ...currentReceipt, state: 'unknown', reason: 'interrupted', skillSource: 'user-agents',
      canRestore: true, skillRemoval: { entryId: 'bundle-demo' }, restoredBy: operationId,
      restores: operationId, recoveryMode: 'restore' }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ reason: 'interrupted', skill_source: 'user-agents', skill_restore: 'bundle-demo',
        restored_by: operationId, restores_operation: operationId })
    currentReceipt = { ...currentReceipt, skillRemoval: undefined, mcpRecovery: {}, pluginToggleRecovery: undefined,
      restoredBy: undefined, completedBy: operationId, recoveryMode: 'complete' }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ mcp_restore: true, completed_by: operationId, completes_operation: operationId })
    currentReceipt = { ...currentReceipt, mcpRecovery: undefined, pluginToggleRecovery: { packageName: 'demo' },
      canComplete: true, pluginPackage: { action: 'install', packageName: 'demo', spec: 'demo@1.0.0' } }
    await expect(client.extensions({ ...profileLease, command: { action: 'status', operation_id: operationId as never } }))
      .resolves.toMatchObject({ plugin_restore: 'demo', plugin_complete: { action: 'install', package_name: 'demo', spec: 'demo@1.0.0' } })
    currentReceipt = { ...currentReceipt, pluginPackage: { action: 'remove', packageName: 'demo' } }
    await expect(client.extensions({ ...profileLease, command: { action: 'commit', plan_id: 'plan-1' as never,
      operation_id: operationId as never } }))
      .resolves.toMatchObject({ plugin_complete: { action: 'remove', package_name: 'demo' } })
    client.close()

    const withoutFlags = await authorityClient({ extensions: { operations, kinds: extensions.kinds, inventory: async () => [] } })
    const withoutSelector = await localSelector(withoutFlags.client)
    const withoutLease = await withoutFlags.client.openLocalProfile({ profileSelector: withoutSelector })
    for (const kind of extensions.kinds) {
      await expect(withoutFlags.client.extensions({ ...withoutLease, command: { action: 'inventory', kind } }))
        .resolves.toEqual({ state: 'inventory', kind, entries: [] })
    }
    withoutFlags.client.close()
  })

  it('maps extension executor failures and rechecks authority after awaited inventory', async () => {
    let failure: unknown
    let abortDuringInventory = false
    const lifetime = new AbortController()
    const operations = {
      prepare: () => { throw failure },
      commit: () => { throw failure },
      cancel: () => { throw failure },
      status: () => { throw failure },
      dispose: async () => undefined,
    } as unknown as ProfileExtensionOperations
    const host = fakeHost()
    const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 3, now: () => 1_000,
      extensions: { operations, kinds: ['skill'], inventory: async () => {
        if (abortDuringInventory) lifetime.abort()
        return []
      } } })
    const session = authority.openSession(ownerId, lifetime.signal)
    const transport: HostClientFrameTransport = { call: frame => session.handleRequest(frame), isConnected: () => true,
      close: () => { session.close() } }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: () => 1_000 }, transport)
    const selector = await localSelector(client)
    const profileLease = await client.openLocalProfile({ profileSelector: selector })
    const failures: Array<[unknown, string]> = [
      [new HostAuthorityError('busy'), 'busy'], [new Error('expired'), 'stale'], [new Error('busy'), 'busy'],
      [new Error('idempotency_conflict'), 'idempotency_conflict'], [new Error('unauthorized'), 'unauthorized'],
      [new Error('upgrade_required'), 'upgrade_required'], ['non-error', 'unavailable'], [new Error('other'), 'unavailable'],
    ]
    for (const [nextFailure, code] of failures) {
      failure = nextFailure
      await expect(client.extensions({ ...profileLease, command: { action: 'prepare', kind: 'skill', payload: '{}' } }))
        .rejects.toMatchObject({ code })
    }
    abortDuringInventory = true
    await expect(client.extensions({ ...profileLease, command: { action: 'inventory', kind: 'skill' } }))
      .rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('uses default clocks, PEM keys, optional migration records, and profile failure redaction', async () => {
    const host = fakeHost()
    vi.spyOn(host, 'inspectOfflineAccountProfiles').mockResolvedValue({ candidates: [{
      state: 'recoverable', candidateId: 'candidate-1' as never, profileKind: 'account', bindingCount: 1,
      persistenceGeneration: 3, sessionCount: 1, pluginCount: 0, compatibility: 'current',
      preflightDigest: '8'.repeat(64), reasonCode: 'legacy_runtime_required',
    }] })
    vi.spyOn(host, 'getOfflineAccountRecoveryStatus').mockReturnValue({
      state: 'failed', reasonCode: 'recovery_worker_failed',
    })
    const exportService: MigrationExportService = {
      inventory: async () => proof,
      begin: async () => receipt,
      read: () => chunk,
    }
    const authority = new HostControlAuthority({
      identity: { ...identity, installationPrivateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) },
      host,
      profilePersistenceGeneration: () => 3,
      createMigrationExport: async () => exportService,
      createLegacyMigrationExport: async () => exportService,
    })
    const lifetime = new AbortController()
    const session = authority.openSession(ownerId, lifetime.signal)
    const transport: HostClientFrameTransport = { call: frame => session.handleRequest(frame), isConnected: () => true,
      close: () => { session.close() } }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest }, transport)
    const selector = await localSelector(client)
    await expect(client.inspectOfflineAccountProfiles({ profileKeyHandles: ['key'] }))
      .resolves.toMatchObject({ candidates: [{ candidateId: 'candidate-1', reasonCode: 'legacy_runtime_required' }] })
    await expect(client.getOfflineAccountRecoveryStatus({ recoveryOperationId: operationId }))
      .resolves.toEqual({ state: 'failed', reasonCode: 'recovery_worker_failed' })
    await expect(client.readMigrationExport({ sourceProfileSelector: selector, exportId: receipt.exportId, chunkIndex: 0 }))
      .resolves.toMatchObject({ records: [{ id: 'session-1' }, { sessionId: 'session-1' }] })
    const legacy = await client.getExistingMigrationSourceInventory({ targetProfileSelector: selector })
    expect(legacy.expiresAt).toBeGreaterThan(Date.now())
    await expect(client.beginMigrationExport({ sourceProfileSelector: selector,
      sourceInventoryAuthority: legacy.sourceInventoryAuthority, expectedInventoryDigest: proof.inventoryDigest,
      maxRecords: 8, maxBytes: 4_096 })).resolves.toMatchObject({ exportId: receipt.exportId })

    vi.spyOn(host, 'getProfileStatus').mockImplementationOnce(() => { throw new Error('private implementation') })
    await expect(client.getProfileStatus({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1 })).rejects.toMatchObject({ code: 'unavailable' })
    vi.spyOn(host, 'getProfileStatus').mockImplementationOnce(() => { throw new HostAuthorityError('invalid_input') })
    await expect(client.getProfileStatus({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1 })).rejects.toMatchObject({ code: 'unavailable' })
    client.close()
  })

  it('rejects unsupported inspection, missing extension authority, and legacy ensure frames', async () => {
    const host = fakeHost()
    const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 3, now: () => 1_000 })
    const lifetime = new AbortController()
    const session = authority.openSession(ownerId, lifetime.signal)
    await expect(session.handleRequest({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect',
      params: { challenge: 'A'.repeat(43) as never, client_instance_id: randomUUID() as never, supported_versions: [2] },
    })).rejects.toMatchObject({ code: 'unavailable' })

    let mutateEnsure = false
    const transport: HostClientFrameTransport = {
      call: (frame) => {
        if (mutateEnsure && frame.method === 'profile.ensure') {
          const ensureFrame = frame as ProfileEnsureRequest
          return session.handleRequest({ ...ensureFrame, params: { ...ensureFrame.params, account_access_token: '' } })
        }
        return session.handleRequest(frame)
      },
      isConnected: () => true,
      close: () => { session.close() },
    }
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest,
      now: () => 1_000 }, transport)
    ;(client.inspection.capabilities as HostControlCapability[]).push('profile.extensions' as never)
    await expect(client.extensions({ ...opened, command: { action: 'inventory', kind: 'skill' } }))
      .rejects.toMatchObject({ code: 'upgrade_required' })
    mutateEnsure = true
    await expect(client.ensureAccountProfile({ authorityEnvironmentId: 'environment', accountBindingHandle: 'binding',
      authorityBindingVersion: 1, issuer: 'issuer', subject: 'subject', accountAccessToken: 'token',
      keyHandle: 'key', unlockMaterial: 'material' })).rejects.toMatchObject({ code: 'upgrade_required' })
    client.close()
  })
})
