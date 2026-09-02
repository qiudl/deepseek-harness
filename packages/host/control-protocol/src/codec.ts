import type {
  HostControlCapability,
  HostAccountBindingHandle,
  HostAuthorityEnvironmentId,
  HostControlClientInstanceId,
  HostControlCorrelationId,
  HostControlJti,
  HostControlErrorCode,
  HostControlErrorFrame,
  HostControlFrame,
  HostControlNonce,
  HostControlPublicKey,
  HostControlRequestId,
  HostControlSha256,
  HostControlSignature,
  HostInspectRequest,
  HostInspectResult,
  HostInstanceId,
  InstallationId,
  HostProfileId,
  HostViewLeaseId,
  HostViewActivationHandle,
  ProfileLeaseCloseRequest,
  ProfileLeaseCloseResult,
  ProfileOpenRequest,
  ProfileOpenResult,
  ProfileViewActivateRequest,
  ProfileViewActivateResult,
  ProfileStatusRequest,
  ProfileStatusResult,
  ProfileEnsureRequest,
  ProfileEnsureResult,
  ProfileRestoreRequest,
  ProfileRestoreResult,
  MigrationExportBeginRequest,
  MigrationExportBeginResult,
  MigrationExportInventoryRequest,
  MigrationExportInventoryResult,
  MigrationExistingSourceInventoryRequest,
  MigrationExistingSourceInventoryResult,
  MigrationExportReadRequest,
  MigrationExportReadResult,
  MigrationExportRecord,
  HostMigrationTransferId,
  HostMigrationImportId,
  HostMigrationSourceAuthority,
  MigrationImportStageRequest,
  MigrationImportStageResult,
  MigrationImportStatusRequest,
  MigrationImportStatusResult,
  MigrationImportVerifyRequest,
  MigrationImportVerifyResult,
  MigrationImportCommitRequest,
  MigrationImportCommitResult,
  MigrationImportAbortRequest,
  MigrationImportAbortResult,
} from './types.ts'

/** Maximum UTF-8 bytes in one JSON object, excluding its terminating LF. */
export const HOST_CONTROL_MAX_FRAME_BYTES = 64 * 1024

/** Machine-readable reasons a local frame cannot be accepted. */
export type HostControlProtocolFailure =
  | 'invalid_frame'
  | 'frame_too_large'
  | 'unsupported_protocol'
  | 'unknown_method'

/** A safe local decoder failure; it never embeds untrusted frame contents. */
export class HostControlProtocolError extends Error {
  /** Stable failure category for broker/Host handling and metrics. */
  readonly code: HostControlProtocolFailure

  constructor(code: HostControlProtocolFailure) {
    super(`Host control protocol rejected frame: ${code}`)
    this.name = 'HostControlProtocolError'
    this.code = code
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Canonical unpadded base64url includes zero unused bits in its final character.
const NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/
const SHA256 = /^[0-9a-f]{64}$/
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/
const ERROR_CODES: ReadonlySet<string> = new Set<HostControlErrorCode>([
  'invalid_frame',
  'unsupported_protocol',
  'unknown_method',
  'unauthenticated',
  'unauthorized',
  'profile_locked',
  'profile_mismatch',
  'replayed',
  'stale',
  'idempotency_conflict',
  'conflict',
  'busy',
  'upgrade_required',
  'migration_required',
  'unavailable',
  'internal_error',
])

function reject(code: HostControlProtocolFailure = 'invalid_frame'): never {
  throw new HostControlProtocolError(code)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) reject()
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) reject()
  return value
}

function nonce(value: unknown): HostControlNonce {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostControlNonce
}

function publicKey(value: unknown): HostControlPublicKey {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostControlPublicKey
}

function signature(value: unknown): HostControlSignature {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) reject()
  return value as HostControlSignature
}

function digest(value: unknown): HostControlSha256 {
  if (typeof value !== 'string' || !SHA256.test(value)) reject()
  return value as HostControlSha256
}

