import { randomBytes, randomUUID } from 'node:crypto'
import type { HostSkillHubClockWitnessCommand, HostSkillHubClockWitnessValue } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

const MAX_ANCHORS = 4096
const TICKET_TTL_NS = 30_000_000_000n
function matchesWitness(previous: HostSkillHubClockWitnessValue | null,
  current: HostSkillHubClockWitnessValue | null, next: HostSkillHubClockWitnessValue): boolean {
  return (current === null) === (previous === null)
    && (!current || !previous || (current.revision === previous.revision && current.digest === previous.digest))
    && next.revision === (previous ? BigInt(previous.revision) + 1n : 0n).toString()
}
/** Epoch-bound Host-issued witnesses for the opt-in V2 clock protocol.
 * The V1 ledger remains independent and fail-closed for older callers.
 */
export class SkillHubClockWitnessTickets {
  private epoch = randomBytes(32).toString('base64url')
  private readonly values = new Map<string, HostSkillHubClockWitnessValue>()
  private readonly pending = new Map<string, { ticket: string; expiresAt: bigint; purpose: 'asset' | 'work' }>()
  private readonly assetWitnesses = new Set<string>()
  private readonly workHolds = new Map<string, bigint>()

  constructor(private readonly monotonicNow: () => bigint = () => process.hrtime.bigint()) {}

  currentEpoch(): string { return this.epoch }

  issue(scope: string, purpose: 'asset' | 'work', activeAssetAnchorId?: string): {
    anchorId: string
    ticket: string
    epoch: string
  } {
    const now = this.monotonicNow()
    if (this.workHolds.size >= MAX_ANCHORS) {
      for (const [key, expiresAt] of this.workHolds) {
        if (expiresAt <= now) this.workHolds.delete(key)
      }
      if (this.workHolds.size >= MAX_ANCHORS) throw new HostAuthorityError('busy')
    }
    if (this.values.size >= MAX_ANCHORS) {
      for (const [key, expiresAt] of this.workHolds) if (expiresAt <= now) this.workHolds.delete(key)
      if (this.workHolds.size) throw new HostAuthorityError('busy')
      const assetKey = activeAssetAnchorId && JSON.stringify([scope, activeAssetAnchorId])
      if (purpose === 'work' && (!assetKey || !this.assetWitnesses.has(assetKey)))
        throw new HostAuthorityError('unavailable')
      const retained = assetKey ? this.values.get(assetKey) : undefined
      this.epoch = randomBytes(32).toString('base64url')
      this.values.clear()
      this.pending.clear()
      this.workHolds.clear()
      this.assetWitnesses.clear()
      if (purpose === 'work' && assetKey && retained) {
        this.values.set(assetKey, retained)
        this.assetWitnesses.add(assetKey)
      }
    }
    if (this.pending.size >= MAX_ANCHORS) {
      for (const [key, value] of this.pending) {
        if (value.expiresAt <= now) this.pending.delete(key)
      }
      if (this.pending.size >= MAX_ANCHORS) throw new HostAuthorityError('busy')
    }
    const anchorId = randomUUID(), ticket = randomBytes(32).toString('base64url')
    const key = JSON.stringify([scope, anchorId])
    this.pending.set(key, { ticket, expiresAt: now + TICKET_TTL_NS, purpose })
    // The original Work permit expires within 30 seconds of Server issuance,
    // which precedes this issue. Never rotate while that Work may still start.
    if (purpose === 'work') this.workHolds.set(key, now + TICKET_TTL_NS)
    return { anchorId, ticket, epoch: this.epoch }
  }

  apply(scope: string, anchorId: string, epoch: string,
    command: HostSkillHubClockWitnessCommand, ticket?: string): {
    value: HostSkillHubClockWitnessValue | null
    applied: boolean | null
  } {
    if (epoch !== this.epoch) throw new HostAuthorityError('stale')
    const key = JSON.stringify([scope, anchorId]), current = this.values.get(key) ?? null
    if (command.kind === 'read') return { value: current && { ...current }, applied: null }
    const previous = command.previous
    if (!matchesWitness(previous, current, command.next))
      return { value: current && { ...current }, applied: false }
    if (!current) {
      const issued = this.pending.get(key)
      if (!issued || issued.ticket !== ticket || issued.expiresAt <= this.monotonicNow())
        throw new HostAuthorityError('stale')
      this.pending.delete(key)
      if (issued.purpose === 'asset') this.assetWitnesses.add(key)
    }
    this.values.set(key, { ...command.next })
    return { value: { ...command.next }, applied: true }
  }
}

/** Independent Host-lifetime checkpoint witnesses; disconnect never removes an anchor. */
export class SkillHubClockWitnesses {
  private readonly values = new Map<string, HostSkillHubClockWitnessValue>()

  /** Read or advance a witness under the caller's already verified Profile scope.
   * @param scope - Current Profile, binding generation and installation key.
   * @param anchorId - Online-issued anchor UUID.
   * @param command - Exact revision CAS or read.
   * @returns Current value and null for a read, or the CAS verdict.
   */
  apply(scope: string, anchorId: string, command: HostSkillHubClockWitnessCommand): {
    value: HostSkillHubClockWitnessValue | null
    applied: boolean | null
  } {
    const key = JSON.stringify([scope, anchorId]), current = this.values.get(key) ?? null
    if (command.kind === 'read') return { value: current && { ...current }, applied: null }
    const previous = command.previous
    if (!matchesWitness(previous, current, command.next))
      return { value: current && { ...current }, applied: false }
    // Capacity is a security bound. Eviction could turn a previous anchor into a new one.
    if (!current && this.values.size >= 4096) throw new HostAuthorityError('busy')
    this.values.set(key, { ...command.next })
    return { value: { ...command.next }, applied: true }
  }
}
