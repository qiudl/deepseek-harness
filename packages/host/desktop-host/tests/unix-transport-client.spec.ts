import { generateKeyPairSync, sign } from 'node:crypto'
import {
  encodeHostInspectSignaturePayload,
  type HostControlCapability,
  type HostControlErrorCode,
  type HostControlFrame,
  type HostInspectRequest,
  type HostInspectResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  UnixHostClient,
  type HostClientFrameTransport,
} from '../src/unix-transport.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const hostInstanceId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'
const processNonce = '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q'
const digest = '1'.repeat(64)
const profileSelector = 'selector'
const baseCapabilities = [
  'host.inspect',
  'profile.lease_close',
  'profile.ensure',
  'profile.ensure_account_token',
  'profile.bootstrap_local',
  'profile.open',
  'profile.open_local',
  'profile.restore',
  'profile.restore_local',
  'profile.status',
  'profile.view_activate',
] as HostControlCapability[]
const allCapabilities = [
  ...baseCapabilities,
  'profile.recovery_inspect',
  'profile.recover_offline_account',
  'profile.recovery_status',
  'profile.open_offline_account',
  'profile.extensions',
].sort() as HostControlCapability[]

function inspection(
  request: HostInspectRequest,
  capabilities: readonly HostControlCapability[] = allCapabilities,
): HostInspectResult {
  const unsigned: HostInspectResult = {
    version: 1,
    type: 'result',
    request_id: request.request_id,
    method: 'host.inspect',
    result: {
      protocol_version: 1,
      host_instance_id: hostInstanceId as never,
      installation_id: installationId as never,
      installation_public_key: publicKey as never,
      runtime_generation: 5,
      schema_generation: 1,
      process_nonce: processNonce as never,
      capabilities: [...capabilities],
      challenge_signature: 'A'.repeat(86) as never,
      executable_signature_digest: digest as never,
    },
  }
  return {
    ...unsigned,
    result: {
      ...unsigned.result,
      challenge_signature: sign(
        null,
        encodeHostInspectSignaturePayload(request, unsigned),
        keys.privateKey,
      ).toString('base64url') as never,
    },
  }
}

async function makeClient(
  respond: (frame: HostControlFrame) => HostControlFrame | Promise<HostControlFrame>,
  capabilities: readonly HostControlCapability[] = allCapabilities,
): Promise<{ client: UnixHostClient; transport: HostClientFrameTransport; close: ReturnType<typeof vi.fn> }> {
  const close = vi.fn()
  const transport: HostClientFrameTransport = {
    call: async frame => frame.method === 'host.inspect'
      ? inspection(frame as HostInspectRequest, capabilities)
      : respond(frame),
    isConnected: () => true,
    close,
  }
  const client = await UnixHostClient.connectAuthenticatedTransport({
    trustedInstallationId: installationId,
    trustedInstallationPublicKey: publicKey,
    trustedExecutableSignatureDigest: digest,
    now: () => 1_000,
  }, transport)
  return { client, transport, close }
}

function result(frame: HostControlFrame, value: object): HostControlFrame {
  return {
    version: 1,
    type: 'result',
    request_id: frame.request_id,
    method: frame.method,
    result: value,
  } as HostControlFrame
}

const binding = {
  authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
  accountBindingHandle: 'binding:opaque',
  authorityBindingVersion: 1,
}
const lease = {
  profileId: 'profile-1',
  viewLeaseId: 'lease-1',
  viewActivationHandle: 'activation-1',
  leaseGeneration: 2,
  expiresAt: 20_000,
  runtimeGeneration: 5,
}
const inventory = {
  inventory_digest: '2'.repeat(64),
  source_generation: 'generation-1',
  schema_version: 1,
  required_max_records: 8,
  required_max_bytes: 4_096,
}

