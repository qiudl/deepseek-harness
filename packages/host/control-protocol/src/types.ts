import type { Branded } from '@deepseek-ai/dsh-brand'

/** Current on-wire Host control protocol version. */
export type HostControlProtocolVersion = 1

/** Correlates one request with exactly one result or error. */
export type HostControlRequestId = Branded<'HostControlRequestId'>
/** Single-use token id carried by later authenticated, state-changing payloads. */
export type HostControlJti = Branded<'HostControlJti'>
/** Stable identity of one installed Host runtime. */
export type HostInstanceId = Branded<'HostInstanceId'>
/** Ephemeral identity of the local Desktop broker initiating a connection. */
export type HostControlClientInstanceId = Branded<'HostControlClientInstanceId'>
/** Stable identity of one DSH installation, retained across Host upgrades. */
export type InstallationId = Branded<'InstallationId'>
/** Stable, non-secret correlation id suitable for support logs. */
export type HostControlCorrelationId = Branded<'HostControlCorrelationId'>
/** A base64url-encoded 32-byte challenge or nonce. */
export type HostControlNonce = Branded<'HostControlNonce'>
/** A base64url-encoded 32-byte Ed25519 public key. */
export type HostControlPublicKey = Branded<'HostControlPublicKey'>
/** A base64url-encoded Ed25519 signature. */
export type HostControlSignature = Branded<'HostControlSignature'>
/** A lower-case SHA-256 digest in hexadecimal form. */
export type HostControlSha256 = Branded<'HostControlSha256'>
/** Opaque secure-store binding selected by Desktop Main. */
export type HostAccountBindingHandle = Branded<'HostAccountBindingHandle'>
/** Stable authority environment UUID; staging and production remain distinct issuers of bindings. */
export type HostAuthorityEnvironmentId = Branded<'HostAuthorityEnvironmentId'>
/** Opaque Person Profile id; it reveals no account subject. */
export type HostProfileId = Branded<'HostProfileId'>
/** Main-only short-lived local view lease. */
export type HostViewLeaseId = Branded<'HostViewLeaseId'>
/** Single-use Main-only capability that activates one leased Profile view. */
export type HostViewActivationHandle = Branded<'HostViewActivationHandle'>
/** Opaque handle for an owner-only staged migration bundle; it is never a path. */
export type HostMigrationTransferId = Branded<'HostMigrationTransferId'>
/** Opaque identity of one target-generation import transaction. */
export type HostMigrationImportId = Branded<'HostMigrationImportId'>
/** Connection-bound authority for one verified owner-local legacy inventory. */
export type HostMigrationSourceAuthority = Branded<'HostMigrationSourceAuthority'>

/**
 * Negotiated operation token. A capability is syntax-checked, sorted, and
 * deduplicated on the wire; method-specific payloads are versioned separately.
 */
export type HostControlCapability = Branded<'HostControlCapability'>

/** Stable wire error vocabulary. No server exception text crosses this boundary. */
export type HostControlErrorCode =
  | 'invalid_frame'
  | 'unsupported_protocol'
  | 'unknown_method'
  | 'unauthenticated'
  | 'unauthorized'
  | 'profile_locked'
  | 'profile_mismatch'
  | 'replayed'
  | 'stale'
  | 'idempotency_conflict'
  | 'conflict'
  | 'busy'
  | 'upgrade_required'
  | 'migration_required'
  | 'unavailable'
  | 'internal_error'

/** Initial challenge request; it is the only payload decoded before negotiation. */
export interface HostInspectRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'host.inspect'
  readonly params: {
    readonly challenge: HostControlNonce
    readonly client_instance_id: HostControlClientInstanceId
    readonly supported_versions: readonly number[]
  }
}

/** Signed Host identity and negotiated capability response. */
export interface HostInspectResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'host.inspect'
  readonly result: {
    readonly protocol_version: 1
    readonly host_instance_id: HostInstanceId
    readonly installation_id: InstallationId
    readonly installation_public_key: HostControlPublicKey
    readonly runtime_generation: number
    readonly schema_generation: number
    readonly process_nonce: HostControlNonce
    readonly capabilities: readonly HostControlCapability[]
    readonly challenge_signature: HostControlSignature
    readonly executable_signature_digest: HostControlSha256
  }
}

