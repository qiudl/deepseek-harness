import { expect, it } from 'vitest'
import { SkillHubClockWitnesses } from '../src/skillhub-clock-witness.ts'

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