function capability(value: unknown): HostControlCapability {
  if (typeof value !== 'string' || !CAPABILITY.test(value)) reject('unknown_method')
  return value as HostControlCapability
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) reject()
  return value as number
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject()
  return value as number
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) reject()
  return value as number
}

function exportId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32,64}$/u.test(value)) reject()
  return value
}

function transferId(value: unknown): HostMigrationTransferId {
  return exportId(value) as HostMigrationTransferId
}

function importId(value: unknown): HostMigrationImportId {
  return exportId(value) as HostMigrationImportId
}

function sourceAuthority(value: unknown): HostMigrationSourceAuthority {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostMigrationSourceAuthority
}

function opaqueHandle(value: unknown): HostAccountBindingHandle {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) reject()
  return value as HostAccountBindingHandle
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) reject()
  return value
}

function unlockMaterial(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value)) reject()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) reject()
  return value
}

function accountIssuer(value: unknown): string {
  const source = boundedText(value, 2048)
  let parsed: URL
  try { parsed = new URL(source) } catch { return reject() }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || source !== parsed.origin) reject()
  return parsed.origin
}

function activationHandle(value: unknown): HostViewActivationHandle {
  if (typeof value !== 'string' || !NONCE.test(value)) reject()
  return value as HostViewActivationHandle
}

function profileSelector(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,2048}\.[A-Za-z0-9_-]{86}$/u.test(value)) reject()
  return value
}

function exactLoopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(value)) reject()
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  if (port > 65_535) reject()
  return value
}

function bootstrapCookie(value: unknown): { readonly name: string; readonly value: string } {
  const cookie = record(value)
  exactKeys(cookie, ['name', 'value'])
  if (typeof cookie.name !== 'string' || !/^dsh-auth-[A-Za-z0-9_-]+$/u.test(cookie.name)
    || typeof cookie.value !== 'string' || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(cookie.value)) reject()
  return { name: cookie.name, value: cookie.value }
}

function capabilities(value: unknown): readonly HostControlCapability[] {
  if (!Array.isArray(value)) reject()
  const parsed = value.map(capability)
  if (parsed.some((entry, index) => index > 0 && entry <= (parsed[index - 1] ?? ''))) reject()
  if (!parsed.includes('host.inspect' as HostControlCapability)) reject()
  return parsed
}

function errorCode(value: unknown): HostControlErrorCode {
  if (typeof value !== 'string' || !ERROR_CODES.has(value)) reject()
  return value as HostControlErrorCode
}

function supportedVersions(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) reject('unsupported_protocol')
  if (value.some(entry => !Number.isSafeInteger(entry) || (entry as number) <= 0)) reject('unsupported_protocol')
  if (value.some((entry, index) => index > 0 && (entry as number) >= (value[index - 1] as number))) {
    reject('unsupported_protocol')
  }
  if (!value.includes(1)) reject('unsupported_protocol')
  return value as readonly number[]
}

function decodeInspectRequest(frame: Record<string, unknown>): HostInspectRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  exactKeys(params, ['challenge', 'client_instance_id', 'supported_versions'])
  const versions = supportedVersions(params.supported_versions)
  return {
    version: 1,
    type: 'request',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: 'host.inspect',
    params: {
      challenge: nonce(params.challenge),
      client_instance_id: uuid(params.client_instance_id) as HostControlClientInstanceId,
      supported_versions: versions,
    },
  }
}

function decodeInspectResult(frame: Record<string, unknown>): HostInspectResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  exactKeys(result, [
    'protocol_version',
    'host_instance_id',
    'installation_id',
    'installation_public_key',
    'runtime_generation',
    'schema_generation',
    'process_nonce',
    'capabilities',
    'challenge_signature',
    'executable_signature_digest',
  ])
  if (result.protocol_version !== 1) reject('unsupported_protocol')
  const hostInstanceId = uuid(result.host_instance_id)
  const installationId = uuid(result.installation_id)
  if (hostInstanceId === installationId) reject()
  return {
    version: 1,
    type: 'result',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: 'host.inspect',
    result: {
      protocol_version: 1,
      host_instance_id: hostInstanceId as HostInstanceId,
      installation_id: installationId as InstallationId,
      installation_public_key: publicKey(result.installation_public_key),
      runtime_generation: generation(result.runtime_generation),
      schema_generation: generation(result.schema_generation),
      process_nonce: nonce(result.process_nonce),
      capabilities: capabilities(result.capabilities),
      challenge_signature: signature(result.challenge_signature),
      executable_signature_digest: digest(result.executable_signature_digest),
    },
  }
}