/** Authentication fields repeated on post-inspection requests. */
export interface HostAuthorizedParams {
  readonly client_instance_id: HostControlClientInstanceId
  readonly host_instance_id: HostInstanceId
  readonly process_nonce: HostControlNonce
  readonly jti: HostControlJti
  readonly issued_at: number
  readonly expires_at: number
}

/** Query the Profile selected by a Desktop Main secure-store binding. */
export interface ProfileStatusRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.status'
  readonly params: HostAuthorizedParams & {
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
  }
}

/** Profile status contains no account identity or unlock material. */
export interface ProfileStatusResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.status'
  readonly result:
    | { readonly state: 'ready'; readonly profile_id: HostProfileId; readonly persistence_generation: number }
    | { readonly state: 'unbound' | 'locked' }
}

/** Ensure one account Profile from Main-owned account and secure-store handles. */
export interface ProfileEnsureRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.ensure'
  readonly params: HostAuthorizedParams & {
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly authority_binding_version: number
    readonly account_access_token?: string
    readonly account_issuer: string
    readonly account_subject: string
    readonly profile_key_handle: string
    readonly profile_unlock_material: string
  }
}

/** Idempotent Profile provisioning result; account identity and key handle are excluded. */
export interface ProfileEnsureResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.ensure'
  readonly result: { readonly state: 'ready'; readonly profile_id: HostProfileId; readonly profile_selector: string }
}

/** Restore an offline Profile through a Host-signed selector and Main-vault handle. */
export interface ProfileRestoreRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.restore'
  readonly params: HostAuthorizedParams & {
    readonly profile_selector: string
    readonly profile_key_handle: string
    readonly profile_unlock_material: string
  }
}

/** Restored Profile plus a freshly signed selector for the current generations. */
export interface ProfileRestoreResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.restore'
  readonly result: { readonly state: 'ready'; readonly profile_id: HostProfileId; readonly profile_selector: string }
}

/** Open the same Profile through a Main-only local view lease. */
export interface ProfileOpenRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open'
  readonly params: HostAuthorizedParams & {
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
  }
}

/** Lease result intentionally excludes URL, token, cookie, path, and account subject. */
export interface ProfileOpenResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open'
  readonly result: {
    readonly profile_id: HostProfileId
    readonly view_lease_id: HostViewLeaseId
    readonly view_activation_handle: HostViewActivationHandle
    readonly lease_generation: number
    readonly expires_at: number
    readonly runtime_generation: number
  }
}

/** Consume one Profile view activation on the connection that opened its lease. */
export interface ProfileViewActivateRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.view_activate'
  readonly params: HostAuthorizedParams & {
    readonly profile_id: HostProfileId
    readonly view_lease_id: HostViewLeaseId
    readonly view_activation_handle: HostViewActivationHandle
    readonly lease_generation: number
    readonly runtime_generation: number
  }
}

/** Main-only activation descriptor for one verified loopback worker listener. */
export interface ProfileViewActivateResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.view_activate'
  readonly result: {
    readonly origin: string
    readonly activation_generation: number
    readonly expires_at: number
    readonly bootstrap_cookie: { readonly name: string; readonly value: string }
  }
}

/** Revoke one Main-owned personal view lease. */
export interface ProfileLeaseCloseRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.lease_close'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
  }
}

/** Idempotent lease-revocation acknowledgement. */
export interface ProfileLeaseCloseResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.lease_close'
  readonly result: { readonly closed: true }
}

/** Begin a bounded owner-side schema-aware migration export. */
export interface MigrationExportInventoryRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.inventory'
  readonly params: HostAuthorizedParams & {
    readonly source_profile_selector: string
    readonly source_inventory_authority?: HostMigrationSourceAuthority
  }
}

