import type { HostClock } from './types.ts'
import { HostAuthorityError } from './types.ts'

interface ApprovalRequest {
  readonly approvalId: string
  readonly profileId: string
  readonly payloadHash: string
  readonly decisionVersion: number
  readonly windowGeneration: number
  readonly expiresAt: number
}
interface ApprovalDecision { readonly decision: 'allow' | 'deny'; readonly decisionVersion: number }

/** In-process approval CAS; the Host control journal persists caller-visible commands separately. */
export class ApprovalAuthority {
  private readonly requests = new Map<string, ApprovalRequest & { decision?: ApprovalDecision }>()
  constructor(private readonly clock: HostClock) {}

  /**
   * Register one immutable approval payload.
   * @param input - payload hash, decision generation, window generation, and expiry.
   */
  request(input: ApprovalRequest): void {
    if (!/^[0-9a-f]{64}$/.test(input.payloadHash) || input.expiresAt <= this.clock.now() || this.requests.has(input.approvalId)) {
      throw new HostAuthorityError('invalid_input')
    }
    this.requests.set(input.approvalId, input)
  }

  /**
   * Commit one decision only against the exact payload, version, generation, and live window.
   * @param input - approval identity plus expected CAS fields and decision.
   * @returns committed decision and its incremented version.
   */
  decide(input: { readonly approvalId: string; readonly payloadHash: string; readonly expectedDecisionVersion: number; readonly windowGeneration: number; readonly decision: 'allow' | 'deny' }): ApprovalDecision {
    const request = this.requests.get(input.approvalId)
    if (!request) throw new HostAuthorityError('stale')
    if (request.payloadHash !== input.payloadHash) throw new HostAuthorityError('profile_mismatch')
    if (request.expiresAt <= this.clock.now() || request.windowGeneration !== input.windowGeneration) throw new HostAuthorityError('stale')
    if (request.decision || request.decisionVersion !== input.expectedDecisionVersion) throw new HostAuthorityError('replayed')
    const decision = { decision: input.decision, decisionVersion: request.decisionVersion + 1 }
    this.requests.set(input.approvalId, { ...request, decision })
    return decision
  }
}
