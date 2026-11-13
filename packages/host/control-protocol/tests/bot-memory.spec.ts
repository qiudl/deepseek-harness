import { describe, expect, it } from 'vitest'
import { parseHostBotMemory, parseHostBotMemoryRequest } from '../src/bot-memory.ts'

const request = { botId: 'main', cursor: null, limit: 2, summarize: true }
const digest = 'a'.repeat(64)
const entry = { scope: 'own', topic: null, text: 'One fact', added: '2026-11-12',
  by: null, source: 'memory panel' }
const page = { botId: 'main', available: true, total: 3, entries: [entry, { ...entry, text: 'Two facts' }],
  nextCursor: `${digest}:2`, sizes: { own: 42, team: 0 }, limits: { main: 4000 },
  summary: { text: '## Overview\nTwo facts.', at: 1794444000000 },
  fresh: true, summarizing: false, error: null }

describe('native Bot memory page', () => {
  it('validates the exact selector and stable page continuity', () => {
    expect(parseHostBotMemoryRequest(request)).toEqual(request)
    expect(parseHostBotMemory(page, request)).toEqual(page)
    const next = { ...request, cursor: `${digest}:2`, summarize: false }
    expect(parseHostBotMemory({ ...page, entries: [{ ...entry, text: 'Third' }], nextCursor: null }, next))
      .toMatchObject({ total: 3, nextCursor: null })
    expect(parseHostBotMemory({ botId: 'main', available: false }, request))
      .toEqual({ botId: 'main', available: false })
    for (const bad of [{ ...request, botId: '../main' }, { ...request, limit: 21 },
      { ...request, cursor: 'bad' }, { ...request, extra: true }])
      expect(() => parseHostBotMemoryRequest(bad)).toThrow('invalid_bot_memory_request')
  })

  it('rejects forged or discontinuous replies before they reach the mobile client', () => {
    for (const bad of [{ ...page, botId: 'other' },
      { ...page, entries: [{ ...entry, secret: 'private' }] },
      { ...page, entries: [{ ...entry, text: 'x'.repeat(16001) }] },
      { ...page, nextCursor: `${digest}:3` },
      { ...page, total: 2 },
      { ...page, summary: { ...page.summary, at: -1 } }])
      expect(() => parseHostBotMemory(bad, request)).toThrow('invalid_bot_memory_result')
    const next = { ...request, cursor: `${digest}:2` }
    expect(() => parseHostBotMemory({ ...page, entries: [entry],
      nextCursor: `${'b'.repeat(64)}:3` }, next)).toThrow('invalid_bot_memory_result')
  })
})
