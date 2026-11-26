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

  it('keeps the selected range and a usable cursor across pages', () => {
    for (const rangeDays of [30, 90] as const) {
      const selected = { ...request, rangeDays, cursor: 'previous_page-1' }
      const next = { ...page, rangeDays, scanning: true, nextCursor: 'next_page-2' }
      expect(parseHostBotUsageRequest(selected)).toEqual(selected)
      expect(parseHostBotUsage(next, selected)).toEqual(next)
    }
    for (const cursor of [12, '', 'has a space', 'x'.repeat(161)]) {
      expect(() => parseHostBotUsageRequest({ ...request, cursor })).toThrow('invalid_bot_usage_request')
      expect(() => parseHostBotUsage({ ...page, nextCursor: cursor }, request)).toThrow('invalid_bot_usage_result')
    }
    expect(() => parseHostBotUsageRequest({ ...request, rangeDays: 31 })).toThrow('invalid_bot_usage_request')
  })

  it('preserves every supported optional owner field and the provider label', () => {
    const row = page.rows[0]!
    const owner = { key: row.owner.key, kind: row.owner.kind }
    const model = { ...row.model, providerName: 'Provider' }
    const owners = [
      owner,
      { ...owner, id: 'main' },
      { ...owner, name: 'Writer' },
      { ...owner, deleted: false },
      { ...owner, id: 'main', name: 'Writer' },
      { ...owner, id: 'main', deleted: true },
      { ...owner, name: 'Writer', deleted: true },
      { ...owner, id: 'main', name: 'Writer', deleted: false },
    ]
    for (const value of owners) {
      const result = { ...page, rows: [{ ...row, owner: value, model }] }
      expect(parseHostBotUsage(result, request)).toEqual(result)
    }
    for (const entry of [
      { ...row, owner: { ...owner, deleted: 'false' } },
      { ...row, model: { ...model, providerName: '界'.repeat(67) } },
    ]) {
      expect(() => parseHostBotUsage({ ...page, rows: [entry] }, request)).toThrow('invalid_bot_usage_result')
    }
    expect(() => parseHostBotUsage({ ...page, totals: { ...page.totals, calls: -1 } }, request))
      .toThrow('invalid_bot_usage_result')
  })

  it('limits the UTF-8 page size even when each row and the row count are allowed', () => {
    const row = page.rows[0]!
    const wide = { ...row, owner: { ...row.owner, key: '界'.repeat(85), id: '界'.repeat(85), name: '界'.repeat(66) },
      model: { key: '界'.repeat(85), provider: '界'.repeat(42), model: '界'.repeat(42),
        name: '界'.repeat(66), providerName: '界'.repeat(66) } }
    const selected = { ...request, limit: 40 }
    expect(parseHostBotUsage({ ...page, rows: [wide] }, selected)?.rows).toEqual([wide])
    const oversized = { ...page, rows: Array.from({ length: selected.limit }, () => wide) }
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(32_768)
    expect(() => parseHostBotUsage(oversized, selected)).toThrow('invalid_bot_usage_result')
  })
})
