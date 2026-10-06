import type { HostRootPlanningEvidence } from './root-planning-evidence.ts'
import type { HostRootPlanningAttemptDescriptor, HostRootPlanningAttemptAuthorityChallenge, HostRootPlanningAttemptAuthorityAssertion } from './root-planning-attempt-authority.ts'
import type { HostSavedAnalysisFields, HostRootAnalysisOutput } from './root-analysis-output.ts'
import type { HostRootAuthorityChallenge, HostRootAuthorityAssertion, HostRootJournalCommand, HostRootJournalMetadata, HostRootAnalysisInput, HostRootSubmissionTarget } from './root-authority.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostCollaborationDeliveryChunk, HostCollaborationDeliveryResult } from './collaboration-delivery.ts'

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
  | 'script_approval_required'
  /** A definite extension validation refusal (already installed, entry conflict, unknown bundled version); never transient. */
  | 'extension_refused'
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

/** Registry identities requested through the authenticated Host connection. */
export interface HostWorkspaceModelSelectionTarget {
  readonly workspace_id: Branded<'WorkspaceId'>
  readonly session_id: Branded<'SessionId'>
}

/** Read-only effective choice; it is not an executable configuration snapshot or Source proof. */
export interface HostWorkspaceModelSelection extends HostWorkspaceModelSelectionTarget {
  readonly provider: string
  readonly model: string
  readonly reasoning_effort?: string
}

/** Inspect a Session only in the Profile selected by a verified Account binding. */
export interface ProfileWorkspaceModelSelectionRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.workspace_model_selection'
  readonly params: HostAuthorizedParams & HostWorkspaceModelSelectionTarget & {
    readonly authority_environment_id: HostAuthorityEnvironmentId
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
  }
}

/** Minimal selection fields; no message, path, provider configuration, or worker token. */
export interface ProfileWorkspaceModelSelectionResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.workspace_model_selection'
  readonly result: HostWorkspaceModelSelection
}

/** Server challenge bound to one collaboration registration operation and Account. */
export interface HostCollaborationRegistrationChallenge {
  readonly registration_request_id: Branded<'CollaborationRegistrationRequestId'>
  readonly challenge_id: Branded<'CollaborationRegistrationChallengeId'>
  readonly challenge_nonce: HostControlNonce
  readonly expires_at: number
  readonly audience: string
  readonly environment_id: HostAuthorityEnvironmentId
  readonly account_issuer: string
  readonly account_subject: Branded<'AccountSubject'>
}

/** Installation signature over the challenge and current Host process; grants no Source authority. */
export interface HostCollaborationRegistrationAssertion {
  readonly schema_version: 2
  readonly challenge: HostCollaborationRegistrationChallenge
  readonly installation_id: InstallationId
  readonly installation_public_key: HostControlPublicKey
  readonly host_instance_id: HostInstanceId
  readonly process_nonce: HostControlNonce
  readonly signature: HostControlSignature
}

/** Sign only after this connection has verified the challenged Account and binding. */
export interface ProfileCollaborationRegistrationRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.collaboration_registration'
  readonly params: HostAuthorizedParams & {
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
    readonly challenge: HostCollaborationRegistrationChallenge
  }
}

/** Exact signed registration assertion without paths, vault handles or credentials. */
export interface ProfileCollaborationRegistrationResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.collaboration_registration'
  readonly result: HostCollaborationRegistrationAssertion
}

/** Server nonce bound to Account and one registry workspace/ordinary Session. */
export interface HostWorkspaceAuthorityChallenge extends HostWorkspaceModelSelectionTarget {
  readonly request_id: HostControlRequestId
  readonly challenge_nonce: HostControlNonce
  readonly expires_at: number
  readonly audience: string
  readonly environment_id: HostAuthorityEnvironmentId
  readonly account_issuer: string
  readonly account_subject: Branded<'AccountSubject'>
}
/** Installation signature for registry ownership only; no Source/journal/model dispatch grant. */
export interface HostWorkspaceAuthorityAssertion {
  readonly schema_version: 1
  readonly challenge: HostWorkspaceAuthorityChallenge
  readonly installation_id: InstallationId
  readonly installation_public_key: HostControlPublicKey
  readonly host_instance_id: HostInstanceId
  readonly process_nonce: HostControlNonce
  readonly signature: HostControlSignature
}
/** Account-verified, Main-only workspace ownership read and signature. */
export interface ProfileWorkspaceAuthorityRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.workspace_authority'
  readonly params: HostAuthorizedParams & {
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
    readonly challenge: HostWorkspaceAuthorityChallenge
  }
}
/** Signed workspace/Session ownership without model choice or message content. */
export interface ProfileWorkspaceAuthorityResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.workspace_authority'
  readonly result: HostWorkspaceAuthorityAssertion
}