const AUTHORIZED_KEYS = [
  'client_instance_id',
  'host_instance_id',
  'process_nonce',
  'jti',
  'issued_at',
  'expires_at',
] as const

function authorized(params: Record<string, unknown>): {
  client_instance_id: HostControlClientInstanceId
  host_instance_id: HostInstanceId
  process_nonce: HostControlNonce
  jti: HostControlJti
  issued_at: number
  expires_at: number
} {
  const issuedAt = timestamp(params.issued_at)
  const expiresAt = timestamp(params.expires_at)
  if (expiresAt <= issuedAt) reject()
  return {
    client_instance_id: uuid(params.client_instance_id) as HostControlClientInstanceId,
    host_instance_id: uuid(params.host_instance_id) as HostInstanceId,
    process_nonce: nonce(params.process_nonce),
    jti: uuid(params.jti) as HostControlJti,
    issued_at: issuedAt,
    expires_at: expiresAt,
  }
}

function decodeProfileRequest(frame: Record<string, unknown>):
  | ProfileStatusRequest | ProfileEnsureRequest | ProfileRestoreRequest
  | ProfileOpenRequest | ProfileViewActivateRequest | ProfileLeaseCloseRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  const requestId = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.status' || frame.method === 'profile.open') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
    ])
    const common = authorized(params)
    const authority_environment_id = uuid(params.authority_environment_id) as HostAuthorityEnvironmentId
    const account_binding_handle = opaqueHandle(params.account_binding_handle)
    const authority_binding_version = generation(params.authority_binding_version)
    return frame.method === 'profile.status'
      ? { version: 1, type: 'request', request_id: requestId, method: 'profile.status', params: { ...common, authority_environment_id, account_binding_handle, authority_binding_version } }
      : { version: 1, type: 'request', request_id: requestId, method: 'profile.open', params: { ...common, authority_environment_id, account_binding_handle, authority_binding_version } }
  }
  if (frame.method === 'profile.ensure') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'profile_key_handle',
      'profile_unlock_material',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.ensure',
      params: {
        ...authorized(params),
        authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
        account_binding_handle: opaqueHandle(params.account_binding_handle),
        authority_binding_version: generation(params.authority_binding_version),
        account_issuer: accountIssuer(params.account_issuer), account_subject: boundedText(params.account_subject, 512),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.restore') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'profile_key_handle', 'profile_unlock_material'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.restore',
      params: {
        ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.lease_close') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation'])
    return {
      version: 1,
      type: 'request',
      request_id: requestId,
      method: 'profile.lease_close',
      params: {
        ...authorized(params),
        view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
        lease_generation: generation(params.lease_generation),
        runtime_generation: generation(params.runtime_generation),
      },
    }
  }
  if (frame.method === 'profile.view_activate') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_id', 'view_lease_id', 'view_activation_handle',
      'lease_generation', 'runtime_generation',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.view_activate',
      params: {
        ...authorized(params),
        profile_id: uuid(params.profile_id) as HostProfileId,
        view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
        view_activation_handle: activationHandle(params.view_activation_handle),
        lease_generation: generation(params.lease_generation),
        runtime_generation: generation(params.runtime_generation),
      },
    }
  }
  return reject('unknown_method')
}

