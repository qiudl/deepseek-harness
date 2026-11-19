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

  it('accepts each owner projection shape and an optional provider label', () => {
    const owner = page.rows[0]!.owner
    const model = page.rows[0]!.model
    const ownerShapes = [
      { key: 'main', kind: 'bot' },
      { key: 'main', kind: 'bot', id: 'main' },
      { key: 'main', kind: 'bot', name: 'Writer' },
      { key: 'main', kind: 'bot', deleted: false },
      { key: 'main', kind: 'bot', id: 'main', name: 'Writer' },
      { key: 'main', kind: 'bot', id: 'main', deleted: true },
      { key: 'main', kind: 'bot', name: 'Writer', deleted: true },
      { ...owner, deleted: true },
    ]
    for (const shape of ownerShapes) {
      const row = { ...page.rows[0], owner: shape, model: { ...model, providerName: 'Provider' } }
      expect(parseHostBotUsage({ ...page, rows: [row] }, request)?.rows).toEqual([row])
    }
    expect(parseHostBotUsageRequest({ rangeDays: 30, timeZone: 'Europe/Belgrade',
      cursor: 'next_page-1', limit: 1 })).toEqual({ rangeDays: 30, timeZone: 'Europe/Belgrade',
      cursor: 'next_page-1', limit: 1 })
    expect(parseHostBotUsage({ ...page, nextCursor: 'next_page-1', scanning: true }, request)?.nextCursor)
      .toBe('next_page-1')
  })

  it('rejects malformed request cursors and untrusted row projections', () => {
    for (const value of [null, {}, { ...request, rangeDays: 14 }, { ...request, limit: 0 },
      { ...request, limit: 41 }, { ...request, cursor: '../other' },
      { ...request, cursor: 'x'.repeat(161) }, { ...request, timeZone: '\n' },
      { ...request, timeZone: 'x'.repeat(65) }])
      expect(() => parseHostBotUsageRequest(value)).toThrow('invalid_bot_usage_request')
    for (const changed of [{ timeZone: 'Europe/Belgrade' }, { now: '2026-11-12 25' },
      { scanning: 1 }, { nextCursor: '../other' }, { totals: { ...page.totals, calls: -1 } },
      { totals: { ...page.totals, secret: 1 } }, { rows: 'bad' }])
      expect(() => parseHostBotUsage({ ...page, ...changed }, request)).toThrow('invalid_bot_usage_result')
    for (const changed of [
      { hour: 'bad' }, { kind: 'x'.repeat(81) }, { output: -1 },
      { owner: null }, { owner: { key: 'main', kind: 'unknown' } },
      { owner: { key: 'main', kind: 'bot', id: 1 } },
      { owner: { key: 'main', kind: 'bot', name: 'x'.repeat(201) } },
      { owner: { key: 'main', kind: 'bot', deleted: 'yes' } },
      { model: null }, { model: { ...page.rows[0]!.model, key: 'x'.repeat(257) } },
      { model: { ...page.rows[0]!.model, providerName: 1 } },
      { model: { ...page.rows[0]!.model, private: 'secret' } },
    ]) expect(() => parseHostBotUsage({ ...page, rows: [{ ...page.rows[0], ...changed }] }, request))
      .toThrow('invalid_bot_usage_result')
    const largeRow = { ...page.rows[0], owner: { key: 'x'.repeat(256), kind: 'bot',
      id: 'x'.repeat(256), name: 'x'.repeat(200) },
    model: { key: 'x'.repeat(256), provider: 'x'.repeat(128), model: 'x'.repeat(128),
      name: 'x'.repeat(200), providerName: 'x'.repeat(200) } }
    expect(() => parseHostBotUsage({ ...page, rows: Array(40).fill(largeRow) },
      { ...request, limit: 40 })).toThrow('invalid_bot_usage_result')
  })
})