/** Persistent Source identity within one Profile; no caller model or journal metadata. */
export interface HostCollaborationSourceTarget extends HostWorkspaceModelSelectionTarget {
  readonly source_message_id: string
  readonly source_revision: string
}
/** Profile journal observation; the digest covers the complete committed Source snapshot. */
export interface HostCollaborationSourceDescriptor extends HostCollaborationSourceTarget {
  readonly snapshot_digest: string
}
/** Main-only bounded journal JSON. Consumers must validate the complete Source schema and digest before admission. */
export interface HostCollaborationSourceSnapshot {
  readonly descriptor: HostCollaborationSourceDescriptor
  readonly snapshot_json: string
}
/** Read original Source content through this connection's verified Account; never accepts content overrides. */
export interface ProfileSourceSnapshotRequest extends Omit<ProfileWorkspaceModelSelectionRequest, 'method' | 'params'> {
  readonly method: 'profile.source_snapshot'
  readonly params: ProfileWorkspaceModelSelectionRequest['params'] & HostCollaborationSourceTarget & {
    readonly account_issuer: string
    readonly account_subject: string
    readonly offset: number
  }
}
/** Original Source payload without prepared calls, provider configuration, or unlock material. */
export interface ProfileSourceSnapshotResult extends Omit<ProfileWorkspaceModelSelectionResult, 'method' | 'result'> {
  readonly method: 'profile.source_snapshot'
  readonly result: Readonly<{ descriptor:HostCollaborationSourceDescriptor;offset:number;total_bytes:number;chunk_base64url:string }>
}
/** Original Source output evidence; syntax does not grant dispatch or task admission. */
export type HostSourceAnalysisOutput = Readonly<{ state: 'missing'; descriptor: Readonly<HostCollaborationSourceDescriptor> }>
  | Readonly<{ state: 'saved'; descriptor: Readonly<HostCollaborationSourceDescriptor> } & HostSavedAnalysisFields>
/** Parent commands retain no caller-selected model or Account binding digest. */
export type HostCollaborationAnalysisCommand =
  | Readonly<{ action: 'root_execution_journal'; operation: HostRemoteSessionJson }>
  | Readonly<{ action: 'root_feedback'; operation: HostRemoteSessionJson }>
  | Readonly<{ action: 'read_root_attempt'; target: HostRootSubmissionTarget }>
  | Readonly<{ action: 'prepare_root_attempt'; target: HostRootSubmissionTarget }>
  | Readonly<{ action: 'dispatch_root_attempt'; attempt_request_id: HostControlRequestId; grant: HostRemoteSessionJson }>
  | Readonly<{ action: 'read_source_output'; target: HostCollaborationSourceTarget }>
  | Readonly<{ action: 'read_root_output'; target: HostRootSubmissionTarget }>
  | Readonly<{ action: 'prepare_root'; input: HostRootAnalysisInput }>
  | Readonly<{ action: 'recover_root'; input: HostRootAnalysisInput }>
  | Readonly<{ action: 'reconcile_root'; input: HostRootAnalysisInput }>
  | Readonly<{ action: 'resume_root'; input: HostRootAnalysisInput }>
  | Readonly<{ action: 'prepare'; input: HostRemoteSessionJson }>
  | Readonly<{ action: 'capture_reply'; input: HostRemoteSessionJson }>
  | Readonly<{ action: 'prepare_clarification'; input: HostRemoteSessionJson }>
  | Readonly<{ action: 'dispatch'; attempt_request_id: HostControlRequestId; grant: HostRemoteSessionJson }>
/** Original analysis JSON uses base64url to stay within the existing frame limit after escaping. */
export type HostCollaborationAnalysisResult =
  | Readonly<{ kind: 'root_execution_journal' | 'root_feedback'; record: HostRemoteSessionJson }>
  | Readonly<{ kind: 'root_attempt_evidence'; evidence: HostRootPlanningEvidence }>
  | Readonly<{ kind: 'root_attempt_prepared'; preparation: HostRootPlanningAttemptDescriptor }>
  | Readonly<{ kind: 'source_output'; evidence: HostSourceAnalysisOutput }>
  | Readonly<{ kind: 'root_output'; evidence: HostRootAnalysisOutput }>
  | Readonly<{ kind: 'root_prepared'; preparation: HostRemoteSessionJson }>
  | Readonly<{ kind: 'prepared'; preparation: HostRemoteSessionJson }>
  | Readonly<{ kind: 'reply_source'; capture: HostRemoteSessionJson }>
  | Readonly<{ kind: 'output'; json_base64url: string; analysis_receipt?: HostCollaborationAnalysisReceipt }>