function decodeProfileResult(frame: Record<string, unknown>):
  | ProfileStatusResult | ProfileEnsureResult | ProfileRestoreResult
  | ProfileOpenResult | ProfileViewActivateResult | ProfileLeaseCloseResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.status') {
    if (result.state === 'ready') {
      exactKeys(result, ['state', 'profile_id', 'persistence_generation'])
      return { version: 1, type: 'result', request_id, method: 'profile.status', result: {
        state: 'ready', profile_id: uuid(result.profile_id) as HostProfileId,
        persistence_generation: generation(result.persistence_generation),
      } }
    }
    exactKeys(result, ['state'])
    if (result.state !== 'unbound' && result.state !== 'locked') reject()
    return { version: 1, type: 'result', request_id, method: 'profile.status', result: { state: result.state } }
  }
  if (frame.method === 'profile.ensure') {
    exactKeys(result, ['state', 'profile_id', 'profile_selector'])
    if (result.state !== 'ready') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.ensure',
      result: {
        state: 'ready', profile_id: uuid(result.profile_id) as HostProfileId,
        profile_selector: profileSelector(result.profile_selector),
      },
    }
  }
  if (frame.method === 'profile.restore') {
    exactKeys(result, ['state', 'profile_id', 'profile_selector'])
    if (result.state !== 'ready') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.restore',
      result: {
        state: 'ready', profile_id: uuid(result.profile_id) as HostProfileId,
        profile_selector: profileSelector(result.profile_selector),
      },
    }
  }
  if (frame.method === 'profile.open') {
    exactKeys(result, ['profile_id', 'view_lease_id', 'view_activation_handle', 'lease_generation', 'expires_at', 'runtime_generation'])
    return {
      version: 1,
      type: 'result',
      request_id,
      method: 'profile.open',
      result: {
        profile_id: uuid(result.profile_id) as HostProfileId,
        view_lease_id: uuid(result.view_lease_id) as HostViewLeaseId,
        view_activation_handle: activationHandle(result.view_activation_handle),
        lease_generation: generation(result.lease_generation),
        expires_at: timestamp(result.expires_at),
        runtime_generation: generation(result.runtime_generation),
      },
    }
  }
  if (frame.method === 'profile.view_activate') {
    exactKeys(result, ['origin', 'activation_generation', 'expires_at', 'bootstrap_cookie'])
    return {
      version: 1, type: 'result', request_id, method: 'profile.view_activate',
      result: {
        origin: exactLoopbackOrigin(result.origin),
        activation_generation: generation(result.activation_generation),
        expires_at: timestamp(result.expires_at),
        bootstrap_cookie: bootstrapCookie(result.bootstrap_cookie),
      },
    }
  }
  if (frame.method === 'profile.lease_close') {
    exactKeys(result, ['closed'])
    if (result.closed !== true) reject()
    return { version: 1, type: 'result', request_id, method: 'profile.lease_close', result: { closed: true } }
  }
  return reject('unknown_method')
}

