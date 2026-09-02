import { randomUUID } from 'node:crypto'
import type { ContextLeaseId, HostClock } from './types.ts'
import { HostAuthorityError } from './types.ts'

/** Enterprise authority attached to one Profile Session, never the Profile itself. */
export interface ContextLease {
  readonly leaseId: ContextLeaseId
  readonly profileId: string
  readonly sessionId: string
  readonly environmentId: string
  readonly bindingId: string
  readonly membershipEpoch: number
  readonly mappingEpoch: number
  readonly policyEpoch: number
  readonly expiresAt: number
}

/** Session-scoped environment attach/detach authority with per-environment epoch fencing. */
export class ContextLeaseAuthority {
  private readonly leases = new Map<ContextLeaseId, ContextLease>()
  constructor(private readonly clock: HostClock) {}

  /**
   * Attach one environment context without mutating Profile-global state.
   * @param input - complete Session and environment epoch authority.
   * @returns the newly fenced lease.
   */
  attach(input: Omit<ContextLease, 'leaseId'>): ContextLease {
    const epochs = [input.membershipEpoch, input.mappingEpoch, input.policyEpoch]
    if (input.expiresAt <= this.clock.now() || epochs.some(epoch => !Number.isSafeInteger(epoch) || epoch < 0)) {
      throw new HostAuthorityError('invalid_input')
    }
    const lease = { ...input, leaseId: randomUUID() as ContextLeaseId }
    this.leases.set(lease.leaseId, lease)
    return lease
  }

  /**
   * Validate the complete session and environment epoch namespace.
   * @param input - lease identity and current authority epochs.
   * @returns the matching unexpired lease.
   */
  validate(input: Omit<ContextLease, 'bindingId' | 'expiresAt'>): ContextLease {
    const lease = this.leases.get(input.leaseId)
    if (!lease || lease.expiresAt <= this.clock.now()) throw new HostAuthorityError('stale')
    if (lease.profileId !== input.profileId || lease.sessionId !== input.sessionId || lease.environmentId !== input.environmentId) {
      throw new HostAuthorityError('profile_mismatch')
    }
    if (lease.membershipEpoch !== input.membershipEpoch
      || lease.mappingEpoch !== input.mappingEpoch
      || lease.policyEpoch !== input.policyEpoch) {
      throw new HostAuthorityError('stale')
    }
    return lease
  }

  /**
   * Revoke exactly one environment context lease.
   * @param leaseId - opaque lease to remove.
   */
  detach(leaseId: ContextLeaseId): void { this.leases.delete(leaseId) }
}
