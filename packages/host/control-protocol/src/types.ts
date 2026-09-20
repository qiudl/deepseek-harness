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
/** Short-lived Host candidate id for one offline Account Profile preflight. */
export type HostRecoveryCandidateId = Branded<'HostRecoveryCandidateId'>
/** Desktop idempotency key for one confirmed offline recovery operation. */
export type HostRecoveryOperationId = Branded<'HostRecoveryOperationId'>

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
  | 'profile_not_found'
  | 'profile_ambiguous'
  | 'profile_integrity_failed'
  | 'runtime_incompatible'
  | 'recovery_proof_mismatch'
  | 'recovery_preflight_stale'
  | 'recovery_in_progress'
  | 'recovery_worker_failed'
  | 'recovery_timeout_unknown'
  | 'scope_mismatch'
  | 'selector_stale'
  | 'lease_conflict'

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
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly authority_binding_version: number
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

/** Bootstrap one device-local Profile without any account identity or cloud authority. */
export interface ProfileBootstrapLocalRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.bootstrap_local'
  readonly params: HostAuthorizedParams & {
    readonly profile_key_handle: string
    readonly profile_unlock_material: string
  }
}

/** Local Profile provisioning result; the selector is Host-signed and identity-free. */
export interface ProfileBootstrapLocalResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.bootstrap_local'
  readonly result: {
    readonly state: 'ready'
    readonly profile_id: HostProfileId
    readonly profile_selector: string
    readonly persistence_generation: number
  }
}

/** Restore one local-only Profile through a Host-signed selector and Main-vault material. */
export interface ProfileRestoreLocalRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.restore_local'
  readonly params: HostAuthorizedParams & {
    readonly profile_selector: string
    readonly profile_key_handle: string
    readonly profile_unlock_material: string
  }
}

/** Refreshed local Profile selector after a successful restore. */
export interface ProfileRestoreLocalResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.restore_local'
  readonly result: {
    readonly state: 'ready'
    readonly profile_id: HostProfileId
    readonly profile_selector: string
    readonly persistence_generation: number
  }
}

/** Open a previously unlocked local-only Profile by Host-signed selector. */
export interface ProfileOpenLocalRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open_local'
  readonly params: HostAuthorizedParams & { readonly profile_selector: string }
}

/** Local Profile lease result has the same non-secret surface as an account lease. */
export interface ProfileOpenLocalResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open_local'
  readonly result: ProfileOpenResult['result']
}

/** Inspect only Account Profiles named by Main-vault key handles. */
export interface ProfileRecoveryInspectRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recovery_inspect'
  readonly params: HostAuthorizedParams & {
    readonly profile_key_handles: readonly string[]
    readonly expected_runtime_generation: number
    readonly expected_schema_generation: number
  }
}

/** Anonymous recovery candidates; Profile ids, key handles, and paths are excluded. */
export interface ProfileRecoveryInspectResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recovery_inspect'
  readonly result: {
    readonly candidates: readonly {
      readonly state: 'recoverable' | 'compatibility_blocked'
      readonly candidate_id: HostRecoveryCandidateId
      readonly profile_kind: 'account'
      readonly binding_count: number
      readonly persistence_generation: number
      readonly session_count: number
      readonly plugin_count: number
      readonly compatibility: 'current' | 'legacy_runtime_required' | 'read_only_export_only'
      readonly preflight_digest: HostControlSha256
      readonly reason_code?: string
    }[]
  }
}

/** Confirm one inspected offline Account Profile with ephemeral Main-vault material. */
export interface ProfileRecoverOfflineAccountRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recover_offline_account'
  readonly params: HostAuthorizedParams & {
    readonly profile_key_handle: string
    readonly profile_unlock_material: string
    readonly recovery_operation_id: HostRecoveryOperationId
    readonly candidate_id: HostRecoveryCandidateId
    readonly preflight_digest: HostControlSha256
  }
}

