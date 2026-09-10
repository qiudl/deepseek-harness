import { randomBytes, randomUUID } from 'node:crypto'
import type {
  HostClock,
  OfflineProfileOpenResult,
  OfflineProfileRecoveryCandidate,
  OfflineProfileRecoveryCandidateId,
  OfflineProfileRecoveryOperationId,
  OfflineProfileRecoveryPreflight,
  OfflineProfileRecoveryResult,
  OfflineProfileRecoveryStatus,
  PersonProfileId,
  PersonProfileRecord,
  ProfileAccessScope,
  ProfileOpenResult,
  ProfileViewActivationHandle,
  ProfileViewActivationResult,
  ProfileViewLeaseId,
} from './types.ts'
import { HostAuthorityError } from './types.ts'
import type { ProfileRegistry } from './profile-registry.ts'

interface DesktopHostOptions {
  readonly registry: ProfileRegistry
  readonly clock: HostClock
  readonly runtimeGeneration: number
  readonly verifyAccountAccessToken?: (token: string) => { readonly issuer: string; readonly subject: string }
  readonly viewLeaseTtlMs?: number
  readonly activateProfileView?: (profileId: PersonProfileId) => Promise<{
    readonly origin: string
    readonly generation: number
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }>
  readonly ensureProfileWorker?: (profile: PersonProfileRecord) => Promise<void>
  readonly inspectOfflineAccountProfile?: (
    profile: PersonProfileRecord,
    expected: { readonly runtimeGeneration: number; readonly schemaGeneration: number },
  ) => Promise<OfflineProfileRecoveryPreflight>
  readonly ensureRecoveredProfileWorker?: (
    profile: PersonProfileRecord,
    preflight: OfflineProfileRecoveryPreflight,
  ) => Promise<void>
}

interface ViewLease {
  readonly profileId: PersonProfileId
  readonly generation: number
  expiresAt: number
  readonly ownerId: string
  activationHandle?: ProfileViewActivationHandle
  activating?: boolean
}

interface ProfileAccessGrant {
  readonly scope: ProfileAccessScope
  readonly operationId?: OfflineProfileRecoveryOperationId
  readonly grantedAt: number
}

interface RecoveryCandidateState {
  readonly ownerId: string
  readonly profile: PersonProfileRecord
  readonly keyHandle: string
  readonly preflight: OfflineProfileRecoveryPreflight
  readonly expectedRuntimeGeneration: number
  readonly expectedSchemaGeneration: number
  readonly expiresAt: number
}