function decodeMigrationRequest(frame: Record<string, unknown>):
  | MigrationExistingSourceInventoryRequest
  | MigrationExportInventoryRequest
  | MigrationExportBeginRequest
  | MigrationExportReadRequest
  | MigrationImportStageRequest
  | MigrationImportStatusRequest
  | MigrationImportVerifyRequest
  | MigrationImportCommitRequest
  | MigrationImportAbortRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'migration.existing_source.inventory') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.existing_source.inventory',
      params: { ...authorized(params), target_profile_selector: profileSelector(params.target_profile_selector) },
    }
  }
  if (frame.method === 'migration.export_snapshot.inventory') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.inventory',
      params: {
        ...authorized(params), source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.begin') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
      'expected_inventory_digest', 'max_records', 'max_bytes',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.begin',
      params: {
        ...authorized(params),
        source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
        expected_inventory_digest: digest(params.expected_inventory_digest),
        max_records: generation(params.max_records),
        max_bytes: generation(params.max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.read') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'source_profile_selector',
      ...('source_inventory_authority' in params ? ['source_inventory_authority'] : []),
      'export_id', 'chunk_index',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.export_snapshot.read',
      params: {
        ...authorized(params),
        source_profile_selector: profileSelector(params.source_profile_selector),
        ...('source_inventory_authority' in params
          ? { source_inventory_authority: sourceAuthority(params.source_inventory_authority) } : {}),
        export_id: exportId(params.export_id),
        chunk_index: nonnegative(params.chunk_index),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.stage') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'transfer_id', 'transfer_digest', 'source_installation_id',
      'source_inventory_digest', 'source_generation', 'source_schema_version', 'target_generation',
      'target_profile_selector', 'record_count', 'semantic_digest',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.stage',
      params: {
        ...authorized(params),
        transfer_id: transferId(params.transfer_id),
        transfer_digest: digest(params.transfer_digest),
        source_installation_id: uuid(params.source_installation_id) as InstallationId,
        source_inventory_digest: digest(params.source_inventory_digest),
        source_generation: digest(params.source_generation),
        source_schema_version: nonnegative(params.source_schema_version),
        target_generation: generation(params.target_generation),
        target_profile_selector: profileSelector(params.target_profile_selector),
        record_count: nonnegative(params.record_count),
        semantic_digest: digest(params.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.status') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'transfer_id', 'target_generation', 'source_installation_id',
      'target_profile_selector',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.status',
      params: {
        ...authorized(params), transfer_id: transferId(params.transfer_id),
        target_generation: generation(params.target_generation),
        source_installation_id: uuid(params.source_installation_id) as InstallationId,
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.verify') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.verify',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.commit') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'expected_current_generation', 'target_profile_selector',
    ])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.commit',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        expected_current_generation: generation(params.expected_current_generation),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.abort') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'import_id', 'expected_stage_version', 'target_profile_selector'])
    return {
      version: 1, type: 'request', request_id, method: 'migration.import_snapshot.abort',
      params: {
        ...authorized(params), import_id: importId(params.import_id),
        expected_stage_version: generation(params.expected_stage_version),
        target_profile_selector: profileSelector(params.target_profile_selector),
      },
    }
  }
  return reject('unknown_method')
}

function migrationRecord(value: unknown): MigrationExportRecord {
  const row = record(value)
  if (row.collection === 'sessions') exactKeys(row, ['collection', 'id', 'sequence', 'payload_digest'])
  else if (row.collection === 'session_events') exactKeys(row, ['collection', 'id', 'session_id', 'sequence', 'payload_digest'])
  else if (['owner_settings', 'owner_credentials', 'owner_workspace', 'owner_profile'].includes(String(row.collection))) {
    exactKeys(row, ['collection', 'id', 'sequence', 'payload_digest'])
  }
  else reject()
  if (typeof row.id !== 'string' || !/^[a-f0-9]{32}$/u.test(row.id)
    || (row.session_id !== undefined && (typeof row.session_id !== 'string' || !/^[a-f0-9]{32}$/u.test(row.session_id)))) {
    reject()
  }
  return {
    collection: row.collection as MigrationExportRecord['collection'],
    id: row.id,
    ...(row.session_id === undefined ? {} : { session_id: row.session_id }),
    sequence: nonnegative(row.sequence),
    payload_digest: digest(row.payload_digest),
  }
}

