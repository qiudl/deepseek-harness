import { expect, it } from 'vitest'
import { SkillHubClockWitnesses, SkillHubClockWitnessTickets } from '../src/skillhub-clock-witness.ts'

it('requires exact monotonic CAS and isolates Profile scopes without persisting restart authority', () => {
  const witness = new SkillHubClockWitnesses(), zero = { revision: '0', digest: 'a'.repeat(64) }
  const cas = (previous: typeof zero | null, next = zero) =>
    witness.apply('profile', 'anchor', { kind: 'compare_and_set', previous, next })
  expect(cas(null, { ...zero, revision: '1' }).applied).toBe(false)
  expect(cas(zero).applied).toBe(false)
  expect(cas(null).applied).toBe(true)
  expect(cas(null).applied).toBe(false)
  expect(cas({ ...zero, digest: 'b'.repeat(64) }, { ...zero, revision: '1' }).applied).toBe(false)
  expect(cas({ ...zero, revision: '1' }, { ...zero, revision: '2' }).applied).toBe(false)
  expect(witness.apply('other-profile', 'anchor', { kind: 'read' }).value).toBeNull()
  const read = witness.apply('profile', 'anchor', { kind: 'read' })
  expect(read.value).toEqual(zero)
  expect(new SkillHubClockWitnesses().apply('profile', 'anchor', { kind: 'read' }).value).toBeNull()
  expect(cas(zero, { ...zero, revision: '1' }).applied).toBe(true)
})

it('refuses new anchors at capacity without evicting or preventing updates to existing witnesses', () => {
  const witness = new SkillHubClockWitnesses(), zero = { revision: '0', digest: 'a'.repeat(64) }
  for (let i = 0; i < 4096; i++) expect(witness.apply('profile', String(i), {
    kind: 'compare_and_set', previous: null, next: zero,
  }).applied).toBe(true)
  expect(() => witness.apply('profile', 'overflow', { kind: 'compare_and_set', previous: null, next: zero }))
    .toThrow('busy')
  expect(witness.apply('profile', '0', { kind: 'read' }).value).toEqual(zero)
  expect(witness.apply('profile', '0', { kind: 'compare_and_set', previous: zero,
    next: { ...zero, revision: '1' } }).applied).toBe(true)
})

it('T24860 rotates after 4096 issued anchors without accepting old anchor replay', () => {
  const witness = new SkillHubClockWitnessTickets(), zero = { revision: '0', digest: 'a'.repeat(64) }
  const first = witness.issue('profile', 'asset')
  expect(witness.apply('profile', first.anchorId, first.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, first.ticket).applied).toBe(true)
  for (let i = 1; i < 4096; i++) {
    const issued = witness.issue('profile', 'asset')
    expect(witness.apply('profile', issued.anchorId, issued.epoch,
      { kind: 'compare_and_set', previous: null, next: zero }, issued.ticket).applied).toBe(true)
  }
  const next = witness.issue('profile', 'asset')
  expect(next.epoch).not.toBe(first.epoch)
  expect(() => witness.apply('profile', first.anchorId, first.epoch, { kind: 'read' }))
    .toThrow('stale')
  expect(() => witness.apply('profile', first.anchorId, next.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, first.ticket)).toThrow('stale')
  expect(() => witness.apply('profile', first.anchorId, next.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, next.ticket)).toThrow('stale')
  expect(witness.apply('profile', next.anchorId, next.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, next.ticket).applied).toBe(true)
})

it('T24860 binds one pending ticket to scope, anchor, epoch and a monotonic deadline', () => {
  let now = 0n
  const witness = new SkillHubClockWitnessTickets(() => now)
  const zero = { revision: '0', digest: 'a'.repeat(64) }
  const issued = witness.issue('profile', 'asset')
  const cas = (scope: string, anchorId: string, ticket: string) => witness.apply(scope, anchorId,
    issued.epoch, { kind: 'compare_and_set', previous: null, next: zero }, ticket)
  expect(() => cas('other', issued.anchorId, issued.ticket)).toThrow('stale')
  expect(() => cas('profile', issued.anchorId, 'wrong')).toThrow('stale')
  expect(() => cas('profile', 'other-anchor', issued.ticket)).toThrow('stale')
  expect(cas('profile', issued.anchorId, issued.ticket).applied).toBe(true)
  expect(cas('profile', issued.anchorId, issued.ticket).applied).toBe(false)
  const expired = witness.issue('profile', 'asset')
  now = 30_000_000_000n
  expect(() => witness.apply('profile', expired.anchorId, expired.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, expired.ticket)).toThrow('stale')
})