/** Offline grant plus a selector signed in the offline-only domain. */
export interface ProfileRecoverOfflineAccountResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recover_offline_account'
  readonly result: {
    readonly state: 'offline_ready'
    readonly profile_selector: string
    readonly access_scope: 'offline_local'
    readonly persistence_generation: number
    readonly runtime_generation: number
  }
}

/** Open an Account Profile through an offline-domain selector. */
export interface ProfileOpenOfflineAccountRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open_offline_account'
  readonly params: HostAuthorizedParams & { readonly profile_selector: string }
}

/** Offline-only view lease; access scope is explicit on the wire. */
export interface ProfileOpenOfflineAccountResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.open_offline_account'
  readonly result: ProfileOpenResult['result'] & { readonly access_scope: 'offline_local' }
}

/** Query one process-local recovery operation without restarting it. */
export interface ProfileRecoveryStatusRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recovery_status'
  readonly params: HostAuthorizedParams & { readonly recovery_operation_id: HostRecoveryOperationId }
}

/** Stable recovery operation state without secrets or Profile identifiers. */
export interface ProfileRecoveryStatusResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.recovery_status'
  readonly result:
    | { readonly state: 'recovering' | 'offline_ready' | 'unknown' }
    | { readonly state: 'failed'; readonly reason_code: 'recovery_worker_failed' }
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

/** One bounded text request authorized by this connection's verified Account grant. */
export interface ProfileModelTextRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_text'
  readonly params: HostAuthorizedParams & {
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
    readonly text: string
  }
}

/** Text and model identity, or a classified failure without provider details. */
export interface ProfileModelTextResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_text'
  readonly result:
    | {
      readonly state: 'complete'
      readonly provider: string
      readonly model: string
      readonly text: string
    }
    | {
      readonly state: 'rejected'
      readonly code: 'invalid_input' | 'no_default_model' | 'missing_credential'
        | 'provider_failed' | 'cancelled' | 'timeout' | 'response_too_large'
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

/** Opaque confirmation plan identifier. */
export type HostExtensionPlanId = Branded<'HostExtensionPlanId'>
/** Durable extension operation identifier used for retry and recovery. */
export type HostExtensionOperationId = Branded<'HostExtensionOperationId'>
/** Wire market kinds; installation availability is determined by the negotiated Host provider. */
export type HostExtensionKind = 'plugin' | 'mcp' | 'skill'
/** Paths and executable arguments are never accepted as operation selectors. */
export type HostExtensionCommand =
  | { readonly action: 'inventory'; readonly kind: HostExtensionKind }
  | { readonly action: 'prepare'; readonly kind: HostExtensionKind; readonly payload: string }
  | {
    readonly action: 'commit'
    readonly plan_id: HostExtensionPlanId
    readonly operation_id: HostExtensionOperationId
    readonly script_digest?: HostControlSha256
  }
  | { readonly action: 'status' | 'cancel'; readonly operation_id: HostExtensionOperationId }
/** Secret-free extension metadata returned to the trusted broker. */
export type HostExtensionResponse =
  | {
    readonly state: 'prepared'
    readonly plan_id: HostExtensionPlanId
    readonly kind: HostExtensionKind
    readonly digest: HostControlSha256
    readonly expires_at: number
    readonly scripts?: readonly { readonly name: string; readonly command: string }[]
    readonly script_digest?: HostControlSha256
  }
  | {
    readonly state: 'inventory'
    /** Explicit support for confirmed GitHub directory archives; absent means unsupported. */
    readonly plugin_remove?: boolean
    readonly plugin_update?: boolean
    readonly plugin_toggle?: boolean
    readonly skill_archives?: boolean
    readonly skill_remove?: boolean
    readonly skill_replace?: boolean
    readonly skill_files?: boolean
    readonly skill_invocation?: boolean
    readonly mcp_remove?: boolean
    readonly mcp_update?: boolean
    readonly kind: HostExtensionKind
    readonly entries: readonly {
      readonly id: string
      readonly name: string
      readonly transport: string
      readonly model_invocable?: boolean
      readonly user_invocable?: boolean
      readonly skill_source?: 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other'
      readonly skill_status?: 'effective' | 'shadowed' | 'not_visible'
      readonly effective_source?: 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other'
      readonly plugin_state?: 'enabled' | 'disabled' | 'mixed' | 'unsupported'
    }[]
  }
  | {
    readonly state: 'receipt'
    readonly skill_restore?: string
    readonly mcp_restore?: true
    readonly plugin_restore?: string
    readonly plugin_complete?: { readonly action: 'install' | 'update' | 'remove'; readonly package_name: string; readonly spec?: string }
    readonly completed_by?: HostExtensionOperationId
    readonly completes_operation?: HostExtensionOperationId
    readonly restored_by?: HostExtensionOperationId
    readonly restores_operation?: HostExtensionOperationId
    readonly operation_id: HostExtensionOperationId
    readonly outcome: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
    readonly cancellation_requested: boolean
    readonly created_at: number
    readonly updated_at: number
    readonly skill_source?: 'absent' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other'
    readonly reason?: 'revision_conflict' | 'authority_revoked' | 'expired' | 'interrupted' | 'executor_failed'
  }
/** Extension commands bind only to a Main-held view lease. */
export interface ProfileExtensionsRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.extensions'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
    readonly command: HostExtensionCommand
  }
}
/** Bounded metadata; payloads, credentials and filesystem paths are excluded. */
export interface ProfileExtensionsResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.extensions'
  readonly result: HostExtensionResponse
}

