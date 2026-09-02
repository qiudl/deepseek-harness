import { randomBytes, randomUUID } from 'node:crypto'
import type {
  HostClock,
  PersonProfileId,
  PersonProfileRecord,
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
  readonly viewLeaseTtlMs?: number
  readonly activateProfileView?: (profileId: PersonProfileId) => Promise<{
    readonly origin: string
    readonly generation: number
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }>
  readonly ensureProfileWorker?: (profile: PersonProfileRecord) => Promise<void>
}

interface ViewLease {
  readonly profileId: PersonProfileId
  readonly generation: number
  readonly expiresAt: number
  readonly ownerId: string
  activationHandle?: ProfileViewActivationHandle
  activating?: boolean
}

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
  private readonly ownerUnlocks = new Map<string, Set<PersonProfileId>>()
  constructor(private readonly options: DesktopHostOptions) {
    if (!Number.isSafeInteger(options.runtimeGeneration) || options.runtimeGeneration <= 0) {
      throw new HostAuthorityError('invalid_input')
    }
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
    return this.ownerUnlocks.get(input.ownerId)?.has(profile.profileId)
      ? { state: 'ready', profileId: profile.profileId }
      : { state: 'locked' }
  }

  /**
   * Idempotently register one account Profile and start its isolated worker.
   * @param input - Main-owned account identity plus opaque binding and Keychain handles.
   * @returns ready Profile id after both registry persistence and worker readiness.
   */
  async ensureAccountProfile(input: {
    readonly issuer: string
    readonly subject: string
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const existing = await this.options.registry.resolveAccount(input)
    const profile = await this.options.registry.registerAccount({
      issuer: input.issuer, subject: input.subject, accountBindingHandle: input.accountBindingHandle,
      authorityEnvironmentId: input.authorityEnvironmentId,
      authorityBindingVersion: input.authorityBindingVersion, keyHandle: input.keyHandle,
      unlockMaterial: input.unlockMaterial,
    })
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) {
      if (existing) this.options.registry.rollbackUpdate(profile, existing)
      else this.options.registry.rollbackRegistration(profile.profileId)
      throw new HostAuthorityError('unavailable')
    }
    try {
      await ensureWorker(profile)
      this.unlock(input.ownerId, profile.profileId)
      return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
    } catch (error) {
      if (existing) this.options.registry.rollbackUpdate(profile, existing)
      else this.options.registry.rollbackRegistration(profile.profileId)
      throw error
    }
  }

  /**
   * Restore a selector-authorized Profile only when its Main vault returns the exact stored key handle.
   * @param input - verified selector facts and opaque vault handle.
   * @returns ready Profile id and current binding generation.
   */
  async restoreProfile(input: {
    readonly profileId: PersonProfileId
    readonly bindingGeneration: number
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly ownerId: string
  }): Promise<{ readonly profileId: PersonProfileId; readonly bindingGeneration: number }> {
    const profile = this.options.registry.resolveProfile(input.profileId)
    if (!profile || profile.kind !== 'account') throw new HostAuthorityError('unauthorized')
    if (profile.bindingGeneration !== input.bindingGeneration) throw new HostAuthorityError('stale')
    if (profile.keyHandle !== input.keyHandle) throw new HostAuthorityError('unauthorized')
    this.options.registry.verifyUnlock(profile, input.keyHandle, input.unlockMaterial)
    const ensureWorker = this.options.ensureProfileWorker
    if (!ensureWorker) throw new HostAuthorityError('unavailable')
    await ensureWorker(profile)
    this.unlock(input.ownerId, profile.profileId)
    return { profileId: profile.profileId, bindingGeneration: profile.bindingGeneration }
  }

  /**
   * Mint a short-lived, generation-fenced lease retained by Desktop Main.
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
    if (!profile || !this.ownerUnlocks.get(input.ownerId)?.has(profile.profileId)) {
      throw new HostAuthorityError('profile_locked')
    }
    for (const [viewLeaseId, lease] of this.leases) {
      if (lease.ownerId === input.ownerId && lease.profileId === profile.profileId && lease.expiresAt > this.options.clock.now()
        && this.generations.get(profile.profileId) === lease.generation) {
        lease.activationHandle ??= activationHandle()
        return {
          profileId: profile.profileId,
          viewLeaseId,
          viewActivationHandle: lease.activationHandle,
          leaseGeneration: lease.generation,
          expiresAt: lease.expiresAt,
          runtimeGeneration: this.options.runtimeGeneration,
        }
      }
    }
    const generation = (this.generations.get(profile.profileId) ?? 0) + 1
    this.generations.set(profile.profileId, generation)
    const viewLeaseId = randomUUID() as ProfileViewLeaseId
    const expiresAt = this.options.clock.now() + (this.options.viewLeaseTtlMs ?? 60_000)
    const viewActivationHandle = activationHandle()
    this.leases.set(viewLeaseId, {
      profileId: profile.profileId, generation, expiresAt, ownerId: input.ownerId, activationHandle: viewActivationHandle,
    })
    return {
      profileId: profile.profileId,
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
    if (!profile || profile.kind !== 'account' || profile.bindingGeneration !== input.bindingGeneration
      || !this.ownerUnlocks.get(input.ownerId)?.has(profile.profileId)) {
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
    this.ownerUnlocks.delete(ownerId)
  }

  /**
   * Revoke every view lease before an active persistence generation changes.
   * @param profileId - Profile whose leases must be revoked.
   */
  revokeProfile(profileId: PersonProfileId): void {
    for (const [leaseId, lease] of this.leases) if (lease.profileId === profileId) this.leases.delete(leaseId)
  }

  private unlock(ownerId: string, profileId: PersonProfileId): void {
    const profiles = this.ownerUnlocks.get(ownerId) ?? new Set<PersonProfileId>()
    profiles.add(profileId)
    this.ownerUnlocks.set(ownerId, profiles)
  }
}