it('T24860 bounds pending tickets and reclaims expired issuance without changing epoch', () => {
  let now = 0n
  const witness = new SkillHubClockWitnessTickets(() => now)
  const first = witness.issue('profile', 'asset')
  for (let i = 1; i < 4096; i++) witness.issue('profile', 'asset')
  expect(() => witness.issue('profile', 'asset')).toThrow('busy')
  expect(witness.currentEpoch()).toBe(first.epoch)
  now = 30_000_000_000n
  const next = witness.issue('profile', 'asset')
  expect(next.epoch).toBe(first.epoch)
  expect(() => witness.apply('profile', first.anchorId, first.epoch,
    { kind: 'compare_and_set', previous: null,
      next: { revision: '0', digest: 'a'.repeat(64) } }, first.ticket)).toThrow('stale')
})

it('T24860 refuses capacity rotation during the original Work window', () => {
  let now = 0n
  const witness = new SkillHubClockWitnessTickets(() => now)
  const zero = { revision: '0', digest: 'a'.repeat(64) }
  const work = witness.issue('profile', 'work')
  expect(witness.apply('profile', work.anchorId, work.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, work.ticket).applied).toBe(true)
  for (let i = 1; i < 4096; i++) {
    const issued = witness.issue('profile', 'asset')
    expect(witness.apply('profile', issued.anchorId, issued.epoch,
      { kind: 'compare_and_set', previous: null, next: zero }, issued.ticket).applied).toBe(true)
  }
  expect(() => witness.issue('profile', 'asset')).toThrow('busy')
  expect(witness.currentEpoch()).toBe(work.epoch)
  expect(witness.apply('profile', work.anchorId, work.epoch, { kind: 'read' }).value).toEqual(zero)
  now = 30_000_000_000n
  const next = witness.issue('profile', 'asset')
  expect(next.epoch).not.toBe(work.epoch)
  expect(() => witness.apply('profile', work.anchorId, work.epoch, { kind: 'read' })).toThrow('stale')
})

it('T24860 bounds outstanding Work holds and reclaims expired holds', () => {
  let now = 0n
  const witness = new SkillHubClockWitnessTickets(() => now)
  for (let i = 0; i < 4096; i++) witness.issue('profile', 'work')
  expect(() => witness.issue('profile', 'asset')).toThrow('busy')
  now = 30_000_000_000n
  expect(witness.issue('profile', 'asset').epoch).toBe(witness.currentEpoch())
})

it('T24894 preserves only the selected asset witness when Work issue rotates capacity', () => {
  let now = 0n
  const witness = new SkillHubClockWitnessTickets(() => now)
  const zero = { revision: '0', digest: 'a'.repeat(64) }
  const selected = witness.issue('profile', 'asset')
  expect(witness.apply('profile', selected.anchorId, selected.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, selected.ticket).applied).toBe(true)
  const oldWork = witness.issue('profile', 'work')
  expect(witness.apply('profile', oldWork.anchorId, oldWork.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, oldWork.ticket).applied).toBe(true)
  // No live Work may be displaced; advance beyond its original permit window.
  now = 30_000_000_000n
  let anotherAsset = ''
  for (let i = 2; i < 4096; i++) {
    const issued = witness.issue('profile', 'asset')
    if (i === 2) anotherAsset = issued.anchorId
    expect(witness.apply('profile', issued.anchorId, issued.epoch,
      { kind: 'compare_and_set', previous: null, next: zero }, issued.ticket).applied).toBe(true)
  }
  expect(() => witness.issue('profile', 'work', oldWork.anchorId)).toThrow('unavailable')
  expect(() => witness.issue('profile', 'work')).toThrow('unavailable')
  expect(() => witness.issue('other-profile', 'work', selected.anchorId)).toThrow('unavailable')
  const next = witness.issue('profile', 'work', selected.anchorId)
  expect(next.epoch).not.toBe(selected.epoch)
  expect(witness.apply('profile', selected.anchorId, next.epoch, { kind: 'read' }).value).toEqual(zero)
  const advanced = { revision: '1', digest: 'b'.repeat(64) }
  expect(witness.apply('profile', selected.anchorId, next.epoch,
    { kind: 'compare_and_set', previous: zero, next: advanced }).value).toEqual(advanced)
  expect(witness.apply('profile', anotherAsset, next.epoch, { kind: 'read' }).value).toBeNull()
  expect(witness.apply('profile', oldWork.anchorId, next.epoch, { kind: 'read' }).value).toBeNull()
  expect(() => witness.apply('profile', selected.anchorId, selected.epoch, { kind: 'read' })).toThrow('stale')
  expect(witness.apply('profile', next.anchorId, next.epoch,
    { kind: 'compare_and_set', previous: null, next: zero }, next.ticket).applied).toBe(true)
})