type RecoveryOperationState = {
  readonly ownerId: string
  readonly candidateId: OfflineProfileRecoveryCandidateId
  readonly profileId: PersonProfileId
  readonly keyHandle: string
  readonly preflightDigest: string
  promise?: Promise<OfflineProfileRecoveryResult>
  result?: OfflineProfileRecoveryResult
  errorCode?: 'recovery_worker_failed'
  revoked?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RECOVERY_CANDIDATE_TTL_MS = 5 * 60_000

function exactLoopbackOrigin(value: string): string {
  if (!/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(value)) throw new HostAuthorityError('unavailable')
  const port = Number(value.slice(value.lastIndexOf(':') + 1))
  if (port > 65_535) throw new HostAuthorityError('unavailable')
  return value
}

function activationHandle(): ProfileViewActivationHandle {
  return randomBytes(32).toString('base64url') as ProfileViewActivationHandle
}

/** Main-process Host facade. It owns no HTTP listener and returns no URL, cookie, token, or account subject. */
export class DesktopHost {
  private readonly leases = new Map<ProfileViewLeaseId, ViewLease>()
  private readonly generations = new Map<PersonProfileId, number>()
  private readonly ownerGrants = new Map<string, Map<PersonProfileId, ProfileAccessGrant>>()
  private readonly recoveryCandidates = new Map<OfflineProfileRecoveryCandidateId, RecoveryCandidateState>()
  private readonly recoveryOperations = new Map<OfflineProfileRecoveryOperationId, RecoveryOperationState>()
  private readonly profileRecoveries = new Map<PersonProfileId, OfflineProfileRecoveryOperationId>()
  constructor(private readonly options: DesktopHostOptions) {
    if (!Number.isSafeInteger(options.runtimeGeneration) || options.runtimeGeneration <= 0) {
      throw new HostAuthorityError('invalid_input')
    }
  }

  /** Return whether this Host can inspect and prepare existing offline Account Profiles. */
  supportsOfflineAccountRecovery(): boolean {
    return this.options.inspectOfflineAccountProfile !== undefined
      && this.options.ensureRecoveredProfileWorker !== undefined
  }

  /**
   * Report whether a secure Desktop account binding resolves to a Profile.
   * @param input - opaque account binding selected by Desktop Main.
   * @returns availability without exposing Profile secrets.
   */
  getProfileStatus(input: {
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly ownerId: string
  }):
    | { readonly state: 'ready'; readonly profileId: PersonProfileId }
    | { readonly state: 'unbound' | 'locked' } {
    const profile = this.options.registry.resolveBinding(
      input.authorityEnvironmentId, input.accountBindingHandle, input.authorityBindingVersion,
    )
    if (!profile) return { state: 'unbound' }
    return this.hasGrant(input.ownerId, profile.profileId, 'connected')
      ? { state: 'ready', profileId: profile.profileId }
      : { state: 'locked' }
  }

  /**
   * Idempotently register one account Profile and start its isolated worker.
   * @param input - Main-owned Account token and identity plus opaque binding and Keychain handles.
   * @returns ready Profile id after both registry persistence and worker readiness.
   */
  async ensureAccountProfile(input: {
    readonly issuer: string
    readonly subject: string
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly accountAccessToken: string
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const verifyAccountAccessToken = this.options.verifyAccountAccessToken
    if (!verifyAccountAccessToken) throw new HostAuthorityError('unavailable')
    let account: { readonly issuer: string; readonly subject: string }
    try { account = verifyAccountAccessToken(input.accountAccessToken) } catch { throw new HostAuthorityError('unauthorized') }
    if (account.issuer !== input.issuer || account.subject !== input.subject) {
      throw new HostAuthorityError('profile_mismatch')
    }
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    const profile = await this.options.registry.provisionAccount({
      issuer: input.issuer, subject: input.subject, accountBindingHandle: input.accountBindingHandle,
      authorityEnvironmentId: input.authorityEnvironmentId,
      authorityBindingVersion: input.authorityBindingVersion, keyHandle: input.keyHandle,
      unlockMaterial: input.unlockMaterial,
    }, ensureWorker)
    this.grant(input.ownerId, profile.profileId, 'connected')
    return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
  }

  /**
   * Restore a selector-authorized Profile only when its current binding and Main-vault proof match.
   * A selector made stale by another environment's binding update may be refreshed offline, but a
   * revoked/replaced binding, future selector generation, or different Keychain proof is rejected.
   * @param input - verified selector facts, current binding authority, and opaque vault handle.
   * @returns ready Profile id and current binding generation.
   */
  async restoreProfile(input: {
    readonly profileId: PersonProfileId
    readonly bindingGeneration: number
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || profile.kind !== 'account') throw new HostAuthorityError('unauthorized')
    if (profile.bindingGeneration < input.bindingGeneration) throw new HostAuthorityError('stale')
    if (profile.keyHandle !== input.keyHandle) throw new HostAuthorityError('unauthorized')
    this.options.registry.verifyUnlock(profile, input.keyHandle, input.unlockMaterial)
    const bindingProfile = this.options.registry.resolveBinding(
      input.authorityEnvironmentId, input.accountBindingHandle, input.authorityBindingVersion,
    )
    if (bindingProfile?.profileId !== profile.profileId) throw new HostAuthorityError('stale')
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    await ensureWorker(profile)
    this.grant(input.ownerId, profile.profileId, 'connected')
    return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
  }

  /**
   * Bootstrap or unlock one local-only Profile without accepting an Account identity or token.
   * @param input - Main-vault unlock material and authenticated connection owner.
   * @returns The Profile identity and binding generation after worker readiness.
   */
  async bootstrapLocalProfile(input: {
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const profile = await this.options.registry.createLocalAnonymous(input)
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    await ensureWorker(profile)
    this.grant(input.ownerId, profile.profileId, 'local_profile')
    return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
  }

  /**
   * Restore an existing local-only Profile using only Main-vault material.
   * @param input - Exact Profile generation, unlock material, and connection owner.
   * @returns The restored Profile identity and binding generation after worker readiness.
   */
  async restoreLocalProfile(input: {
    readonly profileId: PersonProfileId
    readonly bindingGeneration: number
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || profile.kind !== 'local-anonymous' || profile.bindingGeneration !== input.bindingGeneration) {
      throw new HostAuthorityError('stale')
    }
    this.options.registry.verifyUnlock(profile, input.keyHandle, input.unlockMaterial)
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    await ensureWorker(profile)
    this.grant(input.ownerId, profile.profileId, 'local_profile')
    return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
  }

  /**
   * Mint or extend a short-lived, generation-fenced lease retained by Desktop Main.
   * @param input - binding and authenticated connection owner.
   * @returns a Profile lease without URL, token, credential, or path data.
   */
  async openProfile(input: {
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly ownerId: string
  }): Promise<ProfileOpenResult> {
    await Promise.resolve()
    const profile = this.options.registry.resolveBinding(
      input.authorityEnvironmentId, input.accountBindingHandle, input.authorityBindingVersion,
    )
    if (!profile || !this.hasGrant(input.ownerId, profile.profileId, 'connected')) {
      throw new HostAuthorityError('profile_locked')
    }
    return this.openUnlockedProfile(profile.profileId, input.ownerId)
  }

  /**
   * Open a local-only Profile after bootstrap or restore on the same authenticated connection.
   * @param input - Local Profile and the authenticated owner that unlocked it.
   * @returns A short-lived view lease without URL or credential data.
   */
  async openLocalProfile(input: {
    readonly profileId: PersonProfileId
    readonly ownerId: string
  }): Promise<ProfileOpenResult> {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || profile.kind !== 'local-anonymous' || !this.hasGrant(input.ownerId, profile.profileId, 'local_profile')) {
      throw new HostAuthorityError('profile_locked')
    }
    return await Promise.resolve(this.openUnlockedProfile(profile.profileId, input.ownerId))
  }

  /**
   * Inspect only the Account Profiles named by trusted Main-vault key handles.
   * No unlock proof is read and no Profile worker or plugin is started.
   * @param input - bounded opaque handles and packaged runtime/schema expectations.
   * @returns anonymous, owner-bound recovery candidates.
   */
  async inspectOfflineAccountProfiles(input: {
    readonly keyHandles: readonly string[]
    readonly expectedRuntimeGeneration: number
    readonly expectedSchemaGeneration: number
    readonly ownerId: string
  }): Promise<{ readonly candidates: readonly OfflineProfileRecoveryCandidate[] }> {
    if (input.keyHandles.length < 1 || input.keyHandles.length > 128
      || new Set(input.keyHandles).size !== input.keyHandles.length
      || !Number.isSafeInteger(input.expectedRuntimeGeneration) || input.expectedRuntimeGeneration <= 0
      || input.expectedRuntimeGeneration !== this.options.runtimeGeneration
      || !Number.isSafeInteger(input.expectedSchemaGeneration) || input.expectedSchemaGeneration <= 0) {
      throw new HostAuthorityError('invalid_input')
    }
    const inspect = this.options.inspectOfflineAccountProfile
    if (!inspect) throw new HostAuthorityError('unavailable')
    for (const [candidateId, candidate] of this.recoveryCandidates) {
      if (candidate.expiresAt <= this.options.clock.now()) this.recoveryCandidates.delete(candidateId)
    }
    const candidates: OfflineProfileRecoveryCandidate[] = []
    for (const keyHandle of input.keyHandles) {
      let profile: PersonProfileRecord
      try { profile = this.options.registry.resolveUniqueAccountByKeyHandle(keyHandle) } catch (error) {
        if (error instanceof HostAuthorityError && error.code === 'profile_not_found') continue
        throw error
      }
      const preflight = await inspect(profile, {
        runtimeGeneration: input.expectedRuntimeGeneration,
        schemaGeneration: input.expectedSchemaGeneration,
      })
      this.validateRecoveryPreflight(preflight)
      const candidateId = randomUUID() as OfflineProfileRecoveryCandidateId
      this.recoveryCandidates.set(candidateId, {
        ownerId: input.ownerId, profile, keyHandle, preflight,
        expectedRuntimeGeneration: input.expectedRuntimeGeneration,
        expectedSchemaGeneration: input.expectedSchemaGeneration,
        expiresAt: this.options.clock.now() + RECOVERY_CANDIDATE_TTL_MS,
      })
      candidates.push({
        ...preflight, candidateId, profileKind: 'account',
        bindingCount: profile.accountBindings?.length ?? 0,
      })
    }
    if (candidates.length === 0) throw new HostAuthorityError('profile_not_found')
    return { candidates }
  }

  /**
   * Confirm one inspected Account Profile using its Main-vault proof and start it existing-only.
   * Registry identity and account bindings are never mutated by this operation.
   * @param input - owner-bound candidate, idempotency key, digest, and ephemeral unlock proof.
   * @returns an offline-only grant after the recovered worker reports ready.
   */
  async recoverOfflineAccountProfile(input: {
    readonly candidateId: OfflineProfileRecoveryCandidateId
    readonly preflightDigest: string
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly operationId: string
    readonly ownerId: string
  }): Promise<OfflineProfileRecoveryResult> {
    if (!UUID.test(input.operationId) || !SHA256.test(input.preflightDigest)) {
      throw new HostAuthorityError('invalid_input')
    }
    const operationId = input.operationId as OfflineProfileRecoveryOperationId
    const existing = this.recoveryOperations.get(operationId)
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.candidateId !== input.candidateId
        || existing.keyHandle !== input.keyHandle || existing.preflightDigest !== input.preflightDigest) {
        throw new HostAuthorityError('idempotency_conflict')
      }
      if (!existing.promise) throw new HostAuthorityError('unavailable')
      return await existing.promise
    }
    const candidate = this.recoveryCandidates.get(input.candidateId)
    if (!candidate || candidate.ownerId !== input.ownerId || candidate.expiresAt <= this.options.clock.now()) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    if (candidate.keyHandle !== input.keyHandle || candidate.preflight.preflightDigest !== input.preflightDigest) {
      throw new HostAuthorityError('recovery_preflight_stale')
    }
    const current = this.options.registry.resolveProfile(candidate.profile.profileId)
    if (current !== candidate.profile) throw new HostAuthorityError('recovery_preflight_stale')
    try { this.options.registry.verifyUnlock(current, input.keyHandle, input.unlockMaterial) } catch (error) {
      if (error instanceof HostAuthorityError && error.code === 'invalid_input') throw error
      throw new HostAuthorityError('recovery_proof_mismatch')
    }
    const inspect = this.options.inspectOfflineAccountProfile
    if (!inspect) throw new HostAuthorityError('unavailable')
    if (candidate.preflight.state !== 'recoverable') throw new HostAuthorityError('runtime_incompatible')
    const ensureWorker = this.options.ensureRecoveredProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    const existingGrant = this.ownerGrants.get(input.ownerId)?.get(current.profileId)
    if (existingGrant && existingGrant.scope !== 'offline_local') throw new HostAuthorityError('scope_mismatch')
    if (this.profileRecoveries.has(current.profileId)) throw new HostAuthorityError('recovery_in_progress')

    const operation: RecoveryOperationState = {
      ownerId: input.ownerId, candidateId: input.candidateId, profileId: current.profileId,
      keyHandle: input.keyHandle, preflightDigest: input.preflightDigest,
    }
    const promise = (async (): Promise<OfflineProfileRecoveryResult> => {
      try {
        await Promise.resolve()
        const refreshed = await inspect(current, {
          runtimeGeneration: candidate.expectedRuntimeGeneration,
          schemaGeneration: candidate.expectedSchemaGeneration,
        })
        this.validateRecoveryPreflight(refreshed)
        if (refreshed.preflightDigest !== candidate.preflight.preflightDigest
          || refreshed.state !== candidate.preflight.state
          || refreshed.persistenceGeneration !== candidate.preflight.persistenceGeneration
          || refreshed.sessionCount !== candidate.preflight.sessionCount
          || refreshed.pluginCount !== candidate.preflight.pluginCount
          || refreshed.compatibility !== candidate.preflight.compatibility
          || refreshed.reasonCode !== candidate.preflight.reasonCode) {
          throw new HostAuthorityError('recovery_preflight_stale')
        }
        await ensureWorker(current, refreshed)
        if (operation.revoked) throw new HostAuthorityError('recovery_worker_failed')
        const result: OfflineProfileRecoveryResult = {
          state: 'offline_ready', profileId: current.profileId, accessScope: 'offline_local',
          persistenceGeneration: candidate.preflight.persistenceGeneration,
          runtimeGeneration: this.options.runtimeGeneration,
          bindingGeneration: current.bindingGeneration,
        }
        this.grant(input.ownerId, current.profileId, 'offline_local', operationId)
        operation.result = result
        return result
      } catch (error) {
        if (error instanceof HostAuthorityError
          && ['recovery_preflight_stale', 'runtime_incompatible', 'profile_integrity_failed'].includes(error.code)) {
          this.recoveryOperations.delete(operationId)
          throw error
        }
        operation.errorCode = 'recovery_worker_failed'
        throw new HostAuthorityError('recovery_worker_failed')
      } finally {
        this.profileRecoveries.delete(current.profileId)
        if (operation.revoked) this.recoveryOperations.delete(operationId)
      }
    })()
    operation.promise = promise
    this.recoveryOperations.set(operationId, operation)
    this.profileRecoveries.set(current.profileId, operationId)
    return await promise
  }

  /**
   * Query one process-local recovery operation without retrying worker startup.
   * @param input - Desktop idempotency key and the same authenticated connection owner.
   * @returns stable progress or terminal state without Profile or credential data.
   */
  getOfflineAccountRecoveryStatus(input: {
    readonly operationId: string
    readonly ownerId: string
  }): OfflineProfileRecoveryStatus {
    if (!UUID.test(input.operationId)) throw new HostAuthorityError('invalid_input')
    const operation = this.recoveryOperations.get(input.operationId as OfflineProfileRecoveryOperationId)
    if (!operation || operation.ownerId !== input.ownerId || operation.revoked) return { state: 'unknown' }
    if (operation.result) return { state: 'offline_ready' }
    if (operation.errorCode) return { state: 'failed', reasonCode: operation.errorCode }
    return { state: 'recovering' }
  }

  /**
   * Open an Account Profile only when this owner holds an offline_local grant.
   * @param input - recovered Profile id and authenticated connection owner.
   * @returns an offline-scoped local view lease.
   */
  async openOfflineAccountProfile(input: {
    readonly profileId: PersonProfileId
    readonly bindingGeneration: number
    readonly ownerId: string
  }): Promise<OfflineProfileOpenResult> {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || profile.kind !== 'account' || profile.bindingGeneration !== input.bindingGeneration
      || !this.hasGrant(input.ownerId, profile.profileId, 'offline_local')) {
      throw new HostAuthorityError('profile_locked')
    }
    return await Promise.resolve({
      ...this.openUnlockedProfile(profile.profileId, input.ownerId), accessScope: 'offline_local' as const,
    })
  }

  private openUnlockedProfile(profileId: PersonProfileId, ownerId: string): ProfileOpenResult {
    const now = this.options.clock.now()
    const expiresAt = now + (this.options.viewLeaseTtlMs ?? 60_000)
    for (const [viewLeaseId, lease] of this.leases) {
      if (lease.ownerId === ownerId && lease.profileId === profileId && lease.expiresAt > now
        && this.generations.get(profileId) === lease.generation) {
        lease.expiresAt = expiresAt
        lease.activationHandle ??= activationHandle()
        return {
          profileId,
          viewLeaseId,
          viewActivationHandle: lease.activationHandle,
          leaseGeneration: lease.generation,
          expiresAt: lease.expiresAt,
          runtimeGeneration: this.options.runtimeGeneration,
        }
      }
    }
    const generation = (this.generations.get(profileId) ?? 0) + 1
    this.generations.set(profileId, generation)
    const viewLeaseId = randomUUID() as ProfileViewLeaseId
    const viewActivationHandle = activationHandle()
    this.leases.set(viewLeaseId, {
      profileId, generation, expiresAt, ownerId, activationHandle: viewActivationHandle,
    })
    return {
      profileId,
      viewLeaseId,
      viewActivationHandle,
      leaseGeneration: generation,
      expiresAt,
      runtimeGeneration: this.options.runtimeGeneration,
    }
  }

  /**
   * Revalidate the profile and binding generation carried by a Host-signed selector.
   * @param input - authenticated owner and signed-selector claims.
   * @returns the currently authorized Profile id.
   */
  authorizeMigrationProfileSelector(input: {
    readonly profileId: PersonProfileId
    readonly bindingGeneration: number
    readonly ownerId: string
  }): PersonProfileId {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || !['account', 'local-anonymous'].includes(profile.kind)
      || profile.bindingGeneration !== input.bindingGeneration
      || (!this.hasGrant(input.ownerId, profile.profileId, 'connected')
        && !this.hasGrant(input.ownerId, profile.profileId, 'local_profile'))) {
      throw new HostAuthorityError('unauthorized')
    }
    return profile.profileId
  }

  /**
   * Consume one connection-bound activation after its Profile worker listener is verified.
   * @param input - opaque activation capability plus every Profile and process generation fence.
   * @returns exact loopback origin retained by Desktop Main only.
   */
  async activateView(input: {
    readonly profileId: PersonProfileId
    readonly viewLeaseId: ProfileViewLeaseId
    readonly viewActivationHandle: ProfileViewActivationHandle
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly ownerId: string
  }): Promise<ProfileViewActivationResult> {
    if (input.runtimeGeneration !== this.options.runtimeGeneration) throw new HostAuthorityError('stale')
    const lease = this.leases.get(input.viewLeaseId)
    if (!lease || lease.ownerId !== input.ownerId || lease.profileId !== input.profileId
      || lease.generation !== input.leaseGeneration || lease.expiresAt <= this.options.clock.now()
      || lease.activationHandle !== input.viewActivationHandle) throw new HostAuthorityError('stale')
    if (lease.activating) throw new HostAuthorityError('busy')
    const activate = this.options.activateProfileView
    if (!activate) throw new HostAuthorityError('unavailable')
    lease.activating = true
    try {
      const activated = await activate(lease.profileId)
      if (!Number.isSafeInteger(activated.generation) || activated.generation <= 0) throw new HostAuthorityError('unavailable')
      const origin = exactLoopbackOrigin(activated.origin)
      delete lease.activationHandle
      return {
        origin, activationGeneration: activated.generation, expiresAt: lease.expiresAt,
        bootstrapCookie: activated.bootstrapCookie,
      }
    } finally {
      lease.activating = false
    }
  }

  /**
   * Validate the Main-injected view lease before a local window operation.
   * @param input - lease identity, generation, and connection owner.
   * @returns the authorized Profile id.
   */
  validateViewLease(input: {
    readonly viewLeaseId: ProfileViewLeaseId
    readonly leaseGeneration: number
    readonly ownerId: string
  }): PersonProfileId {
    const lease = this.leases.get(input.viewLeaseId)
    if (!lease || lease.ownerId !== input.ownerId || lease.expiresAt <= this.options.clock.now()
      || lease.generation !== input.leaseGeneration || this.generations.get(lease.profileId) !== lease.generation) {
      throw new HostAuthorityError('stale')
    }
    return lease.profileId
  }

  /**
   * Revoke one local window lease.
   * @param viewLeaseId - opaque lease to revoke.
   */
  closeViewLease(viewLeaseId: ProfileViewLeaseId): void { this.leases.delete(viewLeaseId) }

  /**
   * Idempotently close one lease without allowing a connection to close another owner's lease.
   * @param input - lease, process generation, and authenticated connection owner.
   */
  closeOwnedViewLease(input: {
    readonly viewLeaseId: ProfileViewLeaseId
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly ownerId: string
  }): void {
    if (input.runtimeGeneration !== this.options.runtimeGeneration) throw new HostAuthorityError('stale')
    const lease = this.leases.get(input.viewLeaseId)
    if (!lease) return
    if (lease.ownerId !== input.ownerId) throw new HostAuthorityError('profile_mismatch')
    if (lease.generation !== input.leaseGeneration) throw new HostAuthorityError('stale')
    this.leases.delete(input.viewLeaseId)
  }

  /**
   * Revoke every lease minted for a disconnected or aborted local broker.
   * @param ownerId - authenticated connection owner to revoke.
   */
  revokeOwner(ownerId: string): void {
    for (const [leaseId, lease] of this.leases) if (lease.ownerId === ownerId) this.leases.delete(leaseId)
    this.ownerGrants.delete(ownerId)
    for (const [candidateId, candidate] of this.recoveryCandidates) {
      if (candidate.ownerId === ownerId) this.recoveryCandidates.delete(candidateId)
    }
    for (const [operationId, operation] of this.recoveryOperations) {
      if (operation.ownerId !== ownerId) continue
      operation.revoked = true
      if (operation.result !== undefined || operation.errorCode !== undefined) this.recoveryOperations.delete(operationId)
    }
  }

  /**
   * Revoke every view lease before an active persistence generation changes.
   * @param profileId - Profile whose leases must be revoked.
   */
  revokeProfile(profileId: PersonProfileId): void {
    for (const [leaseId, lease] of this.leases) if (lease.profileId === profileId) this.leases.delete(leaseId)
  }

  private grant(
    ownerId: string,
    profileId: PersonProfileId,
    scope: ProfileAccessScope,
    operationId?: OfflineProfileRecoveryOperationId,
  ): void {
    const profiles = this.ownerGrants.get(ownerId) ?? new Map<PersonProfileId, ProfileAccessGrant>()
    profiles.set(profileId, { scope, ...(operationId === undefined ? {} : { operationId }), grantedAt: this.options.clock.now() })
    this.ownerGrants.set(ownerId, profiles)
  }

  private hasGrant(ownerId: string, profileId: PersonProfileId, scope: ProfileAccessScope): boolean {
    return this.ownerGrants.get(ownerId)?.get(profileId)?.scope === scope
  }

  private validateRecoveryPreflight(preflight: OfflineProfileRecoveryPreflight): void {
    if (!['recoverable', 'compatibility_blocked'].includes(preflight.state)
      || !['current', 'legacy_runtime_required', 'read_only_export_only'].includes(preflight.compatibility)
      || !Number.isSafeInteger(preflight.persistenceGeneration) || preflight.persistenceGeneration < 0
      || !Number.isSafeInteger(preflight.sessionCount) || preflight.sessionCount < 0
      || !Number.isSafeInteger(preflight.pluginCount) || preflight.pluginCount < 0
      || !SHA256.test(preflight.preflightDigest)
      || (preflight.reasonCode !== undefined
        && (preflight.reasonCode.length < 1 || preflight.reasonCode.length > 128))) {
      throw new HostAuthorityError('profile_integrity_failed')
    }
  }
}