/** Probe the fixed owner-derived legacy source without returning its path or payload. */
export interface MigrationExistingSourceInventoryRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.existing_source.inventory'
  readonly params: HostAuthorizedParams & { readonly target_profile_selector: string }
}

/** Short-lived authority and stable proof for a zero-write legacy source probe. */
export interface MigrationExistingSourceInventoryResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.existing_source.inventory'
  readonly result: {
    readonly source_inventory_authority: HostMigrationSourceAuthority
    readonly source_installation_id: InstallationId
    readonly expires_at: number
    readonly inventory_digest: HostControlSha256
    readonly source_generation: HostControlSha256
    readonly schema_version: number
    readonly required_max_records: number
    readonly required_max_bytes: number
  }
}

/** Stable logical inventory proof; no content or filesystem path is exposed. */
export interface MigrationExportInventoryResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.inventory'
  readonly result: {
    readonly inventory_digest: HostControlSha256
    readonly source_generation: HostControlSha256
    readonly schema_version: number
    readonly required_max_records: number
    readonly required_max_bytes: number
  }
}

/** Begin a bounded owner-side schema-aware migration export. */
export interface MigrationExportBeginRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.begin'
  readonly params: HostAuthorizedParams & {
    readonly source_profile_selector: string
    readonly source_inventory_authority?: HostMigrationSourceAuthority
    readonly expected_inventory_digest: HostControlSha256
    readonly max_records: number
    readonly max_bytes: number
  }
}

/** Stable receipt for an owner-bound retained semantic export. */
export interface MigrationExportBeginResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.begin'
  readonly result: {
    readonly export_id: string
    readonly transfer_id: HostMigrationTransferId
    readonly transfer_digest: HostControlSha256
    readonly schema_version: number
    readonly source_generation: HostControlSha256
    readonly record_count: number
    readonly first_event_sequence: number
    readonly last_event_sequence: number
    readonly semantic_digest: HostControlSha256
    readonly chunk_count: number
  }
}

/** Stage an owner-only transfer into an inactive target generation. */
export interface MigrationImportStageRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.stage'
  readonly params: HostAuthorizedParams & {
    readonly transfer_id: HostMigrationTransferId
    readonly transfer_digest: HostControlSha256
    readonly source_installation_id: InstallationId
    readonly source_inventory_digest: HostControlSha256
    readonly source_generation: HostControlSha256
    readonly source_schema_version: number
    readonly target_generation: number
    readonly target_profile_selector: string
    readonly record_count: number
    readonly semantic_digest: HostControlSha256
  }
}

/** Target import journal receipt; no payload, token, or filesystem path is returned. */
export interface MigrationImportStageResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.stage'
  readonly result: {
    readonly import_id: HostMigrationImportId
    readonly stage_version: number
    readonly state: 'staged'
    readonly target_generation: number
    readonly record_count: number
    readonly semantic_digest: HostControlSha256
  }
}

/** Recover a durable import receipt after a lost stage/verify/commit response. */
export interface MigrationImportStatusRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.status'
  readonly params: HostAuthorizedParams & {
    readonly transfer_id: HostMigrationTransferId
    readonly target_generation: number
    readonly source_installation_id: InstallationId
    readonly target_profile_selector: string
  }
}

/** Current durable owner-side import state; never includes transferred payload. */
export interface MigrationImportStatusResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.status'
  readonly result: {
    readonly import_id: HostMigrationImportId
    readonly stage_version: number
    readonly state: 'preparing' | 'staged' | 'verified' | 'committed' | 'aborted'
    readonly target_generation: number
    readonly record_count: number
    readonly semantic_digest: HostControlSha256
  }
}

/** Re-read the inactive target and compare its semantic digest through CAS. */
export interface MigrationImportVerifyRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.verify'
  readonly params: HostAuthorizedParams & {
    readonly import_id: HostMigrationImportId
    readonly expected_stage_version: number
    readonly target_profile_selector: string
  }
}

