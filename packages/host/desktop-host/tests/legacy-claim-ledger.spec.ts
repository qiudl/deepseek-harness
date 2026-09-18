import { describe, expect, it } from 'vitest'
import {
  LegacyClaimLedger, parseLegacyClaimEvent, type LegacyClaimEvent, type LegacyClaimEventStore,
} from '../src/legacy-claim-ledger.ts'

class MemoryStore implements LegacyClaimEventStore {
  readonly events: LegacyClaimEvent[] = []
  fail = false
  read(): readonly LegacyClaimEvent[] { return this.events }
  append(event: LegacyClaimEvent): void {
    if (this.fail) throw new Error('journal_unavailable')
    this.events.push(event)
  }
}

const first = {
  candidateId: 'llm-deepseek:deepseek', profileId: 'profile-a', operationId: 'operation-a',
  sourceDigest: 'a'.repeat(64), targetGeneration: 1,
}

describe('legacy provider claim ledger', () => {
  it('reserves before target work and replays an interrupted claim as pending', () => {
    const store = new MemoryStore()
    const ledger = new LegacyClaimLedger(store, () => 100)
    const reserved = ledger.reserve(first)
    expect(reserved).toMatchObject({ ...first, status: 'pending' })
    expect(store.events).toEqual([{ kind: 'reserved', ...first, at: 100 }])
    expect(ledger.reserve(first)).toEqual(reserved)
    expect(store.events).toHaveLength(1)
    expect(ledger.hasPending('profile-a')).toBe(true)
    expect(ledger.hasPending('profile-b')).toBe(false)
    const restarted = new LegacyClaimLedger(store, () => 101)
    expect(restarted.status(first.candidateId, first.profileId)).toEqual(reserved)
    expect(restarted.hasPending('profile-a')).toBe(true)
    const committed = restarted.commit(first)
    expect(committed.status).toBe('committed')
    expect(restarted.commit(first)).toEqual(committed)
    expect(store.events).toHaveLength(2)
    expect(new LegacyClaimLedger(store, () => 102).hasPending('profile-a')).toBe(false)
  })

  it('keeps another account out and fences changed retries', () => {
    const ledger = new LegacyClaimLedger(new MemoryStore(), () => 100)
    expect(ledger.status(first.candidateId, first.profileId)).toBeNull()
    expect(() => ledger.commit(first)).toThrow(/conflict/u)
    expect(() => { ledger.restore(first) }).toThrow(/conflict/u)
    ledger.reserve(first)
    expect(() => ledger.status(first.candidateId, 'profile-b')).toThrow(/conflict/u)
    expect(() => ledger.reserve({ ...first, profileId: 'profile-b', operationId: 'operation-b' }))
      .toThrow(/conflict/u)
    expect(() => ledger.reserve({ ...first, sourceDigest: 'b'.repeat(64) }))
      .toThrow(/idempotency_conflict/u)
    expect(() => ledger.reserve({ ...first, targetGeneration: 2 }))
      .toThrow(/idempotency_conflict/u)
    expect(() => ledger.reserve({ ...first, operationId: 'operation-b' }))
      .toThrow(/idempotency_conflict/u)
    expect(() => ledger.commit({ ...first, operationId: 'operation-b' })).toThrow(/conflict/u)
    expect(() => { ledger.restore({ ...first, profileId: 'profile-b' }) }).toThrow(/conflict/u)
  })

  it('releases only a pending reservation and never reuses an operation id', () => {
    const store = new MemoryStore()
    const ledger = new LegacyClaimLedger(store, () => 100)
    ledger.reserve(first)
    ledger.restore(first)
    ledger.restore(first)
    expect(ledger.status(first.candidateId, first.profileId)).toBeNull()
    expect(ledger.hasPending(first.profileId)).toBe(false)
    expect(store.events).toHaveLength(2)
    expect(() => ledger.commit(first)).toThrow(/conflict/u)
    expect(() => ledger.reserve(first)).toThrow(/idempotency_conflict/u)
    const next = { ...first, profileId: 'profile-b', operationId: 'operation-b' }
    ledger.reserve(next)
    expect(ledger.status(next.candidateId, next.profileId)?.status).toBe('pending')
    ledger.commit(next)
    expect(() => { ledger.restore(next) }).toThrow(/conflict/u)
    expect(() => ledger.reserve({ ...next, operationId: 'operation-c' })).toThrow(/idempotency_conflict/u)
  })

  it('does not publish a transition when durable append fails', () => {
    const store = new MemoryStore()
    const ledger = new LegacyClaimLedger(store, () => 100)
    store.fail = true
    expect(() => ledger.reserve(first)).toThrow(/journal_unavailable/u)
    expect(ledger.status(first.candidateId, first.profileId)).toBeNull()
    store.fail = false
    ledger.reserve(first)
    store.fail = true
    expect(() => ledger.commit(first)).toThrow(/journal_unavailable/u)
    expect(() => { ledger.restore(first) }).toThrow(/journal_unavailable/u)
    expect(ledger.hasPending(first.profileId)).toBe(true)
  })

  it('rejects inconsistent durable histories before granting worker access', () => {
    const reserved: LegacyClaimEvent = { kind: 'reserved', ...first, at: 100 }
    const committed: LegacyClaimEvent = {
      kind: 'committed', candidateId: first.candidateId, operationId: first.operationId, at: 101,
    }
    for (const events of [
      [committed],
      [reserved, reserved],
      [reserved, { ...committed, operationId: 'other-operation' }],
      [reserved, committed, committed],
    ]) {
      const store = new MemoryStore()
      store.events.push(...events)
      expect(() => new LegacyClaimLedger(store, () => 102)).toThrow(/unavailable/u)
    }
  })

  it('rejects malformed or extra durable fields before replay', () => {
    const reserved = { kind: 'reserved', ...first, at: 100 }
    const committed = { kind: 'committed', candidateId: first.candidateId, operationId: first.operationId, at: 101 }
    expect(parseLegacyClaimEvent(reserved)).toEqual(reserved)
    expect(parseLegacyClaimEvent(committed)).toEqual(committed)
    expect(parseLegacyClaimEvent({ ...committed, kind: 'restored' }).kind).toBe('restored')
    for (const event of [
      null, [], { ...reserved, kind: 'unknown' }, { ...reserved, extra: true },
      { ...reserved, candidateId: '' }, { ...reserved, profileId: 'bad\nprofile' },
      { ...reserved, operationId: 'a'.repeat(513) }, { ...reserved, sourceDigest: 'bad' },
      { ...reserved, targetGeneration: 0 }, { ...reserved, targetGeneration: 1.5 },
      { ...reserved, at: -1 }, { ...committed, extra: true }, { ...committed, candidateId: 3 },
      { ...committed, operationId: '' }, { ...committed, at: -1 },
    ]) {
      expect(() => parseLegacyClaimEvent(event)).toThrow(/unavailable/u)
      const store = new MemoryStore()
      store.events.push(event as LegacyClaimEvent)
      expect(() => new LegacyClaimLedger(store, () => 102)).toThrow(/unavailable/u)
    }
  })

  it('refuses to append invalid reservations and timestamps', () => {
    const store = new MemoryStore()
    const ledger = new LegacyClaimLedger(store, () => -1)
    expect(() => ledger.reserve(first)).toThrow(/unavailable/u)
    expect(store.events).toHaveLength(0)
    expect(() => ledger.reserve({ ...first, candidateId: '' })).toThrow(/unavailable/u)
    expect(store.events).toHaveLength(0)
  })
})