/** Main-only analysis in this connection's token-verified Account Profile. */
export interface ProfileCollaborationAnalysisRequest extends Omit<ProfileSourceSnapshotRequest, 'method' | 'params'> {
  readonly method: 'profile.collaboration_analysis'
  readonly params: Omit<ProfileSourceSnapshotRequest['params'], 'offset' | keyof HostCollaborationSourceTarget> & {
    readonly command: HostCollaborationAnalysisCommand
  }
}
/** Durable preparation or saved original output; neither grants task admission. */
export interface ProfileCollaborationAnalysisResult extends Omit<ProfileSourceSnapshotResult, 'method' | 'result'> {
  readonly method: 'profile.collaboration_analysis'
  readonly result: HostCollaborationAnalysisResult
}
/** Main-only full reply upload into the currently authorized Account Profile. */
export interface ProfileCollaborationDeliveryRequest extends Omit<ProfileCollaborationAnalysisRequest, 'method' | 'params'> {
  readonly method: 'profile.collaboration_delivery'
  readonly params: Omit<ProfileCollaborationAnalysisRequest['params'], 'command'> & {
    readonly command: HostCollaborationDeliveryChunk
  }
}
/** Sequential progress or installation-signed durable commit, without the answer. */
export interface ProfileCollaborationDeliveryResult extends Omit<ProfileCollaborationAnalysisResult, 'method' | 'result'> {
  readonly method: 'profile.collaboration_delivery'
  readonly result: HostCollaborationDeliveryResult
}
/** Server nonce bound to one Source and current registered Host epoch. */
export interface HostSourceAuthorityChallenge extends HostWorkspaceAuthorityChallenge, HostCollaborationSourceDescriptor {
  readonly host_epoch: string
}
/** Installation signature for committed Source contents; no target execution grant. */
export interface HostSourceAuthorityAssertion extends Omit<HostWorkspaceAuthorityAssertion, 'challenge'> {
  readonly challenge: HostSourceAuthorityChallenge
}
/** Account-verified root observation; the signer must read the original journal binding. */
export interface ProfileRootAuthorityRequest extends Omit<ProfileSourceAuthorityRequest, 'method' | 'params'> {
  readonly method: 'profile.root_authority'
  readonly params: Omit<ProfileSourceAuthorityRequest['params'], 'challenge'> & { readonly challenge: HostRootAuthorityChallenge }
}
/** Signature in the dedicated root domain, retaining the original source/root/command. */
export interface ProfileRootAuthorityResult extends Omit<ProfileSourceAuthorityResult, 'method' | 'result'> {
  readonly method: 'profile.root_authority'
  readonly result: HostRootAuthorityAssertion
}
/** Account-verified, Main-only persistent Source observation and signature. */
export interface ProfileSourceAuthorityRequest extends Omit<ProfileWorkspaceAuthorityRequest, 'method' | 'params'> {
  readonly method: 'profile.source_authority'
  readonly params: HostAuthorizedParams & {
    readonly account_binding_handle: HostAccountBindingHandle
    readonly authority_binding_version: number
    readonly challenge: HostSourceAuthorityChallenge
  }
}
/** Signed Source coordinates and full snapshot digest, without message content. */
export interface ProfileSourceAuthorityResult extends Omit<ProfileWorkspaceAuthorityResult, 'method' | 'result'> {
  readonly method: 'profile.source_authority'
  readonly result: HostSourceAuthorityAssertion
}

