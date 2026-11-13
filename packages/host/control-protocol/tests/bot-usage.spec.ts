import { describe, expect, it } from 'vitest'
import { parseHostBotUsage, parseHostBotUsageRequest } from '../src/bot-usage.ts'

const request = { rangeDays: 7 as const, timeZone: 'UTC', cursor: null, limit: 20 }
const page = { rangeDays: 7, timeZone: 'UTC', now: '2026-11-12 10',
  scanning: false, totals: { input: 10, cacheRead: 2, cacheWrite: 1, output: 4, calls: 1 },
  rows: [{ hour: '2026-11-12 09',
    owner: { key: 'main', kind: 'bot', id: 'main', name: 'Writer' },
    model: { key: 'p/m', provider: 'p', model: 'm', name: 'Model' },
    kind: 'chat', input: 10, cacheRead: 2, cacheWrite: 1, output: 4, calls: 1 }],
  nextCursor: null }

describe('native Bot usage', () => {
  it('accepts only a bounded selected range and matching rows', () => {
    expect(parseHostBotUsageRequest(request)).toEqual(request)
    expect(parseHostBotUsage(page, request)).toEqual(page)
    expect(parseHostBotUsage(null, request)).toBeNull()
    expect(() => parseHostBotUsageRequest({ ...request, profileId: 'other' })).toThrow()
    expect(() => parseHostBotUsageRequest({ ...request, timeZone: 'No/SuchZone' })).toThrow()
  })

  it('refuses hidden fields, range drift, bad labels and oversized rows', () => {
    expect(() => parseHostBotUsage({ ...page, secret: 'hidden' }, request)).toThrow()
    expect(() => parseHostBotUsage({ ...page, rangeDays: 90 }, request)).toThrow()
    expect(() => parseHostBotUsage({ ...page, rows: [{ ...page.rows[0], owner: {
      ...page.rows[0]!.owner, secret: 'hidden' } }] }, request)).toThrow()
    expect(() => parseHostBotUsage({ ...page, rows: [{ ...page.rows[0], input: -1 }] }, request))
      .toThrow()
    expect(() => parseHostBotUsage({ ...page, rows: Array(21).fill(page.rows[0]) }, request))
      .toThrow()
  })
})