describe('Unix Host client protocol projections', () => {
  it('projects redacted model candidates only when the Host advertises inventory', async () => {
    const seen: HostControlFrame[] = []
    const response = { source_digest: 'a'.repeat(64), candidates: [{
      id: 'llm-deepseek:deepseek', provider: 'deepseek', kind: 'llm',
      credential: 'present', shared_credential: false,
    }], unsupported_settings: 1, unassigned_credential_references: 2,
    unassigned_credential_records: 3 }
    const unsupported = await makeClient((frame) => { seen.push(frame); return result(frame, response) },
      [...baseCapabilities].sort())
    const request = { viewLeaseId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3146',
      leaseGeneration: 2, runtimeGeneration: 5 }
    await expect(unsupported.client.modelClaimInventory(request)).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(seen).toEqual([])
    const enabled = await makeClient((frame) => { seen.push(frame); return result(frame, response) },
      [...baseCapabilities, 'profile.model_claim_inventory'].sort() as HostControlCapability[])
    await expect(enabled.client.modelClaimInventory(request)).resolves.toEqual({
      sourceDigest: response.source_digest, candidates: [{
        id: 'llm-deepseek:deepseek', provider: 'deepseek', kind: 'llm',
        credential: 'present', sharedCredential: false,
      }], unsupportedSettings: 1, unassignedCredentialReferences: 2, unassignedCredentialRecords: 3,
    })
    expect(seen).toMatchObject([{ method: 'profile.model_claim_inventory', params: {
      view_lease_id: request.viewLeaseId, lease_generation: 2, runtime_generation: 5,
    } }])
    const malformed = await makeClient(frame => ({
      version: 1, type: 'result', request_id: frame.request_id, method: 'profile.status', result: { state: 'locked' },
    }), [...baseCapabilities, 'profile.model_claim_inventory'].sort() as HostControlCapability[])
    await expect(malformed.client.modelClaimInventory(request)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('projects every successful response and optional wire field', async () => {
    let statusCalls = 0
    let recoveryCalls = 0
    const requests: HostControlFrame[] = []
    const { client, close } = await makeClient((frame) => {
      requests.push(frame)
      switch (frame.method) {
        case 'profile.status':
          return result(frame, ++statusCalls === 1
            ? { state: 'ready', profile_id: 'profile-1', persistence_generation: 3 }
            : { state: 'locked' })
        case 'profile.recovery_inspect':
          return result(frame, { candidates: [
            { state: 'recoverable', candidate_id: 'candidate-1', profile_kind: 'account', binding_count: 1,
              persistence_generation: 3, session_count: 4, plugin_count: 5, compatibility: 'current',
              preflight_digest: '3'.repeat(64) },
            { state: 'compatibility_blocked', candidate_id: 'candidate-2', profile_kind: 'account', binding_count: 0,
              persistence_generation: 2, session_count: 0, plugin_count: 0, compatibility: 'legacy_runtime_required',
              preflight_digest: '4'.repeat(64), reason_code: 'legacy' },
          ] })
        case 'profile.recover_offline_account':
          return result(frame, { state: 'offline_ready', profile_selector: profileSelector, access_scope: 'offline_local',
            persistence_generation: 3, runtime_generation: 5 })
        case 'profile.recovery_status':
          return result(frame, ++recoveryCalls === 1
            ? { state: 'failed', reason_code: 'recovery_worker_failed' }
            : { state: 'offline_ready' })
        case 'profile.open_offline_account':
          return result(frame, { profile_id: lease.profileId, view_lease_id: lease.viewLeaseId,
            view_activation_handle: lease.viewActivationHandle, lease_generation: lease.leaseGeneration,
            expires_at: lease.expiresAt, runtime_generation: lease.runtimeGeneration, access_scope: 'offline_local' })
        case 'profile.ensure':
        case 'profile.restore':
          return result(frame, { state: 'ready', profile_id: lease.profileId, profile_selector: profileSelector })
        case 'profile.bootstrap_local':
        case 'profile.restore_local':
          return result(frame, { state: 'ready', profile_id: lease.profileId, profile_selector: profileSelector,
            persistence_generation: 3 })
        case 'profile.open':
        case 'profile.open_local':
          return result(frame, { profile_id: lease.profileId, view_lease_id: lease.viewLeaseId,
            view_activation_handle: lease.viewActivationHandle, lease_generation: lease.leaseGeneration,
            expires_at: lease.expiresAt, runtime_generation: lease.runtimeGeneration })
        case 'profile.view_activate':
          return result(frame, { origin: 'http://127.0.0.1:43125', activation_generation: 7,
            expires_at: 20_000, bootstrap_cookie: { name: 'fixture', value: 'private' } })
        case 'profile.extensions':
          return result(frame, { state: 'inventory', kind: 'skill', entries: [] })
        case 'profile.lease_close':
          return result(frame, { closed: true })
        case 'migration.export_snapshot.inventory':
          return result(frame, inventory)
        case 'migration.existing_source.inventory':
          return result(frame, { ...inventory, source_inventory_authority: 'authority-1',
            source_installation_id: installationId, expires_at: 20_000 })
        case 'migration.export_snapshot.begin':
          return result(frame, { export_id: 'export-1', transfer_id: 'transfer-1', transfer_digest: '5'.repeat(64),
            schema_version: 1, source_generation: 'generation-1', record_count: 2, first_event_sequence: 1,
            last_event_sequence: 2, semantic_digest: '6'.repeat(64), chunk_count: 1 })
        case 'migration.export_snapshot.read':
          return result(frame, { export_id: 'export-1', chunk_index: 0, records: [
            { collection: 'sessions', id: 'session-1', sequence: 0, payload_digest: '7'.repeat(64) },
            { collection: 'session_events', id: 'event-1', session_id: 'session-1', sequence: 1,
              payload_digest: '8'.repeat(64) },
          ], chunk_digest: '9'.repeat(64), final: true })
        case 'migration.import_snapshot.stage':
          return result(frame, { import_id: 'import-1', stage_version: 1 })
        case 'migration.import_snapshot.status':
          return result(frame, { import_id: 'import-1', stage_version: 2, state: 'verified' })
        case 'migration.import_snapshot.verify':
          return result(frame, { stage_version: 2, semantic_digest: '6'.repeat(64) })
        case 'migration.import_snapshot.commit':
          return result(frame, { stage_version: 3, active_generation: 4 })
        case 'migration.import_snapshot.abort':
          return result(frame, { stage_version: 3 })
        default:
          throw new Error(`unexpected request: ${frame.method}`)
      }
    })

    expect(client.isConnected()).toBe(true)
    await expect(client.getProfileStatus(binding)).resolves.toEqual({ state: 'ready', profileId: 'profile-1', persistenceGeneration: 3 })
    await expect(client.getProfileStatus(binding)).resolves.toEqual({ state: 'locked' })
    await expect(client.inspectOfflineAccountProfiles({ profileKeyHandles: ['keychain:one'] })).resolves.toMatchObject({
      candidates: [{ candidateId: 'candidate-1' }, { candidateId: 'candidate-2', reasonCode: 'legacy' }],
    })
    await expect(client.recoverOfflineAccountProfile({ profileKeyHandle: 'keychain:one', profileUnlockMaterial: 'material',
      recoveryOperationId: 'operation-1', candidateId: 'candidate-1', preflightDigest: '3'.repeat(64) }))
      .resolves.toMatchObject({ state: 'offline_ready', profileSelector })
    await expect(client.getOfflineAccountRecoveryStatus({ recoveryOperationId: 'operation-1' }))
      .resolves.toEqual({ state: 'failed', reasonCode: 'recovery_worker_failed' })
    await expect(client.getOfflineAccountRecoveryStatus({ recoveryOperationId: 'operation-1' }))
      .resolves.toEqual({ state: 'offline_ready' })
    await expect(client.openOfflineAccountProfile({ profileSelector })).resolves.toMatchObject({ ...lease, accessScope: 'offline_local' })
    await expect(client.ensureAccountProfile({ ...binding, issuer: 'issuer', subject: 'subject', accountAccessToken: 'token',
      keyHandle: 'keychain:one', unlockMaterial: 'material' })).resolves.toEqual({ profileId: lease.profileId, profileSelector })
    await expect(client.restoreProfile({ ...binding, profileSelector, keyHandle: 'keychain:one', unlockMaterial: 'material' }))
      .resolves.toEqual({ profileId: lease.profileId, profileSelector })
    await expect(client.bootstrapLocalProfile({ keyHandle: 'keychain:one', unlockMaterial: 'material' }))
      .resolves.toEqual({ profileId: lease.profileId, profileSelector, persistenceGeneration: 3 })
    await expect(client.restoreLocalProfile({ profileSelector, keyHandle: 'keychain:one', unlockMaterial: 'material' }))
      .resolves.toEqual({ profileId: lease.profileId, profileSelector, persistenceGeneration: 3 })
    await expect(client.openProfile(binding)).resolves.toEqual(lease)
    await expect(client.openLocalProfile({ profileSelector })).resolves.toEqual(lease)
    await expect(client.activateView(lease)).resolves.toMatchObject({ origin: 'http://127.0.0.1:43125', activationGeneration: 7 })
    await expect(client.extensions({ ...lease, command: { action: 'inventory', kind: 'skill' } }))
      .resolves.toEqual({ state: 'inventory', kind: 'skill', entries: [] })
    await expect(client.closeViewLease(lease)).resolves.toBeUndefined()
    await expect(client.getMigrationExportInventory({ sourceProfileSelector: profileSelector }))
      .resolves.toMatchObject({ schemaVersion: 1 })
    await expect(client.getMigrationExportInventory({ sourceProfileSelector: profileSelector, sourceInventoryAuthority: 'authority-1' }))
      .resolves.toMatchObject({ sourceGeneration: 'generation-1' })
    await expect(client.getExistingMigrationSourceInventory({ targetProfileSelector: profileSelector }))
      .resolves.toMatchObject({ sourceInventoryAuthority: 'authority-1' })
    await expect(client.beginMigrationExport({ sourceProfileSelector: profileSelector, expectedInventoryDigest: '2'.repeat(64),
      maxRecords: 8, maxBytes: 4_096 })).resolves.toMatchObject({ exportId: 'export-1', chunkCount: 1 })
    await expect(client.beginMigrationExport({ sourceProfileSelector: profileSelector, sourceInventoryAuthority: 'authority-1',
      expectedInventoryDigest: '2'.repeat(64), maxRecords: 8, maxBytes: 4_096 })).resolves.toMatchObject({ transferId: 'transfer-1' })
    await expect(client.readMigrationExport({ sourceProfileSelector: profileSelector, sourceInventoryAuthority: 'authority-1',
      exportId: 'export-1', chunkIndex: 0 })).resolves.toMatchObject({ records: [
      { id: 'session-1' }, { id: 'event-1', sessionId: 'session-1' },
    ] })
    await expect(client.readMigrationExport({ sourceProfileSelector: profileSelector, exportId: 'export-1', chunkIndex: 0 }))
      .resolves.toMatchObject({ final: true })
    const migration = { transferId: 'transfer-1', transferDigest: '5'.repeat(64), sourceInstallationId: installationId,
      sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', sourceSchemaVersion: 1,
      targetGeneration: 4, recordCount: 2, semanticDigest: '6'.repeat(64), targetProfileSelector: profileSelector }
    await expect(client.stageMigrationImport(migration)).resolves.toEqual({ importId: 'import-1', stageVersion: 1 })
    await expect(client.getMigrationImportStatus(migration)).resolves.toEqual({ importId: 'import-1', stageVersion: 2, state: 'verified' })
    await expect(client.verifyMigrationImport({ importId: 'import-1', expectedStageVersion: 1, targetProfileSelector: profileSelector }))
      .resolves.toEqual({ stageVersion: 2, semanticDigest: '6'.repeat(64) })
    await expect(client.commitMigrationImport({ importId: 'import-1', expectedStageVersion: 2,
      expectedCurrentGeneration: 3, targetProfileSelector: profileSelector })).resolves.toEqual({ stageVersion: 3, activeGeneration: 4 })
    await expect(client.abortMigrationImport({ importId: 'import-1', expectedStageVersion: 2, targetProfileSelector: profileSelector }))
      .resolves.toEqual({ stageVersion: 3 })
    expect(requests.every(frame => frame.type === 'request'
      && 'issued_at' in frame.params && frame.params.issued_at === 1_000)).toBe(true)
    client.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects optional operations before sending when the Host omitted their capabilities', async () => {
    const sent = vi.fn()
    const { client } = await makeClient((frame) => { sent(frame); return result(frame, {}) })
    ;(client.inspection.capabilities as HostControlCapability[]).splice(0)
    const calls = [
      () => client.inspectOfflineAccountProfiles({ profileKeyHandles: [] }),
      () => client.recoverOfflineAccountProfile({ profileKeyHandle: 'key', profileUnlockMaterial: 'material',
        recoveryOperationId: 'operation', candidateId: 'candidate', preflightDigest: '3'.repeat(64) }),
      () => client.getOfflineAccountRecoveryStatus({ recoveryOperationId: 'operation' }),
      () => client.openOfflineAccountProfile({ profileSelector }),
      () => client.ensureAccountProfile({ ...binding, issuer: 'issuer', subject: 'subject', accountAccessToken: 'token',
        keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.bootstrapLocalProfile({ keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.extensions({ ...lease, command: { action: 'inventory', kind: 'skill' } }),
    ]
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(sent).not.toHaveBeenCalled()
  })

  it('maps every authorized error code and redacts unknown server codes', async () => {
    const codes: HostControlErrorCode[] = [
      'profile_locked', 'profile_mismatch', 'unauthorized', 'replayed', 'stale', 'idempotency_conflict', 'conflict',
      'busy', 'upgrade_required', 'profile_not_found', 'profile_ambiguous', 'profile_integrity_failed',
      'runtime_incompatible', 'recovery_proof_mismatch', 'recovery_preflight_stale', 'recovery_in_progress',
      'recovery_worker_failed', 'recovery_timeout_unknown', 'scope_mismatch', 'selector_stale', 'lease_conflict',
      'internal_error',
    ]
    let index = 0
    const { client } = await makeClient(frame => ({
      version: 1, type: 'error', request_id: frame.request_id, method: frame.method,
      error: { code: codes[index++]!, retryable: false, correlation_id: 'correlation' as never },
    } as HostControlFrame))
    for (const code of codes) {
      await expect(client.getProfileStatus(binding)).rejects.toMatchObject({
        code: code === 'internal_error' ? 'unavailable' : code,
      })
    }
  })

  it('rejects a response whose frame kind does not match each requested operation', async () => {
    const { client } = await makeClient(frame => ({ ...frame, type: 'request' } as unknown as HostControlFrame))
    const migration = { transferId: 'transfer-1', transferDigest: '5'.repeat(64), sourceInstallationId: installationId,
      sourceInventoryDigest: '2'.repeat(64), sourceGeneration: 'generation-1', sourceSchemaVersion: 1,
      targetGeneration: 4, recordCount: 2, semanticDigest: '6'.repeat(64), targetProfileSelector: profileSelector }
    const calls = [
      () => client.getProfileStatus(binding),
      () => client.inspectOfflineAccountProfiles({ profileKeyHandles: [] }),
      () => client.recoverOfflineAccountProfile({ profileKeyHandle: 'key', profileUnlockMaterial: 'material',
        recoveryOperationId: 'operation', candidateId: 'candidate', preflightDigest: '3'.repeat(64) }),
      () => client.getOfflineAccountRecoveryStatus({ recoveryOperationId: 'operation' }),
      () => client.openOfflineAccountProfile({ profileSelector }),
      () => client.ensureAccountProfile({ ...binding, issuer: 'issuer', subject: 'subject', accountAccessToken: 'token',
        keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.restoreProfile({ ...binding, profileSelector, keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.bootstrapLocalProfile({ keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.restoreLocalProfile({ profileSelector, keyHandle: 'key', unlockMaterial: 'material' }),
      () => client.openProfile(binding),
      () => client.openLocalProfile({ profileSelector }),
      () => client.activateView(lease),
      () => client.extensions({ ...lease, command: { action: 'inventory', kind: 'skill' } }),
      () => client.closeViewLease(lease),
      () => client.getMigrationExportInventory({ sourceProfileSelector: profileSelector }),
      () => client.getExistingMigrationSourceInventory({ targetProfileSelector: profileSelector }),
      () => client.beginMigrationExport({ sourceProfileSelector: profileSelector, expectedInventoryDigest: '2'.repeat(64),
        maxRecords: 8, maxBytes: 4_096 }),
      () => client.readMigrationExport({ sourceProfileSelector: profileSelector, exportId: 'export-1', chunkIndex: 0 }),
      () => client.stageMigrationImport(migration),
      () => client.getMigrationImportStatus(migration),
      () => client.verifyMigrationImport({ importId: 'import-1', expectedStageVersion: 1, targetProfileSelector: profileSelector }),
      () => client.commitMigrationImport({ importId: 'import-1', expectedStageVersion: 2,
        expectedCurrentGeneration: 3, targetProfileSelector: profileSelector }),
      () => client.abortMigrationImport({ importId: 'import-1', expectedStageVersion: 2, targetProfileSelector: profileSelector }),
    ]
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('closes a transferred carrier when inspect is not a valid signed result', async () => {
    const close = vi.fn()
    const transport: HostClientFrameTransport = {
      call: async frame => ({ ...frame, type: 'request' } as unknown as HostControlFrame),
      isConnected: () => true,
      close,
    }
    await expect(UnixHostClient.connectAuthenticatedTransport({
      trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey,
      trustedExecutableSignatureDigest: digest,
    }, transport)).rejects.toMatchObject({ code: 'unavailable' })
    expect(close).toHaveBeenCalled()
  })

  it('rejects an installation key that cannot represent an Ed25519 public key', async () => {
    const shortKey = Buffer.alloc(31, 1).toString('base64url')
    const close = vi.fn()
    const transport: HostClientFrameTransport = {
      call: async (frame) => {
        const response = inspection(frame as HostInspectRequest)
        return { ...response, result: { ...response.result, installation_public_key: shortKey as never } }
      },
      isConnected: () => true,
      close,
    }
    await expect(UnixHostClient.connectAuthenticatedTransport({
      trustedInstallationId: installationId,
      trustedInstallationPublicKey: shortKey,
      trustedExecutableSignatureDigest: digest,
    }, transport)).rejects.toMatchObject({ code: 'unavailable' })
    expect(close).toHaveBeenCalled()
  })

  it('rejects an inspect result whose challenge signature does not verify', async () => {
    const close = vi.fn()
    const transport: HostClientFrameTransport = {
      call: async (frame) => {
        const response = inspection(frame as HostInspectRequest)
        return { ...response, result: { ...response.result, challenge_signature: 'A'.repeat(86) as never } }
      },
      isConnected: () => true,
      close,
    }
    await expect(UnixHostClient.connectAuthenticatedTransport({
      trustedInstallationId: installationId,
      trustedInstallationPublicKey: publicKey,
      trustedExecutableSignatureDigest: digest,
    }, transport)).rejects.toMatchObject({ code: 'unavailable' })
    expect(close).toHaveBeenCalled()
  })
})