/** Profile-owned committed transfer grant; coordinates or digests supplied by Desktop grant no access. */
export interface HostCollaborationReferenceGrant extends HostCollaborationSourceDescriptor {
  readonly reference_request_digest: HostControlSha256
}
/** Exact private lookup of an independently committed Source-bound reference selection. */
export interface HostCollaborationReferenceTarget extends HostCollaborationSourceTarget {
  readonly reference_request_digest: HostControlSha256
}
/** Correlates one independently authorized reference selection. */
export type HostCollaborationReferenceRequestId = Branded<'HostCollaborationReferenceRequestId'>
/** One addressed recipient in the original Source. */
export type HostCollaborationMentionId = Branded<'HostCollaborationMentionId'>
/** Locator selection without caller bytes, paths, media type or computed digests. */
export type HostCollaborationReferenceSelection = Readonly<{
  source: Readonly<{ workspace_id: string; session_id: string; source_message_id: string; revision: string }>
  reference_request_id: HostCollaborationReferenceRequestId
  source_kind: 'message' | 'file'
  source_locator: string
  source_version: string
  range: Readonly<{ unit: 'whole' }> | Readonly<{ unit: 'quote'; text: string }>
    | Readonly<{ unit: 'utf16' | 'byte'; start: number; end: number }>
  recipient_mention_ids: readonly HostCollaborationMentionId[]
  source_evidence_spans: readonly Readonly<{ source_message_id: string; source_revision: string; start: number; end: number }>[]
}>
/** Computed Profile metadata; consumers still validate the full request and user sharing intent. */
export type HostCollaborationReferenceCapture = Readonly<{
  descriptor: HostCollaborationSourceDescriptor
  request: HostRemoteSessionJson
  reference_request_digest: HostControlSha256
}>
/** Parent-only capture in this connection's current token-verified Account Profile. */
export interface ProfileReferenceCaptureRequest extends Omit<ProfileCollaborationAnalysisRequest, 'method' | 'params'> {
  readonly method: 'profile.reference_capture'
  readonly params: Omit<ProfileCollaborationAnalysisRequest['params'], 'command'> & {
    readonly selection: HostCollaborationReferenceSelection
  }
}
/** Selection metadata without selected bytes or a reference transfer assertion. */
export interface ProfileReferenceCaptureResult extends Omit<ProfileSourceSnapshotResult, 'method' | 'result'> {
  readonly method: 'profile.reference_capture'
  readonly result: HostCollaborationReferenceCapture
}
/** Original Source and committed reference identity, with a byte offset for bounded reads. */
export interface HostCollaborationReferenceContentTarget extends HostCollaborationReferenceTarget {
  readonly offset: number
}
/** One exact reference byte chunk; consumers verify the complete content hash before use. */
export interface HostCollaborationReferenceContentChunk {
  readonly descriptor: HostCollaborationSourceDescriptor
  readonly reference_request_digest: HostControlSha256
  readonly content_digest: HostControlSha256
  readonly offset: number
  readonly total_bytes: number
  readonly chunk_base64url: string
}
/** Parent-only byte read using the current token-verified Account and separate Reference capability. */
export interface ProfileReferenceContentRequest extends Omit<ProfileSourceSnapshotRequest, 'method' | 'params'> {
  readonly method: 'profile.reference_content'
  readonly params: ProfileSourceSnapshotRequest['params'] & { readonly reference_request_digest: HostControlSha256 }
}
/** Bounded reference bytes; this response does not authorize cloud sharing or recipient task admission. */
export interface ProfileReferenceContentResult extends Omit<ProfileSourceSnapshotResult, 'method' | 'result'> {
  readonly method: 'profile.reference_content'
  readonly result: HostCollaborationReferenceContentChunk
}
/** Server nonce binds the original Source and the complete immutable reference reservation request. */
export interface HostReferenceAuthorityChallenge extends HostSourceAuthorityChallenge {
  readonly reference_request_digest: HostControlSha256
}
/** Installation signature over a separate Profile transfer grant; no target execution authority. */
export interface HostReferenceAuthorityAssertion extends Omit<HostSourceAuthorityAssertion, 'challenge'> {
  readonly challenge: HostReferenceAuthorityChallenge
}
/** Main-only transfer attestation requires current Account access and a separate committed Profile grant. */
export interface ProfileReferenceAuthorityRequest extends Omit<ProfileSourceAuthorityRequest, 'method' | 'params'> {
  readonly method: 'profile.reference_authority'
  readonly params: Omit<ProfileSourceAuthorityRequest['params'], 'challenge'> & {
    readonly challenge: HostReferenceAuthorityChallenge
  }
}
/** Signed reference reservation digest without content, filesystem paths or credentials. */
export interface ProfileReferenceAuthorityResult extends Omit<ProfileSourceAuthorityResult, 'method' | 'result'> {
  readonly method: 'profile.reference_authority'
  readonly result: HostReferenceAuthorityAssertion
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

/** JSON returned from one bounded remote Session command. */
export type HostRemoteSessionJson =
  | null | boolean | number | string
  | readonly HostRemoteSessionJson[]
  | { readonly [key: string]: HostRemoteSessionJson }

/** Opaque-to-browser claim returned by the selected Profile and retained by the daemon. */
export interface HostRemoteSessionControlProof {
  readonly controller_id: string
  readonly generation: string
  readonly epoch: number
}

/** Closed command set exposed to a remote personal client through a leased Profile. */
export type HostRemoteSessionCommand =
  | {
    readonly operation: 'control.status'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly controller_id: string
  }
  | {
    readonly operation: 'control.acquire'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly controller_id: string
    readonly takeover: boolean
    readonly expected_epoch?: number
  }
  | {
    readonly operation: 'control.renew' | 'control.release'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly controller_id: string
    readonly generation: string
    readonly epoch: number
  }
  | { readonly operation: 'session.list'; readonly command_id: HostControlRequestId }
  | { readonly operation: 'directory.pick'
    readonly command_id: HostControlRequestId
    readonly client_id: string }
  | { readonly operation: 'workspace.create'
    readonly command_id: HostControlRequestId
    readonly client_id: string
    readonly grant_id: string
    readonly path: string }
  | { readonly operation: 'session.create'
    readonly command_id: HostControlRequestId
    readonly workspace_id?: string
    readonly session_id?: string }
  | { readonly operation: 'remote.event.respond'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly control: HostRemoteSessionControlProof
    readonly client_id: string
    readonly event_id: string
    readonly outcome: 'allowed-once' | 'rejected' | 'next' }
  | {
    readonly operation: 'session.history'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly max_events: number
  }
  | {
    readonly operation: 'session.prompt'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly control: HostRemoteSessionControlProof
    readonly mode: 'queue'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly client_time_zone?: string
  }
  | {
    readonly operation: 'session.cancel' | 'session.delete'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly control: HostRemoteSessionControlProof
  }
  | {
    readonly operation: 'session.rename'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly control: HostRemoteSessionControlProof
    readonly title: string
  }
  | {
    readonly operation: 'approval.poll'
    readonly command_id: HostControlRequestId
    readonly wait_ms: number
    readonly cursor?: string
  }
  | {
    readonly operation: 'approval.respond'
    readonly command_id: HostControlRequestId
    readonly session_id: string
    readonly control: HostRemoteSessionControlProof
    readonly approval_id: string
    readonly outcome: 'allowed-once' | 'rejected'
    readonly operation_digest?: HostControlSha256
  }

/** Execute one command only through the Profile worker selected by this view lease. */
export interface ProfileRemoteSessionRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_session'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
    readonly command: HostRemoteSessionCommand
  }
}