function decodeMigrationResult(frame: Record<string, unknown>):
  | MigrationExistingSourceInventoryResult
  | MigrationExportInventoryResult
  | MigrationExportBeginResult
  | MigrationExportReadResult
  | MigrationImportStageResult
  | MigrationImportStatusResult
  | MigrationImportVerifyResult
  | MigrationImportCommitResult
  | MigrationImportAbortResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'migration.existing_source.inventory') {
    exactKeys(result, [
      'source_inventory_authority', 'source_installation_id', 'expires_at', 'inventory_digest', 'source_generation',
      'schema_version', 'required_max_records', 'required_max_bytes',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.existing_source.inventory',
      result: {
        source_inventory_authority: sourceAuthority(result.source_inventory_authority),
        source_installation_id: uuid(result.source_installation_id) as InstallationId,
        expires_at: timestamp(result.expires_at),
        inventory_digest: digest(result.inventory_digest),
        source_generation: digest(result.source_generation),
        schema_version: nonnegative(result.schema_version),
        required_max_records: nonnegative(result.required_max_records),
        required_max_bytes: nonnegative(result.required_max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.inventory') {
    exactKeys(result, [
      'inventory_digest', 'source_generation', 'schema_version', 'required_max_records', 'required_max_bytes',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.inventory',
      result: {
        inventory_digest: digest(result.inventory_digest),
        source_generation: digest(result.source_generation),
        schema_version: nonnegative(result.schema_version),
        required_max_records: nonnegative(result.required_max_records),
        required_max_bytes: nonnegative(result.required_max_bytes),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.begin') {
    exactKeys(result, [
      'export_id', 'transfer_id', 'transfer_digest', 'schema_version', 'source_generation',
      'record_count', 'first_event_sequence', 'last_event_sequence', 'semantic_digest', 'chunk_count',
    ])
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.begin',
      result: {
        export_id: exportId(result.export_id),
        transfer_id: transferId(result.transfer_id),
        transfer_digest: digest(result.transfer_digest),
        schema_version: nonnegative(result.schema_version),
        source_generation: digest(result.source_generation),
        record_count: nonnegative(result.record_count), first_event_sequence: nonnegative(result.first_event_sequence),
        last_event_sequence: nonnegative(result.last_event_sequence),
        semantic_digest: digest(result.semantic_digest),
        chunk_count: generation(result.chunk_count),
      },
    }
  }
  if (frame.method === 'migration.export_snapshot.read') {
    exactKeys(result, ['export_id', 'chunk_index', 'records', 'chunk_digest', 'final'])
    if (!Array.isArray(result.records) || result.records.length > 4096 || typeof result.final !== 'boolean') reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.export_snapshot.read',
      result: {
        export_id: exportId(result.export_id),
        chunk_index: nonnegative(result.chunk_index),
        records: result.records.map(migrationRecord),
        chunk_digest: digest(result.chunk_digest),
        final: result.final,
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.stage') {
    exactKeys(result, [
      'import_id', 'stage_version', 'state', 'target_generation', 'record_count', 'semantic_digest',
    ])
    if (result.state !== 'staged') reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.stage',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        state: 'staged', target_generation: generation(result.target_generation),
        record_count: nonnegative(result.record_count), semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.status') {
    exactKeys(result, [
      'import_id', 'stage_version', 'state', 'target_generation', 'record_count', 'semantic_digest',
    ])
    if (!['preparing', 'staged', 'verified', 'committed', 'aborted'].includes(result.state as string)) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.status',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        state: result.state as MigrationImportStatusResult['result']['state'],
        target_generation: generation(result.target_generation), record_count: nonnegative(result.record_count),
        semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.verify') {
    exactKeys(result, ['import_id', 'stage_version', 'verified', 'semantic_digest'])
    if (result.verified !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.verify',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        verified: true, semantic_digest: digest(result.semantic_digest),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.commit') {
    exactKeys(result, ['import_id', 'stage_version', 'committed', 'active_generation'])
    if (result.committed !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.commit',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version),
        committed: true, active_generation: generation(result.active_generation),
      },
    }
  }
  if (frame.method === 'migration.import_snapshot.abort') {
    exactKeys(result, ['import_id', 'stage_version', 'aborted'])
    if (result.aborted !== true) reject()
    return {
      version: 1, type: 'result', request_id, method: 'migration.import_snapshot.abort',
      result: {
        import_id: importId(result.import_id), stage_version: generation(result.stage_version), aborted: true,
      },
    }
  }
  return reject('unknown_method')
}

function decodeError(frame: Record<string, unknown>): HostControlErrorFrame {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'error'])
  const error = record(frame.error)
  exactKeys(error, ['code', 'retryable', 'correlation_id'])
  if (typeof error.retryable !== 'boolean') reject()
  return {
    version: 1,
    type: 'error',
    request_id: uuid(frame.request_id) as HostControlRequestId,
    method: capability(frame.method),
    error: {
      code: errorCode(error.code),
      retryable: error.retryable,
      correlation_id: uuid(error.correlation_id) as HostControlCorrelationId,
    },
  }
}

function decodeObject(value: unknown): HostControlFrame {
  const frame = record(value)
  if (frame.version !== 1) reject('unsupported_protocol')
  if (frame.type === 'error') return decodeError(frame)
  if (frame.method === 'host.inspect') {
    if (frame.type === 'request') return decodeInspectRequest(frame)
    if (frame.type === 'result') return decodeInspectResult(frame)
    return reject()
  }
  if (typeof frame.method === 'string' && frame.method.startsWith('migration.')) {
    if (frame.type === 'request') return decodeMigrationRequest(frame)
    if (frame.type === 'result') return decodeMigrationResult(frame)
    return reject()
  }
  if (frame.type === 'request') return decodeProfileRequest(frame)
  if (frame.type === 'result') return decodeProfileResult(frame)
  return reject()
}

/**
 * Encode one canonical JSON-Lines frame. Key order, LF termination, finite
 * numbers, and frame size are part of the wire contract.
 * @param frame - typed Host control frame to validate at runtime.
 * @returns canonical LF-terminated JSON frame.
 */
export function encodeHostControlFrame(frame: HostControlFrame): string {
  const normalized = decodeObject(frame)
  const encoded = `${JSON.stringify(normalized)}\n`
  if (new TextEncoder().encode(encoded.slice(0, -1)).byteLength > HOST_CONTROL_MAX_FRAME_BYTES) {
    reject('frame_too_large')
  }
  return encoded
}

/**
 * Decode exactly one canonical, LF-terminated frame. Malformed input is never
 * skipped: callers must close the connection after any thrown error.
 * @param source - one complete LF-terminated frame.
 * @returns validated Host control frame.
 */
export function decodeHostControlFrame(source: string): HostControlFrame {
  if (!source.endsWith('\n') || source.endsWith('\r\n') || source.indexOf('\n') !== source.length - 1) reject()
  const body = source.slice(0, -1)
  if (new TextEncoder().encode(body).byteLength > HOST_CONTROL_MAX_FRAME_BYTES) reject('frame_too_large')
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return reject()
  }
  const frame = decodeObject(parsed)
  if (encodeHostControlFrame(frame) !== source) reject()
  return frame
}

/**
 * Build the exact UTF-8 signing statement for a `host.inspect` response. It
 * binds both sides' nonces and identities plus every negotiated Host fact; the
 * signature field itself is deliberately excluded.
 * @param request - fresh Desktop inspection challenge.
 * @param response - Host inspection result whose signature field is excluded.
 * @returns domain-separated UTF-8 signing bytes.
 */
export function encodeHostInspectSignaturePayload(
  request: HostInspectRequest,
  response: HostInspectResult,
): Uint8Array {
  const checkedRequest = decodeObject(request)
  const checkedResponse = decodeObject(response)
  if (checkedRequest.type !== 'request' || checkedRequest.method !== 'host.inspect'
      || checkedResponse.type !== 'result' || checkedResponse.method !== 'host.inspect') reject()
  if (checkedRequest.request_id !== checkedResponse.request_id) reject()
  const statement = {
    domain: 'dsh-host-control/host.inspect-signature/v1',
    request_id: checkedRequest.request_id,
    challenge: checkedRequest.params.challenge,
    client_instance_id: checkedRequest.params.client_instance_id,
    protocol_version: checkedResponse.result.protocol_version,
    host_instance_id: checkedResponse.result.host_instance_id,
    installation_id: checkedResponse.result.installation_id,
    installation_public_key: checkedResponse.result.installation_public_key,
    runtime_generation: checkedResponse.result.runtime_generation,
    schema_generation: checkedResponse.result.schema_generation,
    process_nonce: checkedResponse.result.process_nonce,
    capabilities: checkedResponse.result.capabilities,
    executable_signature_digest: checkedResponse.result.executable_signature_digest,
  }
  return new TextEncoder().encode(`${JSON.stringify(statement)}\n`)
}