/** Inspect legacy model candidates through a token-verified Account view. */
export interface ProfileModelClaimInventoryRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_inventory'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
  }
}

/** Redacted source candidates; credentials, references and paths are excluded. */
export interface ProfileModelClaimInventoryResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_inventory'
  readonly result: {
    readonly source_digest: HostControlSha256
    readonly candidates: readonly {
      readonly id: string
      readonly provider: string
      readonly kind: 'llm' | 'web-search'
      readonly credential: 'present' | 'missing' | 'none'
      readonly shared_credential: boolean
    }[]
    readonly unsupported_settings: number
    readonly unassigned_credential_references: number
    readonly unassigned_credential_records: number
  }
}

/** Confirm one displayed candidate against a fresh source digest and Account view. */
export interface ProfileModelClaimConfirmRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_confirm'
  readonly params: ProfileModelClaimInventoryRequest['params'] & {
    readonly candidate_id: string
    readonly source_digest: HostControlSha256
  }
}

/** One-use, connection-owned authority for a single claim transaction. */
export interface ProfileModelClaimConfirmResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_confirm'
  readonly result: {
    readonly confirmation: string
    readonly operation_id: string
    readonly expires_at: number
  }
}

/** Consume a confirmed claim authority on its originating Host connection. */
export interface ProfileModelClaimApplyRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_apply'
  readonly params: HostAuthorizedParams & { readonly confirmation: string }
}

/** Redacted result of the committed provider claim. */
export interface ProfileModelClaimApplyResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_apply'
  readonly result: { readonly state: 'committed'; readonly cleanup_pending: boolean }
}

/** Account proof accepted only for an already recorded legacy model claim. */
export type ProfileModelClaimRecoveryProof = HostAuthorizedParams & {
  readonly account_access_token: string
  readonly account_issuer: string
  readonly account_subject: string
  readonly authority_environment_id: HostAuthorityEnvironmentId
  readonly account_binding_handle: string
  readonly authority_binding_version: number
  readonly profile_key_handle: string
  readonly profile_unlock_material: string
}

/** Find this Account's unfinished claims when Desktop lost the candidate id. */
export interface ProfileModelClaimRecoveryInventoryRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_recovery_inventory'
  readonly params: ProfileModelClaimRecoveryProof
}

