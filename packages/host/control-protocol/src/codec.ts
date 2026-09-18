import type {
  HostExtensionPlanId, HostExtensionOperationId, HostExtensionKind, HostExtensionCommand, HostExtensionResponse,
  ProfileExtensionsRequest, ProfileExtensionsResult,
  ProfileModelClaimInventoryRequest, ProfileModelClaimInventoryResult,
  ProfileModelClaimConfirmRequest, ProfileModelClaimConfirmResult,
  ProfileModelClaimApplyRequest, ProfileModelClaimApplyResult,
  ProfileModelClaimRecoveryInventoryRequest, ProfileModelClaimRecoveryInventoryResult,
  ProfileModelClaimRecoveryStatusRequest, ProfileModelClaimRecoveryStatusResult,
  ProfileModelClaimRestoreRequest, ProfileModelClaimRestoreResult,
  ProfileModelClaimRetryRequest, ProfileModelClaimRetryResult,
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
  ProfileModelTextRequest,
  ProfileModelTextResult,
  ProfileStatusRequest,
  ProfileStatusResult,
  ProfileEnsureRequest,
  ProfileEnsureResult,
  ProfileBootstrapLocalRequest,
  ProfileBootstrapLocalResult,
  ProfileRestoreLocalRequest,
  ProfileRestoreLocalResult,
  ProfileOpenLocalRequest,
  ProfileOpenLocalResult,
  ProfileRestoreRequest,
  ProfileRestoreResult,
  ProfileRecoveryInspectRequest,
  ProfileRecoveryInspectResult,
  ProfileRecoverOfflineAccountRequest,
  ProfileRecoverOfflineAccountResult,
  ProfileOpenOfflineAccountRequest,
  ProfileOpenOfflineAccountResult,
  ProfileRecoveryStatusRequest,
  ProfileRecoveryStatusResult,
  HostRecoveryCandidateId,
  HostRecoveryOperationId,
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
  'profile_not_found',
  'profile_ambiguous',
  'profile_integrity_failed',
  'runtime_incompatible',
  'recovery_proof_mismatch',
  'recovery_preflight_stale',
  'recovery_in_progress',
  'recovery_worker_failed',
  'recovery_timeout_unknown',
  'scope_mismatch',
  'selector_stale',
  'lease_conflict',
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

function modelClaimCandidate(value: unknown): string {
  if (typeof value !== 'string'
    || !/^(?:llm-deepseek|llm-pi-ai|web-search-deepseek):[a-z][a-z0-9-]{0,63}$/u.test(value)) reject()
  return value
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
  let previous: HostControlCapability | undefined
  for (const entry of parsed) {
    if (previous !== undefined && entry <= previous) reject()
    previous = entry
  }
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

function extensionKind(value: unknown): HostExtensionKind {
  if (value !== 'plugin' && value !== 'mcp' && value !== 'skill') reject()
  return value
}
function extensionCommand(value: unknown): HostExtensionCommand {
  const command = record(value)
  if (command.action === 'inventory') {
    exactKeys(command, ['action', 'kind'])
    return { action: 'inventory', kind: extensionKind(command.kind) }
  }
  if (command.action === 'prepare') {
    exactKeys(command, ['action', 'kind', 'payload'])
    if (typeof command.payload !== 'string' || !command.payload || new TextEncoder().encode(command.payload).byteLength > 32_768) reject()
    return { action: 'prepare', kind: extensionKind(command.kind), payload: command.payload }
  }
  if (command.action === 'commit') {
    exactKeys(command, ['action', 'plan_id', 'operation_id'])
    return { action: 'commit', plan_id: uuid(command.plan_id) as HostExtensionPlanId,
      operation_id: uuid(command.operation_id) as HostExtensionOperationId }
  }
  if (command.action === 'status' || command.action === 'cancel') {
    exactKeys(command, ['action', 'operation_id'])
    return { action: command.action, operation_id: uuid(command.operation_id) as HostExtensionOperationId }
  }
  return reject()
}
function extensionResponse(result: Record<string, unknown>): HostExtensionResponse {
  if (result.state === 'prepared') {
    exactKeys(result, ['state', 'plan_id', 'kind', 'digest', 'expires_at'])
    return { state: 'prepared', plan_id: uuid(result.plan_id) as HostExtensionPlanId, kind: extensionKind(result.kind),
      digest: digest(result.digest), expires_at: timestamp(result.expires_at) }
  }
  if (result.state === 'inventory') {
    exactKeys(result, ['state', 'kind', 'entries', ...('plugin_remove' in result ? ['plugin_remove'] : []), ...('plugin_update' in result ? ['plugin_update'] : []), ...('plugin_toggle' in result ? ['plugin_toggle'] : []), ...('skill_archives' in result ? ['skill_archives'] : []), ...('skill_remove' in result ? ['skill_remove'] : []), ...('skill_replace' in result ? ['skill_replace'] : []), ...('skill_files' in result ? ['skill_files'] : []), ...('skill_invocation' in result ? ['skill_invocation'] : []), ...('mcp_remove' in result ? ['mcp_remove'] : []), ...('mcp_update' in result ? ['mcp_update'] : [])])
    if ('mcp_update' in result && (result.kind !== 'mcp' || typeof result.mcp_update !== 'boolean')) reject()
    if ('mcp_remove' in result && (result.kind !== 'mcp' || typeof result.mcp_remove !== 'boolean')) reject()
    if ('skill_invocation' in result && (result.kind !== 'skill' || typeof result.skill_invocation !== 'boolean')) reject()
    if ('plugin_remove' in result && (result.kind !== 'plugin' || typeof result.plugin_remove !== 'boolean')) reject()
    if ('plugin_update' in result && (result.kind !== 'plugin' || typeof result.plugin_update !== 'boolean')) reject()
    if ('plugin_toggle' in result && (result.kind !== 'plugin' || typeof result.plugin_toggle !== 'boolean')) reject()
    if ('skill_remove' in result && (result.kind !== 'skill' || typeof result.skill_remove !== 'boolean')) reject()
    if ('skill_replace' in result && (result.kind !== 'skill' || typeof result.skill_replace !== 'boolean')) reject()
    if ('skill_files' in result && (result.kind !== 'skill' || typeof result.skill_files !== 'boolean')) reject()
    if ('skill_archives' in result && typeof result.skill_archives !== 'boolean') reject()
    if (!Array.isArray(result.entries) || result.entries.length > 128) reject()
    const entries = result.entries.map((value: unknown) => {
      const entry = record(value)
      const invocation = 'model_invocable' in entry || 'user_invocable' in entry
      exactKeys(entry, ['id', 'name', 'transport', ...(invocation ? ['model_invocable', 'user_invocable'] : []), ...('plugin_state' in entry ? ['plugin_state'] : []), ...('skill_source' in entry ? ['skill_source', 'skill_status'] : []), ...('effective_source' in entry ? ['effective_source'] : [])])
      if ('skill_source' in entry && (result.kind !== 'skill' || !invocation
        || typeof entry.skill_source !== 'string' || !['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(entry.skill_source)
        || typeof entry.skill_status !== 'string' || !['effective', 'shadowed', 'not_visible'].includes(entry.skill_status))) reject()
      if ('effective_source' in entry && (entry.skill_status !== 'shadowed' || typeof entry.effective_source !== 'string'
        || !['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(entry.effective_source))) reject()
      if (entry.skill_status === 'shadowed' && !('effective_source' in entry)) reject()
      if ('plugin_state' in entry && (result.kind !== 'plugin' || typeof entry.plugin_state !== 'string'
        || !['enabled', 'disabled', 'mixed', 'unsupported'].includes(entry.plugin_state))) reject()
      if (invocation && (result.kind !== 'skill' || typeof entry.model_invocable !== 'boolean' || typeof entry.user_invocable !== 'boolean')) reject()
      for (const key of ['id', 'name', 'transport']) {
        const pattern = result.kind === 'plugin' && key === 'name'
          ? /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u : /^[A-Za-z0-9_-]{1,128}$/u
        if (typeof entry[key] !== 'string' || entry[key].length > 214 || !pattern.test(entry[key])) reject()
      }
      return { id: entry.id as string, name: entry.name as string, transport: entry.transport as string,
        ...(invocation ? { model_invocable: entry.model_invocable as boolean, user_invocable: entry.user_invocable as boolean } : {}),
        ...('plugin_state' in entry ? { plugin_state: entry.plugin_state as 'enabled' | 'disabled' | 'mixed' | 'unsupported' } : {}),
        ...('skill_source' in entry ? { skill_source: entry.skill_source as 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other', skill_status: entry.skill_status as 'effective' | 'shadowed' | 'not_visible' } : {}),
        ...('effective_source' in entry ? { effective_source: entry.effective_source as 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other' } : {}) }
    })
    return { state: 'inventory', kind: extensionKind(result.kind), entries, ...('plugin_remove' in result ? { plugin_remove: result.plugin_remove as boolean } : {}), ...('plugin_update' in result ? { plugin_update: result.plugin_update as boolean } : {}), ...('plugin_toggle' in result ? { plugin_toggle: result.plugin_toggle as boolean } : {}), ...('skill_archives' in result ? { skill_archives: result.skill_archives as boolean } : {}), ...('skill_remove' in result ? { skill_remove: result.skill_remove as boolean } : {}), ...('skill_replace' in result ? { skill_replace: result.skill_replace as boolean } : {}), ...('skill_files' in result ? { skill_files: result.skill_files as boolean } : {}), ...('skill_invocation' in result ? { skill_invocation: result.skill_invocation as boolean } : {}), ...('mcp_remove' in result ? { mcp_remove: result.mcp_remove as boolean } : {}), ...('mcp_update' in result ? { mcp_update: result.mcp_update as boolean } : {}) }
  }
  if (result.state !== 'receipt') reject()
  exactKeys(result, ['state', 'operation_id', 'outcome', 'cancellation_requested', 'created_at', 'updated_at',
    ...(result.reason === undefined ? [] : ['reason']), ...(result.skill_source === undefined ? [] : ['skill_source']),
    ...('skill_restore' in result ? ['skill_restore'] : []), ...('mcp_restore' in result ? ['mcp_restore'] : []), ...('plugin_restore' in result ? ['plugin_restore'] : []), ...('plugin_complete' in result ? ['plugin_complete'] : []), ...('restored_by' in result ? ['restored_by'] : []),
    ...('restores_operation' in result ? ['restores_operation'] : []), ...('completed_by' in result ? ['completed_by'] : []),
    ...('completes_operation' in result ? ['completes_operation'] : [])])
  if (typeof result.outcome !== 'string' || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(result.outcome)
    || typeof result.cancellation_requested !== 'boolean') reject()
  if (result.skill_source !== undefined && (result.outcome !== 'succeeded' || typeof result.skill_source !== 'string'
    || !['absent', 'user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(result.skill_source))) reject()
  if ('skill_restore' in result && (result.outcome !== 'unknown' || typeof result.skill_restore !== 'string' || result.skill_restore.length > 71 || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result.skill_restore) || 'restored_by' in result || 'mcp_restore' in result || 'plugin_restore' in result)) reject()
  if ('mcp_restore' in result && (result.outcome !== 'unknown' || result.mcp_restore !== true || 'restored_by' in result || 'skill_restore' in result || 'plugin_restore' in result)) reject()
  if ('plugin_restore' in result && (result.outcome !== 'unknown' || typeof result.plugin_restore !== 'string'
    || result.plugin_restore.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(result.plugin_restore)
    || 'restored_by' in result || 'skill_restore' in result || 'mcp_restore' in result)) reject()
  let completion: Extract<HostExtensionResponse, { state: 'receipt' }>['plugin_complete']
  if ('plugin_complete' in result) {
    if (result.outcome !== 'unknown') reject()
    const intent = record(result.plugin_complete)
    exactKeys(intent, ['action', 'package_name', ...('spec' in intent ? ['spec'] : [])])
    if (typeof intent.action !== 'string' || !['install', 'update', 'remove'].includes(intent.action) || typeof intent.package_name !== 'string'
      || intent.package_name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(intent.package_name)
      || (intent.action === 'remove' ? 'spec' in intent : typeof intent.spec !== 'string' || intent.spec.length > 256 || !/^[A-Za-z0-9@/._+#:-]+$/u.test(intent.spec))) reject()
    completion = { action: intent.action as 'install' | 'update' | 'remove', package_name: intent.package_name,
      ...('spec' in intent ? { spec: intent.spec as string } : {}) }
  }
  const capabilities = ['skill_restore', 'mcp_restore', 'plugin_restore', 'plugin_complete'].filter(key => key in result)
  if (capabilities.length > 1 || capabilities.length && ('restored_by' in result || 'completed_by' in result)) reject()
  if ('completed_by' in result && (result.outcome !== 'unknown' || uuid(result.completed_by) === result.operation_id || 'restored_by' in result)) reject()
  if ('completes_operation' in result && (uuid(result.completes_operation) === result.operation_id || 'restores_operation' in result)) reject()
  if ('restored_by' in result && (result.outcome !== 'unknown' || uuid(result.restored_by) === result.operation_id)) reject()
  if ('restores_operation' in result && uuid(result.restores_operation) === result.operation_id) reject()
  const created = timestamp(result.created_at); const updated = timestamp(result.updated_at)
  if (updated < created) reject()
  if (result.reason !== undefined && (typeof result.reason !== 'string'
    || !['revision_conflict', 'authority_revoked', 'expired', 'interrupted', 'executor_failed'].includes(result.reason))) reject()
  return { state: 'receipt', operation_id: uuid(result.operation_id) as HostExtensionOperationId,
    outcome: result.outcome as Extract<HostExtensionResponse, { state: 'receipt' }>['outcome'],
    cancellation_requested: result.cancellation_requested, created_at: created, updated_at: updated,
    ...(result.reason === undefined ? {} : { reason: result.reason as NonNullable<Extract<HostExtensionResponse, { state: 'receipt' }>['reason']> }),
    ...(result.skill_source === undefined ? {} : { skill_source: result.skill_source as NonNullable<Extract<HostExtensionResponse, { state: 'receipt' }>['skill_source']> }),
    ...('skill_restore' in result ? { skill_restore: result.skill_restore as string } : {}),
    ...('mcp_restore' in result ? { mcp_restore: true as const } : {}),
    ...('plugin_restore' in result ? { plugin_restore: result.plugin_restore as string } : {}),
    ...(completion ? { plugin_complete: completion } : {}),
    ...('restored_by' in result ? { restored_by: uuid(result.restored_by) as HostExtensionOperationId } : {}),
    ...('restores_operation' in result ? { restores_operation: uuid(result.restores_operation) as HostExtensionOperationId } : {}),
    ...('completed_by' in result ? { completed_by: uuid(result.completed_by) as HostExtensionOperationId } : {}),
    ...('completes_operation' in result ? { completes_operation: uuid(result.completes_operation) as HostExtensionOperationId } : {}),
  }
}

function decodeProfileRequest(frame: Record<string, unknown>):
  | ProfileStatusRequest | ProfileEnsureRequest | ProfileRestoreRequest
  | ProfileBootstrapLocalRequest | ProfileRestoreLocalRequest | ProfileOpenRequest | ProfileOpenLocalRequest
  | ProfileRecoveryInspectRequest | ProfileRecoverOfflineAccountRequest
  | ProfileOpenOfflineAccountRequest | ProfileRecoveryStatusRequest
  | ProfileViewActivateRequest | ProfileModelTextRequest | ProfileLeaseCloseRequest | ProfileExtensionsRequest
  | ProfileModelClaimInventoryRequest | ProfileModelClaimConfirmRequest | ProfileModelClaimApplyRequest
  | ProfileModelClaimRecoveryInventoryRequest
  | ProfileModelClaimRecoveryStatusRequest | ProfileModelClaimRestoreRequest | ProfileModelClaimRetryRequest {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'params'])
  const params = record(frame.params)
  const requestId = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.model_claim_confirm') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation',
      'candidate_id', 'source_digest'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      candidate_id: modelClaimCandidate(params.candidate_id), source_digest: digest(params.source_digest),
    } }
  }
  if (frame.method === 'profile.model_claim_apply') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'confirmation'])
    return { version: 1, type: 'request', request_id: requestId, method: frame.method,
      params: { ...authorized(params), confirmation: sourceAuthority(params.confirmation) } }
  }
  if (frame.method === 'profile.model_claim_recovery_inventory'
    || frame.method === 'profile.model_claim_recovery_status' || frame.method === 'profile.model_claim_restore'
    || frame.method === 'profile.model_claim_retry') {
    const proofKeys = [
      ...AUTHORIZED_KEYS, 'account_access_token', 'account_issuer', 'account_subject',
      'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
      'profile_key_handle', 'profile_unlock_material',
    ]
    exactKeys(params, frame.method === 'profile.model_claim_recovery_inventory' ? proofKeys
      : frame.method === 'profile.model_claim_restore' ? [...proofKeys, 'candidate_id', 'operation_id']
        : frame.method === 'profile.model_claim_retry' ? [...proofKeys, 'candidate_id', 'operation_id', 'source_digest']
          : [...proofKeys, 'candidate_id'])
    const proof = {
      ...authorized(params),
      account_access_token: boundedText(params.account_access_token, 8_192),
      account_issuer: accountIssuer(params.account_issuer),
      account_subject: boundedText(params.account_subject, 512),
      authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
      account_binding_handle: opaqueHandle(params.account_binding_handle),
      authority_binding_version: generation(params.authority_binding_version),
      profile_key_handle: boundedText(params.profile_key_handle, 512),
      profile_unlock_material: unlockMaterial(params.profile_unlock_material),
    }
    if (frame.method === 'profile.model_claim_recovery_inventory') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method, params: proof }
    }
    const candidate_id = modelClaimCandidate(params.candidate_id)
    if (frame.method === 'profile.model_claim_restore') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...proof, candidate_id, operation_id: uuid(params.operation_id) } }
    }
    if (frame.method === 'profile.model_claim_retry') {
      return { version: 1, type: 'request', request_id: requestId, method: frame.method,
        params: { ...proof, candidate_id, operation_id: uuid(params.operation_id), source_digest: digest(params.source_digest) } }
    }
    return { version: 1, type: 'request', request_id: requestId,
      method: 'profile.model_claim_recovery_status', params: { ...proof, candidate_id } }
  }
  if (frame.method === 'profile.model_claim_inventory') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation'])
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.model_claim_inventory', params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
    } }
  }
  if (frame.method === 'profile.extensions') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'command'])
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.extensions', params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation), runtime_generation: generation(params.runtime_generation),
      command: extensionCommand(params.command),
    } }
  }
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
    const legacyKeys = [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_issuer', 'account_subject', 'profile_key_handle',
      'profile_unlock_material',
    ]
    const tokenKeys = [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'account_access_token', 'account_issuer', 'account_subject', 'profile_key_handle',
      'profile_unlock_material',
    ]
    const hasAccountAccessToken = Object.hasOwn(params, 'account_access_token')
    exactKeys(params, hasAccountAccessToken ? tokenKeys : legacyKeys)
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.ensure',
      params: {
        ...authorized(params),
        authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
        account_binding_handle: opaqueHandle(params.account_binding_handle),
        authority_binding_version: generation(params.authority_binding_version),
        ...(hasAccountAccessToken ? { account_access_token: boundedText(params.account_access_token, 8_192) } : {}),
        account_issuer: accountIssuer(params.account_issuer), account_subject: boundedText(params.account_subject, 512),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.restore') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'authority_environment_id', 'account_binding_handle',
      'authority_binding_version', 'profile_selector', 'profile_key_handle', 'profile_unlock_material',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.restore',
      params: {
        ...authorized(params),
        authority_environment_id: uuid(params.authority_environment_id) as HostAuthorityEnvironmentId,
        account_binding_handle: opaqueHandle(params.account_binding_handle),
        authority_binding_version: generation(params.authority_binding_version),
        profile_selector: profileSelector(params.profile_selector),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.bootstrap_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_key_handle', 'profile_unlock_material'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.bootstrap_local',
      params: {
        ...authorized(params), profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.restore_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector', 'profile_key_handle', 'profile_unlock_material'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.restore_local',
      params: {
        ...authorized(params), profile_selector: profileSelector(params.profile_selector),
        profile_key_handle: boundedText(params.profile_key_handle, 512),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
      },
    }
  }
  if (frame.method === 'profile.open_local') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.open_local',
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector) },
    }
  }
  if (frame.method === 'profile.recovery_inspect') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_key_handles', 'expected_runtime_generation', 'expected_schema_generation',
    ])
    if (!Array.isArray(params.profile_key_handles) || params.profile_key_handles.length < 1
      || params.profile_key_handles.length > 128) reject()
    const profile_key_handles = params.profile_key_handles.map(unlockMaterial)
    if (new Set(profile_key_handles).size !== profile_key_handles.length) reject()
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recovery_inspect',
      params: {
        ...authorized(params), profile_key_handles,
        expected_runtime_generation: generation(params.expected_runtime_generation),
        expected_schema_generation: generation(params.expected_schema_generation),
      },
    }
  }
  if (frame.method === 'profile.recover_offline_account') {
    exactKeys(params, [
      ...AUTHORIZED_KEYS, 'profile_key_handle', 'profile_unlock_material', 'recovery_operation_id',
      'candidate_id', 'preflight_digest',
    ])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recover_offline_account',
      params: {
        ...authorized(params), profile_key_handle: unlockMaterial(params.profile_key_handle),
        profile_unlock_material: unlockMaterial(params.profile_unlock_material),
        recovery_operation_id: uuid(params.recovery_operation_id) as HostRecoveryOperationId,
        candidate_id: uuid(params.candidate_id) as HostRecoveryCandidateId,
        preflight_digest: digest(params.preflight_digest),
      },
    }
  }
  if (frame.method === 'profile.open_offline_account') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'profile_selector'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.open_offline_account',
      params: { ...authorized(params), profile_selector: profileSelector(params.profile_selector) },
    }
  }
  if (frame.method === 'profile.recovery_status') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'recovery_operation_id'])
    return {
      version: 1, type: 'request', request_id: requestId, method: 'profile.recovery_status',
      params: {
        ...authorized(params), recovery_operation_id: uuid(params.recovery_operation_id) as HostRecoveryOperationId,
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
  if (frame.method === 'profile.model_text') {
    exactKeys(params, [...AUTHORIZED_KEYS, 'view_lease_id', 'lease_generation', 'runtime_generation', 'text'])
    if (typeof params.text !== 'string' || !params.text.trim()
      || Buffer.byteLength(params.text, 'utf8') > 8192) reject()
    return { version: 1, type: 'request', request_id: requestId, method: 'profile.model_text', params: {
      ...authorized(params), view_lease_id: uuid(params.view_lease_id) as HostViewLeaseId,
      lease_generation: generation(params.lease_generation),
      runtime_generation: generation(params.runtime_generation), text: params.text,
    } }
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
  | ProfileBootstrapLocalResult | ProfileRestoreLocalResult | ProfileOpenResult | ProfileOpenLocalResult
  | ProfileRecoveryInspectResult | ProfileRecoverOfflineAccountResult
  | ProfileOpenOfflineAccountResult | ProfileRecoveryStatusResult
  | ProfileViewActivateResult | ProfileModelTextResult | ProfileLeaseCloseResult | ProfileExtensionsResult
  | ProfileModelClaimInventoryResult | ProfileModelClaimConfirmResult | ProfileModelClaimApplyResult
  | ProfileModelClaimRecoveryInventoryResult
  | ProfileModelClaimRecoveryStatusResult | ProfileModelClaimRestoreResult | ProfileModelClaimRetryResult {
  exactKeys(frame, ['version', 'type', 'request_id', 'method', 'result'])
  const result = record(frame.result)
  const request_id = uuid(frame.request_id) as HostControlRequestId
  if (frame.method === 'profile.model_claim_confirm') {
    exactKeys(result, ['confirmation', 'operation_id', 'expires_at'])
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      confirmation: sourceAuthority(result.confirmation), operation_id: uuid(result.operation_id),
      expires_at: timestamp(result.expires_at),
    } }
  }
  if (frame.method === 'profile.model_claim_apply') {
    exactKeys(result, ['state', 'cleanup_pending'])
    if (result.state !== 'committed' || typeof result.cleanup_pending !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { state: 'committed', cleanup_pending: result.cleanup_pending } }
  }
  if (frame.method === 'profile.model_claim_recovery_inventory') {
    exactKeys(result, ['receipts'])
    if (!Array.isArray(result.receipts) || result.receipts.length > 128) reject()
    const ids = new Set<string>()
    const receipts = result.receipts.map((value) => {
      const receipt = record(value)
      exactKeys(receipt, ['candidate_id', 'operation_id', 'source_digest', 'state'])
      const candidate_id = modelClaimCandidate(receipt.candidate_id)
      if (ids.has(candidate_id) || !['pending', 'committed', 'restored'].includes(receipt.state as string)) reject()
      ids.add(candidate_id)
      return { candidate_id, operation_id: uuid(receipt.operation_id),
        source_digest: digest(receipt.source_digest),
        state: receipt.state as 'pending' | 'committed' | 'restored' }
    })
    return { version: 1, type: 'result', request_id, method: frame.method, result: { receipts } }
  }
  if (frame.method === 'profile.model_claim_recovery_status') {
    if (result.state === 'unclaimed') {
      exactKeys(result, ['state'])
      return { version: 1, type: 'result', request_id, method: frame.method, result: { state: 'unclaimed' } }
    }
    exactKeys(result, ['state', 'candidate_id', 'operation_id', 'source_digest'])
    if (result.state !== 'pending' && result.state !== 'committed' && result.state !== 'restored') reject()
    return { version: 1, type: 'result', request_id, method: frame.method, result: {
      state: result.state, candidate_id: modelClaimCandidate(result.candidate_id),
      operation_id: uuid(result.operation_id), source_digest: digest(result.source_digest),
    } }
  }
  if (frame.method === 'profile.model_claim_restore') {
    exactKeys(result, ['state', 'cleanup_pending'])
    if (result.state !== 'restored' || typeof result.cleanup_pending !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { state: 'restored', cleanup_pending: result.cleanup_pending } }
  }
  if (frame.method === 'profile.model_claim_retry') {
    exactKeys(result, ['state', 'cleanup_pending'])
    if (result.state !== 'committed' || typeof result.cleanup_pending !== 'boolean') reject()
    return { version: 1, type: 'result', request_id, method: frame.method,
      result: { state: 'committed', cleanup_pending: result.cleanup_pending } }
  }
  if (frame.method === 'profile.model_claim_inventory') {
    exactKeys(result, ['source_digest', 'candidates',
      'unsupported_settings', 'unassigned_credential_references', 'unassigned_credential_records'])
    if (!Array.isArray(result.candidates) || result.candidates.length > 128) reject()
    const ids = new Set<string>()
    const candidates = result.candidates.map((value) => {
      const candidate = record(value)
      exactKeys(candidate, ['id', 'provider', 'kind', 'credential', 'shared_credential'])
      if (typeof candidate.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(candidate.provider)
        || (candidate.kind !== 'llm' && candidate.kind !== 'web-search')
        || candidate.kind === 'web-search' && candidate.provider !== 'deepseek'
        || !['present', 'missing', 'none'].includes(candidate.credential as string)
        || typeof candidate.shared_credential !== 'boolean'
        || candidate.id !== (candidate.kind === 'web-search'
          ? 'web-search-deepseek:deepseek'
          : candidate.provider === 'deepseek' && candidate.id === 'llm-deepseek:deepseek'
            ? 'llm-deepseek:deepseek' : `llm-pi-ai:${candidate.provider}`)
        || ids.has(candidate.id)) reject()
      ids.add(candidate.id)
      return {
        id: candidate.id, provider: candidate.provider, kind: candidate.kind,
        credential: candidate.credential, shared_credential: candidate.shared_credential,
      } as ProfileModelClaimInventoryResult['result']['candidates'][number]
    })
    return { version: 1, type: 'result', request_id, method: 'profile.model_claim_inventory', result: {
      source_digest: digest(result.source_digest), candidates,
      unsupported_settings: nonnegative(result.unsupported_settings),
      unassigned_credential_references: nonnegative(result.unassigned_credential_references),
      unassigned_credential_records: nonnegative(result.unassigned_credential_records),
    } }
  }
  if (frame.method === 'profile.extensions') {
    return { version: 1, type: 'result', request_id, method: 'profile.extensions', result: extensionResponse(result) }
  }
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
  if (frame.method === 'profile.ensure' || frame.method === 'profile.restore'
    || frame.method === 'profile.bootstrap_local' || frame.method === 'profile.restore_local') {
    return profileReadyResult(request_id, frame.method, result)
  }
  if (frame.method === 'profile.recovery_inspect') {
    exactKeys(result, ['candidates'])
    if (!Array.isArray(result.candidates) || result.candidates.length < 1 || result.candidates.length > 128) reject()
    const candidates = result.candidates.map((value) => {
      const candidate = record(value)
      const withReason = Object.hasOwn(candidate, 'reason_code')
      exactKeys(candidate, [
        'state', 'candidate_id', 'profile_kind', 'binding_count', 'persistence_generation',
        'session_count', 'plugin_count', 'compatibility', 'preflight_digest',
        ...(withReason ? ['reason_code'] : []),
      ])
      if ((candidate.state !== 'recoverable' && candidate.state !== 'compatibility_blocked')
        || candidate.profile_kind !== 'account'
        || typeof candidate.compatibility !== 'string'
        || !['current', 'legacy_runtime_required', 'read_only_export_only'].includes(candidate.compatibility)) reject()
      const state: 'recoverable' | 'compatibility_blocked' = candidate.state === 'recoverable'
        ? 'recoverable'
        : 'compatibility_blocked'
      return {
        state,
        candidate_id: uuid(candidate.candidate_id) as HostRecoveryCandidateId,
        profile_kind: 'account' as const,
        binding_count: nonnegative(candidate.binding_count),
        persistence_generation: nonnegative(candidate.persistence_generation),
        session_count: nonnegative(candidate.session_count),
        plugin_count: nonnegative(candidate.plugin_count),
        compatibility: candidate.compatibility as 'current' | 'legacy_runtime_required' | 'read_only_export_only',
        preflight_digest: digest(candidate.preflight_digest),
        ...(withReason ? { reason_code: boundedText(candidate.reason_code, 128) } : {}),
      }
    })
    return { version: 1, type: 'result', request_id, method: 'profile.recovery_inspect', result: { candidates } }
  }
  if (frame.method === 'profile.recover_offline_account') {
    exactKeys(result, [
      'state', 'profile_selector', 'access_scope', 'persistence_generation', 'runtime_generation',
    ])
    if (result.state !== 'offline_ready' || result.access_scope !== 'offline_local') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.recover_offline_account',
      result: {
        state: 'offline_ready', profile_selector: profileSelector(result.profile_selector),
        access_scope: 'offline_local', persistence_generation: nonnegative(result.persistence_generation),
        runtime_generation: generation(result.runtime_generation),
      },
    }
  }
  if (frame.method === 'profile.open_offline_account') {
    exactKeys(result, [
      'profile_id', 'view_lease_id', 'view_activation_handle', 'lease_generation', 'expires_at',
      'runtime_generation', 'access_scope',
    ])
    if (result.access_scope !== 'offline_local') reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.open_offline_account',
      result: {
        ...profileLeaseFields(result), access_scope: 'offline_local',
      },
    }
  }
  if (frame.method === 'profile.recovery_status') {
    if (result.state === 'failed') {
      exactKeys(result, ['state', 'reason_code'])
      if (result.reason_code !== 'recovery_worker_failed') reject()
      return {
        version: 1, type: 'result', request_id, method: 'profile.recovery_status',
        result: { state: 'failed', reason_code: 'recovery_worker_failed' },
      }
    }
    exactKeys(result, ['state'])
    if (typeof result.state !== 'string'
      || !['recovering', 'offline_ready', 'unknown'].includes(result.state)) reject()
    return {
      version: 1, type: 'result', request_id, method: 'profile.recovery_status',
      result: { state: result.state as 'recovering' | 'offline_ready' | 'unknown' },
    }
  }
  if (frame.method === 'profile.open' || frame.method === 'profile.open_local') {
    exactKeys(result, ['profile_id', 'view_lease_id', 'view_activation_handle', 'lease_generation', 'expires_at', 'runtime_generation'])
    return {
      version: 1,
      type: 'result',
      request_id,
      method: frame.method,
      result: profileLeaseFields(result),
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
  if (frame.method === 'profile.model_text') {
    if (result.state === 'rejected') {
      exactKeys(result, ['state', 'code'])
      if (result.code !== 'invalid_input' && result.code !== 'no_default_model'
        && result.code !== 'missing_credential' && result.code !== 'provider_failed'
        && result.code !== 'cancelled' && result.code !== 'response_too_large') reject()
      return { version: 1, type: 'result', request_id, method: 'profile.model_text', result: {
        state: 'rejected', code: result.code,
      } }
    }
    exactKeys(result, ['state', 'provider', 'model', 'text'])
    if (result.state !== 'complete' || typeof result.provider !== 'string' || !result.provider
      || result.provider.length > 256 || typeof result.model !== 'string' || !result.model
      || result.model.length > 256 || typeof result.text !== 'string' || !result.text.trim()
      || Buffer.byteLength(result.text, 'utf8') > 16384) reject()
    return { version: 1, type: 'result', request_id, method: 'profile.model_text', result: {
      state: 'complete', provider: result.provider, model: result.model, text: result.text,
    } }
  }
  return reject('unknown_method')
}

function profileReadyResult(
  request_id: HostControlRequestId,
  method: 'profile.ensure' | 'profile.restore' | 'profile.bootstrap_local' | 'profile.restore_local',
  result: Record<string, unknown>,
): ProfileEnsureResult | ProfileRestoreResult | ProfileBootstrapLocalResult | ProfileRestoreLocalResult {
  const local = method === 'profile.bootstrap_local' || method === 'profile.restore_local'
  exactKeys(result, ['state', 'profile_id', 'profile_selector', ...(local ? ['persistence_generation'] : [])])
  if (result.state !== 'ready') reject()
  const common = {
    state: 'ready' as const,
    profile_id: uuid(result.profile_id) as HostProfileId,
    profile_selector: profileSelector(result.profile_selector),
  }
  if (method === 'profile.ensure') return { version: 1, type: 'result', request_id, method, result: common }
  if (method === 'profile.restore') return { version: 1, type: 'result', request_id, method, result: common }
  const localResult = { ...common, persistence_generation: generation(result.persistence_generation) }
  if (method === 'profile.bootstrap_local') {
    return { version: 1, type: 'result', request_id, method, result: localResult }
  }
  return { version: 1, type: 'result', request_id, method, result: localResult }
}

function profileLeaseFields(result: Record<string, unknown>): ProfileOpenResult['result'] {
  return {
    profile_id: uuid(result.profile_id) as HostProfileId,
    view_lease_id: uuid(result.view_lease_id) as HostViewLeaseId,
    view_activation_handle: activationHandle(result.view_activation_handle),
    lease_generation: generation(result.lease_generation),
    expires_at: timestamp(result.expires_at),
    runtime_generation: generation(result.runtime_generation),
  }
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
  else if (typeof row.collection === 'string'
    && ['owner_settings', 'owner_credentials', 'owner_workspace', 'owner_profile'].includes(row.collection)) {
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