/** Bounded worker projection; credentials, paths, cookies and launch tokens are excluded. */
export interface ProfileRemoteSessionResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_session'
  readonly result: { readonly value: HostRemoteSessionJson }
}

/** Exact read RPC carried only by a live Host-owned Profile view lease. */
export interface ProfileRemoteUiReadRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_ui_read'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
    readonly endpoint: 'boot/injections' | 'asset/read' | 'asset/describe' | 'session/list' | 'session/page' | 'session/modelCatalog' | 'session/collaborationSources'
      | 'settings/describe' | 'agentPresets/list' | 'dynamicCordisRunner/inventory'
      | 'credentials/describe' | 'permissionPresets/catalog'
    readonly payload: { readonly args: HostRemoteSessionJson }
  }
}

/** One small read projection; the control channel rejects responses above 64 KiB. */
export interface ProfileRemoteUiReadResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_ui_read'
  readonly result: { readonly value: HostRemoteSessionJson }
}

/** Only selected native read streams may cross a live Profile view lease. */
export type ProfileRemoteUiStreamCommand =
  | {
    readonly action: 'open'
    readonly stream_id: string
    readonly endpoint: 'session/follow'
    readonly payload: { readonly args: { readonly request: {
      readonly address: { readonly kind: 'session'; readonly sessionId: string }
        | {
          readonly kind: 'subagent'
          readonly parentSessionId: string
          readonly childSessionId: string
          readonly mode: 'one-shot' | 'continuable'
        }
      readonly maxMessages?: number
      readonly assistantStream?: true
    } } }
  }
  | { readonly action: 'open'
    readonly stream_id: string
    readonly endpoint: 'workspace/follow'
    readonly payload: { readonly args: Record<string, never> } }
  | { readonly action: 'open'
    readonly stream_id: string
    readonly endpoint: '$events'
    readonly payload: { readonly args: Record<string, never> } }
  | { readonly action: 'poll' | 'close'; readonly stream_id: string }

