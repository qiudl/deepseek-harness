import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const SHA256 = /^[0-9a-f]{64}$/u

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL_CHARACTER.test(value)
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

/** Secret-free facts persisted before and after one legacy provider claim. */
export type LegacyClaimEvent =
  | {
    readonly kind: 'reserved'
    readonly candidateId: string
    readonly profileId: string
    readonly operationId: string
    readonly sourceDigest: string
    readonly targetGeneration: number
    readonly at: number
  }
  | {
    readonly kind: 'committed' | 'restored'
    readonly candidateId: string
    readonly operationId: string
    readonly at: number
  }

/** Reject malformed durable facts before they can influence worker startup or ownership. */
export function parseLegacyClaimEvent(value: unknown): LegacyClaimEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  if (record.kind === 'reserved') {
    if (!exactKeys(record, ['kind', 'candidateId', 'profileId', 'operationId', 'sourceDigest', 'targetGeneration', 'at'])
      || !boundedText(record.candidateId) || !boundedText(record.profileId) || !boundedText(record.operationId)
      || typeof record.sourceDigest !== 'string' || !SHA256.test(record.sourceDigest)
      || !Number.isSafeInteger(record.targetGeneration) || (record.targetGeneration as number) < 1
      || !Number.isSafeInteger(record.at) || (record.at as number) < 0) throw new HostAuthorityError('unavailable')
  } else if (record.kind === 'committed' || record.kind === 'restored') {
    if (!exactKeys(record, ['kind', 'candidateId', 'operationId', 'at'])
      || !boundedText(record.candidateId) || !boundedText(record.operationId)
      || !Number.isSafeInteger(record.at) || (record.at as number) < 0) throw new HostAuthorityError('unavailable')
  } else throw new HostAuthorityError('unavailable')
  return record as LegacyClaimEvent
}

/** Platform file authorities must make each append durable before it returns. */
export interface LegacyClaimEventStore {
  read(): readonly LegacyClaimEvent[]
  append(event: LegacyClaimEvent): void
}

interface ClaimState {
  readonly candidateId: string
  readonly profileId: string
  readonly operationId: string
  readonly sourceDigest: string
  readonly targetGeneration: number
  readonly status: 'pending' | 'committed' | 'restored'
}

/** Durable single-owner claim state; file ownership and target writes belong to platform adapters. */
export class LegacyClaimLedger {
  private readonly claims = new Map<string, ClaimState>()
  private readonly operationIds = new Set<string>()
  private readonly uncertainProfiles = new Set<string>()
  private poisoned = false

  constructor(private readonly store: LegacyClaimEventStore, private readonly now: () => number) {
    for (const event of store.read()) this.apply(parseLegacyClaimEvent(event))
  }

  /** Reserve a provider before any target write; retries must keep the same operation id. */
  reserve(input: Omit<Extract<LegacyClaimEvent, { kind: 'reserved' }>, 'kind' | 'at'>): ClaimState {
    this.assertWritable()
    const existing = this.claims.get(input.candidateId)
    if (existing && existing.status !== 'restored') {
      if (existing.profileId !== input.profileId) throw new HostAuthorityError('conflict')
      if (existing.operationId !== input.operationId || existing.sourceDigest !== input.sourceDigest
        || existing.targetGeneration !== input.targetGeneration) throw new HostAuthorityError('idempotency_conflict')
      return existing
    }
    if (this.operationIds.has(input.operationId)) throw new HostAuthorityError('idempotency_conflict')
    const event: LegacyClaimEvent = { kind: 'reserved', ...input, at: this.now() }
    parseLegacyClaimEvent(event)
    this.append(event, input.profileId)
    this.apply(event)
    return this.claims.get(input.candidateId) as ClaimState
  }

  /** Confirm a verified target write before a Profile worker is allowed to restart. */
  commit(input: { readonly candidateId: string; readonly profileId: string; readonly operationId: string }): ClaimState {
    this.assertWritable()
    const existing = this.requireOwner(input)
    if (existing.status === 'committed') return existing
    if (existing.status !== 'pending') throw new HostAuthorityError('conflict')
    const event: LegacyClaimEvent = {
      kind: 'committed', candidateId: input.candidateId, operationId: input.operationId, at: this.now(),
    }
    parseLegacyClaimEvent(event)
    this.append(event, input.profileId)
    this.apply(event)
    return this.claims.get(input.candidateId) as ClaimState
  }

  /** Record a verified preimage restoration; this makes a later claim possible. */
  restore(input: { readonly candidateId: string; readonly profileId: string; readonly operationId: string }): void {
    this.assertWritable()
    const existing = this.requireOwner(input)
    if (existing.status === 'restored') return
    if (existing.status !== 'pending') throw new HostAuthorityError('conflict')
    const event: LegacyClaimEvent = {
      kind: 'restored', candidateId: input.candidateId, operationId: input.operationId, at: this.now(),
    }
    parseLegacyClaimEvent(event)
    this.append(event, input.profileId)
    this.apply(event)
  }

  /** Redacted status scoped to the authenticated Profile; another account receives a conflict. */
  status(candidateId: string, profileId: string): ClaimState | null {
    const state = this.claims.get(candidateId)
    if (!state || state.status === 'restored') return null
    if (state.profileId !== profileId) throw new HostAuthorityError('conflict')
    return state
  }

  /** Pending target writes prohibit worker startup, including after Host restart. */
  hasPending(profileId: string): boolean {
    return this.uncertainProfiles.has(profileId)
      || [...this.claims.values()].some(state => state.profileId === profileId && state.status === 'pending')
  }

  private assertWritable(): void {
    if (this.poisoned) throw new HostAuthorityError('unavailable')
  }

  private append(event: LegacyClaimEvent, profileId: string): void {
    try { this.store.append(event) } catch (error) {
      // An atomic replacement can fail after publication but before its directory sync.
      // Its outcome is unknown until a fresh Host reloads the durable snapshot.
      this.poisoned = true
      this.uncertainProfiles.add(profileId)
      throw error
    }
  }

  private requireOwner(input: { candidateId: string; profileId: string; operationId: string }): ClaimState {
    const state = this.claims.get(input.candidateId)
    if (!state || state.profileId !== input.profileId || state.operationId !== input.operationId) {
      throw new HostAuthorityError('conflict')
    }
    return state
  }

  private apply(event: LegacyClaimEvent): void {
    const current = this.claims.get(event.candidateId)
    if (event.kind === 'reserved') {
      if (this.operationIds.has(event.operationId) || current && current.status !== 'restored') {
        throw new HostAuthorityError('unavailable')
      }
      this.operationIds.add(event.operationId)
      this.claims.set(event.candidateId, { ...event, status: 'pending' })
      return
    }
    if (!current || current.operationId !== event.operationId || current.status !== 'pending') {
      throw new HostAuthorityError('unavailable')
    }
    this.claims.set(event.candidateId, { ...current, status: event.kind })
  }
}
