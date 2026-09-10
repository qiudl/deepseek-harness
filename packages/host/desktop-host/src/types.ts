import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable profile id that reveals no account or environment identifier. */
export type PersonProfileId = Branded<'PersonProfileId'>
/** Ephemeral Main-process lease authorizing one personal DSH window. */
export type ProfileViewLeaseId = Branded<'ProfileViewLeaseId'>
/** Single-use Main-only capability for one Profile view activation. */
export type ProfileViewActivationHandle = Branded<'ProfileViewActivationHandle'>
/** Session-scoped enterprise context lease. */
export type ContextLeaseId = Branded<'ContextLeaseId'>
/** Process-local opaque candidate for one inspected offline Account Profile. */
export type OfflineProfileRecoveryCandidateId = Branded<'OfflineProfileRecoveryCandidateId'>
/** Desktop-minted idempotency key for one confirmed offline recovery operation. */
export type OfflineProfileRecoveryOperationId = Branded<'OfflineProfileRecoveryOperationId'>

/** Mutually exclusive authority granted to one authenticated Host connection. */
export type ProfileAccessScope = 'connected' | 'local_profile' | 'offline_local'

/** Clock dependency used to make expiry decisions deterministic. */
export interface HostClock { now(): number }

/** Closed Host authority errors; arbitrary local exception text never crosses IPC. */
export type HostAuthorityErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'profile_locked'
  | 'profile_mismatch'
  | 'unauthorized'
  | 'stale'
  | 'replayed'
  | 'idempotency_conflict'
  | 'busy'
  | 'upgrade_required'
  | 'unavailable'
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

/** Typed failure that Desktop maps onto the Host control protocol vocabulary. */
export class HostAuthorityError extends Error {
  /** @param code - Stable code safe for the local broker. */
  constructor(readonly code: HostAuthorityErrorCode) {
    super(`DSH Host authority rejected operation: ${code}`)
    this.name = 'HostAuthorityError'
  }
}

/** Issuer-qualified opaque DSH Account subject. */
export interface AccountIdentity {
  readonly issuer: string
  readonly subject: string
}

/** Non-secret registry row. Raw account identity and profile unlock key are excluded. */
export interface PersonProfileRecord {
  readonly profileId: PersonProfileId
  readonly kind: 'account' | 'local-anonymous'
  readonly personIndex: string
  readonly keyHandle: string
  readonly unlockVerifier: string | null
  readonly accountBindings?: readonly {
    readonly authorityEnvironmentId: string
    readonly handle: string
    readonly authorityBindingVersion: number
  }[]
  readonly bindingGeneration: number
  readonly createdAt: number
}

/** Worker inputs scoped to exactly one Person Profile. */
export interface ProfileWorkerSpec {
  readonly profileId: string
  readonly profileRoot: string
  readonly credentialHandle: string
  readonly pluginRoots: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Child lifecycle whose disposal reaches process quiescence. */
export interface ProfileWorkerHandle {
  closeNotifications(): void
  abort(): void
  readonly done: Promise<void>
  /** Host-verified loopback origin when this worker owns a personal Web view. */
  readonly viewOrigin?: string
  /** Monotonic worker generation associated with `viewOrigin`. */
  readonly generation?: number
  /** Signed browser cookie exchanged owner-side; it never enters Renderer or logs. */
  readonly bootstrapCookie?: { readonly name: string; readonly value: string }
}

/** Factory that starts one isolated profile worker. */
export type ProfileWorkerFactory = (spec: ProfileWorkerSpec) => Promise<ProfileWorkerHandle>

/** Main-only result used to create a local personal DSH window. */
export interface ProfileOpenResult {
  readonly profileId: PersonProfileId
  readonly viewLeaseId: ProfileViewLeaseId
  readonly viewActivationHandle: ProfileViewActivationHandle
  readonly leaseGeneration: number
  readonly expiresAt: number
  readonly runtimeGeneration: number
}

/** Safe, non-identifying facts returned by an offline Account Profile preflight. */
export interface OfflineProfileRecoveryCandidate {
  readonly state: 'recoverable' | 'compatibility_blocked'
  readonly candidateId: OfflineProfileRecoveryCandidateId
  readonly profileKind: 'account'
  readonly bindingCount: number
  readonly persistenceGeneration: number
  readonly sessionCount: number
  readonly pluginCount: number
  readonly compatibility: 'current' | 'legacy_runtime_required' | 'read_only_export_only'
  readonly preflightDigest: string
  readonly reasonCode?: string
}

/** Host-internal preflight facts supplied by the persistence/runtime inspector. */
export type OfflineProfileRecoveryPreflight = Omit<OfflineProfileRecoveryCandidate,
  'candidateId' | 'profileKind' | 'bindingCount'>

/** Result of a confirmed offline Account Profile recovery. */
export interface OfflineProfileRecoveryResult {
  readonly state: 'offline_ready'
  readonly profileId: PersonProfileId
  readonly accessScope: 'offline_local'
  readonly persistenceGeneration: number
  readonly runtimeGeneration: number
  /** Internal selector fence consumed by the Host transport; not returned on the wire. */
  readonly bindingGeneration: number
}

/** Stable, secret-free state for an idempotent offline recovery operation. */
export type OfflineProfileRecoveryStatus =
  | { readonly state: 'recovering' | 'offline_ready' | 'unknown' }
  | { readonly state: 'failed'; readonly reasonCode: 'recovery_worker_failed' }

/** View lease available only through the offline Account entry point. */
export interface OfflineProfileOpenResult extends ProfileOpenResult {
  readonly accessScope: 'offline_local'
}

/** Verified Main-only loopback view activation. */
export interface ProfileViewActivationResult {
  readonly origin: string
  readonly activationGeneration: number
  readonly expiresAt: number
  readonly bootstrapCookie: { readonly name: string; readonly value: string }
}
