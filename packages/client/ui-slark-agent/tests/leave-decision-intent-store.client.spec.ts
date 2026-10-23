// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { clearLeaveDecisionIntent, readLeaveDecisionIntent, writeLeaveDecisionIntent }
  from '../src/client/leave-decision-intent-store.ts'

const target = ['workspace', 'original-session', 'group'] as const
const intent = { request_id: '11111111-1111-4111-8111-111111111111',
  member_id: '22222222-2222-4222-8222-222222222222', member_cycle: 1,
  delivery_id: '33333333-3333-4333-8333-333333333333', decision: 'request_stop' as const }
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })

it('keeps one exact decision in the original group until its receipt', () => {
  expect(readLeaveDecisionIntent(...target)).toBeNull()
  expect(writeLeaveDecisionIntent(...target, intent)).toBe(true)
  expect(readLeaveDecisionIntent(...target)).toEqual(intent)
  expect(readLeaveDecisionIntent('other', target[1], target[2])).toBeNull()
  clearLeaveDecisionIntent(...target)
  expect(readLeaveDecisionIntent(...target)).toBeNull()
})

it('rejects malformed saved decisions', () => {
  expect(writeLeaveDecisionIntent(...target, intent)).toBe(true)
  const storageKey = sessionStorage.key(0)!
  for (const value of ['{', 'null', '[]', '1', JSON.stringify({ ...intent, extra: true }),
    JSON.stringify({ ...intent, request_id: 'bad' }), JSON.stringify({ ...intent, member_id: 'bad' }),
    JSON.stringify({ ...intent, member_cycle: 0 }), JSON.stringify({ ...intent, member_cycle: 0.5 }),
    JSON.stringify({ ...intent, delivery_id: 'bad' }), JSON.stringify({ ...intent, decision: 'stopped' })]) {
    sessionStorage.setItem(storageKey, value)
    expect(readLeaveDecisionIntent(...target)).toBeNull()
  }
})

it('keeps a decision unsent when storage refuses persistence', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage denied') })
  expect(writeLeaveDecisionIntent(...target, intent)).toBe(false)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('storage denied') })
  expect(readLeaveDecisionIntent(...target)).toBeNull()
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw Error('storage denied') })
  expect(() => { clearLeaveDecisionIntent(...target) }).not.toThrow()
})