/** Bounded, secret-free pending receipts. */
export interface ProfileModelClaimRecoveryInventoryResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_recovery_inventory'
  readonly result: { readonly receipts: readonly {
    readonly candidate_id: string
    readonly operation_id: string
    readonly source_digest: HostControlSha256
    readonly state: 'pending' | 'committed' | 'restored'
  }[] }
}

/** Query a legacy claim receipt using the current Account and vault proof. */
export interface ProfileModelClaimRecoveryStatusRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_recovery_status'
  readonly params: ProfileModelClaimRecoveryProof & { readonly candidate_id: string }
}

/** Redacted receipt or an unclaimed state for the authorized Account. */
export interface ProfileModelClaimRecoveryStatusResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_recovery_status'
  readonly result: { readonly state: 'unclaimed' } | {
    readonly state: 'pending' | 'committed' | 'restored'
    readonly candidate_id: string
    readonly operation_id: string
    readonly source_digest: HostControlSha256
  }
}

/** Restore one interrupted claim from its durable private preimage. */
export interface ProfileModelClaimRestoreRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_restore'
  readonly params: ProfileModelClaimRecoveryProof & {
    readonly candidate_id: string
    readonly operation_id: string
  }
}

/** Restoration outcome without source or target credential data. */
export interface ProfileModelClaimRestoreResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_restore'
  readonly result: { readonly state: 'restored'; readonly cleanup_pending: boolean }
}

/** Retry only a durable claim already reserved for this Account Profile. */
export interface ProfileModelClaimRetryRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_retry'
  readonly params: ProfileModelClaimRecoveryProof & {
    readonly candidate_id: string
    readonly operation_id: string
    readonly source_digest: HostControlSha256
  }
}

/** Redacted outcome of a resumed, verified claim. */
export interface ProfileModelClaimRetryResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.model_claim_retry'
  readonly result: { readonly state: 'committed'; readonly cleanup_pending: boolean }
}

/** Every frame understood before a later protocol task adds negotiated payloads. */
export type HostControlFrame =
  | ProfileExtensionsRequest
  | ProfileExtensionsResult
  | ProfileModelClaimInventoryRequest
  | ProfileModelClaimInventoryResult
  | ProfileModelClaimConfirmRequest
  | ProfileModelClaimConfirmResult
  | ProfileModelClaimApplyRequest
  | ProfileModelClaimApplyResult
  | ProfileModelClaimRecoveryInventoryRequest
  | ProfileModelClaimRecoveryInventoryResult
  | ProfileModelClaimRecoveryStatusRequest
  | ProfileModelClaimRecoveryStatusResult
  | ProfileModelClaimRestoreRequest
  | ProfileModelClaimRestoreResult
  | ProfileModelClaimRetryRequest
  | ProfileModelClaimRetryResult
  | HostInspectRequest
  | HostInspectResult
  | ProfileStatusRequest
  | ProfileStatusResult
  | ProfileEnsureRequest
  | ProfileEnsureResult
  | ProfileRestoreRequest
  | ProfileRestoreResult
  | ProfileBootstrapLocalRequest
  | ProfileBootstrapLocalResult
  | ProfileRestoreLocalRequest
  | ProfileRestoreLocalResult
  | ProfileOpenRequest
  | ProfileOpenResult
  | ProfileOpenLocalRequest
  | ProfileOpenLocalResult
  | ProfileRecoveryInspectRequest
  | ProfileRecoveryInspectResult
  | ProfileRecoverOfflineAccountRequest
  | ProfileRecoverOfflineAccountResult
  | ProfileOpenOfflineAccountRequest
  | ProfileOpenOfflineAccountResult
  | ProfileRecoveryStatusRequest
  | ProfileRecoveryStatusResult
  | ProfileViewActivateRequest
  | ProfileViewActivateResult
  | ProfileModelTextRequest
  | ProfileModelTextResult
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