/** Verified target receipt. */
export interface MigrationImportVerifyResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.verify'
  readonly result: {
    readonly import_id: HostMigrationImportId
    readonly stage_version: number
    readonly verified: true
    readonly semantic_digest: HostControlSha256
  }
}

/** Atomically publish a verified target when the active generation still matches. */
export interface MigrationImportCommitRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.commit'
  readonly params: HostAuthorizedParams & {
    readonly import_id: HostMigrationImportId
    readonly expected_stage_version: number
    readonly expected_current_generation: number
    readonly target_profile_selector: string
  }
}

/** Committed generation receipt. */
export interface MigrationImportCommitResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.commit'
  readonly result: {
    readonly import_id: HostMigrationImportId
    readonly stage_version: number
    readonly committed: true
    readonly active_generation: number
  }
}

/** Discard an uncommitted target generation through CAS. */
export interface MigrationImportAbortRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.abort'
  readonly params: HostAuthorizedParams & {
    readonly import_id: HostMigrationImportId
    readonly expected_stage_version: number
    readonly target_profile_selector: string
  }
}

/** Aborted target receipt. */
export interface MigrationImportAbortResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.import_snapshot.abort'
  readonly result: {
    readonly import_id: HostMigrationImportId
    readonly stage_version: number
    readonly aborted: true
  }
}

/** Read one idempotent bounded chunk from an owner-bound export. */
export interface MigrationExportReadRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.read'
  readonly params: HostAuthorizedParams & {
    readonly source_profile_selector: string
    readonly source_inventory_authority?: HostMigrationSourceAuthority
    readonly export_id: string
    readonly chunk_index: number
  }
}

/** Digest-only semantic record; content, credentials, and paths never cross this wire. */
export interface MigrationExportRecord {
  readonly collection: 'sessions' | 'session_events'
    | 'owner_settings' | 'owner_credentials' | 'owner_workspace' | 'owner_profile'
  readonly id: string
  readonly session_id?: string
  readonly sequence: number
  readonly payload_digest: HostControlSha256
}

/** One retained semantic export chunk. */
export interface MigrationExportReadResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'migration.export_snapshot.read'
  readonly result: {
    readonly export_id: string
    readonly chunk_index: number
    readonly records: readonly MigrationExportRecord[]
    readonly chunk_digest: HostControlSha256
    readonly final: boolean
  }
}

/** Sanitized failure response. */
export interface HostControlErrorFrame {
  readonly version: 1
  readonly type: 'error'
  readonly request_id: HostControlRequestId
  readonly method: HostControlCapability
  readonly error: {
    readonly code: HostControlErrorCode
    readonly retryable: boolean
    readonly correlation_id: HostControlCorrelationId
  }
}

/** Every frame understood before a later protocol task adds negotiated payloads. */
export type HostControlFrame =
  | HostInspectRequest
  | HostInspectResult
  | ProfileStatusRequest
  | ProfileStatusResult
  | ProfileEnsureRequest
  | ProfileEnsureResult
  | ProfileRestoreRequest
  | ProfileRestoreResult
  | ProfileOpenRequest
  | ProfileOpenResult
  | ProfileViewActivateRequest
  | ProfileViewActivateResult
  | ProfileLeaseCloseRequest
  | ProfileLeaseCloseResult
  | MigrationExportBeginRequest
  | MigrationExportBeginResult
  | MigrationExportReadRequest
  | MigrationExportReadResult
  | MigrationImportStageRequest
  | MigrationImportStageResult
  | MigrationImportStatusRequest
  | MigrationImportStatusResult
  | MigrationImportVerifyRequest
  | MigrationImportVerifyResult
  | MigrationImportCommitRequest
  | MigrationImportCommitResult
  | MigrationImportAbortRequest
  | MigrationImportAbortResult
  | HostControlErrorFrame
  | MigrationExportInventoryRequest
  | MigrationExportInventoryResult
  | MigrationExistingSourceInventoryRequest
  | MigrationExistingSourceInventoryResult