/** One short, lease-authorized stream control RPC. */
export interface ProfileRemoteUiStreamRequest {
  readonly version: 1
  readonly type: 'request'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_ui_stream'
  readonly params: HostAuthorizedParams & {
    readonly view_lease_id: HostViewLeaseId
    readonly lease_generation: number
    readonly runtime_generation: number
    readonly command: ProfileRemoteUiStreamCommand
  }
}

/** At most 16 KiB of one JSON event per frame; terminal errors carry no details. */
export interface ProfileRemoteUiStreamResult {
  readonly version: 1
  readonly type: 'result'
  readonly request_id: HostControlRequestId
  readonly method: 'profile.remote_ui_stream'
  readonly result: { readonly type: 'opened' | 'idle' | 'end' | 'error' | 'closed' }
    | { readonly type: 'chunk'; readonly bytes: string; readonly final: boolean }
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
  | ProfileRemoteSessionRequest
  | ProfileRemoteSessionResult
  | ProfileRemoteUiReadRequest
  | ProfileRemoteUiReadResult
  | ProfileRemoteUiStreamRequest
  | ProfileRemoteUiStreamResult
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
  | ProfileWorkspaceModelSelectionRequest
  | ProfileWorkspaceModelSelectionResult
  | ProfileCollaborationRegistrationRequest
  | ProfileCollaborationRegistrationResult
  | ProfileWorkspaceAuthorityRequest
  | ProfileWorkspaceAuthorityResult
  | ProfileRootJournalRequest
  | ProfileRootJournalResult
  | ProfileRootPlanningAttemptAuthorityRequest
  | ProfileRootPlanningAttemptAuthorityResult
  | ProfileRootAuthorityRequest
  | ProfileRootAuthorityResult
  | ProfileSourceAuthorityRequest
  | ProfileSourceAuthorityResult
  | ProfileReferenceAuthorityRequest
  | ProfileReferenceAuthorityResult
  | ProfileReferenceCaptureRequest
  | ProfileReferenceCaptureResult
  | ProfileReferenceContentRequest
  | ProfileReferenceContentResult
  | ProfileCollaborationAnalysisRequest
  | ProfileCollaborationAnalysisResult
  | ProfileCollaborationDeliveryRequest
  | ProfileCollaborationDeliveryResult
  | ProfileSourceSnapshotRequest
  | ProfileSourceSnapshotResult
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

/** Installation signature binding one saved analysis output; it grants no task authority. */
export type HostCollaborationAnalysisReceipt = Readonly<{
  schema_version: 1
  authority_environment_id: string
  account_binding_handle: string
  authority_binding_version: number
  account_issuer: string
  account_subject: string
  installation_id: string
  installation_public_key: string
  host_instance_id: string
  process_nonce: string
  dispatch: Readonly<{
    attempt_request_id: string
    plan_id: string
    expected_plan_revision: string
    attempt_id: string
    attempt_fence: string
    input_manifest_digest: string
    source_digest: string
    lease_expires_at: string
    dispatch_granted: true
  }>
  output_digest: string
  signature: string
}>
/** Account-authorized private root journal read or acknowledgement. */
export interface ProfileRootJournalRequest extends Omit<ProfileCollaborationAnalysisRequest, 'method' | 'params'> {
  readonly method: 'profile.root_journal'
  readonly params: Omit<ProfileCollaborationAnalysisRequest['params'], 'command'> & { readonly command: HostRootJournalCommand }
}
/** Bounded metadata; complete Source bytes use profile.source_snapshot. */
export interface ProfileRootJournalResult extends Omit<ProfileRootAuthorityResult, 'method' | 'result'> {
  readonly method: 'profile.root_journal'
  readonly result: HostRootJournalMetadata
}

/** Authenticated current-Account request for one persisted fresh planning attempt. */
export interface ProfileRootPlanningAttemptAuthorityRequest extends Omit<ProfileRootAuthorityRequest, 'method' | 'params'> {
  readonly method: 'profile.root_planning_attempt_authority'
  readonly params: Omit<ProfileRootAuthorityRequest['params'], 'challenge'> & { readonly challenge: HostRootPlanningAttemptAuthorityChallenge }
}
/** Fresh attempt proof, never an execution or dispatch grant. */
export interface ProfileRootPlanningAttemptAuthorityResult extends Omit<ProfileRootAuthorityResult, 'method' | 'result'> {
  readonly method: 'profile.root_planning_attempt_authority'
  readonly result: HostRootPlanningAttemptAuthorityAssertion
}
