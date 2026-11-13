import { describe, expect, it } from 'vitest'
import { parseHostBotRoomMemory, parseHostBotRoomMemoryRequest } from '../src/bot-room-memory.js'

describe('native group memory projection', () => {
  it('keeps one group identity and stable pagination', () => {
    const request = parseHostBotRoomMemoryRequest({ roomId: 'room-1', cursor: null,
      limit: 2, summarize: true })
    const entry = { scope: 'group', topic: null, text: 'fact', added: null,
      by: null, source: null }
    const page = { roomId: 'room-1', available: true, total: 1, entries: [entry],
      nextCursor: null, sizes: { group: 4 }, limits: { main: 4000 },
      summary: null, fresh: true, summarizing: false, error: null }
    expect(parseHostBotRoomMemory(page, request)).toEqual(page)
    expect(parseHostBotRoomMemory(null, request)).toBeNull()
    expect(parseHostBotRoomMemory({ roomId: 'room-1', available: false }, request))
      .toEqual({ roomId: 'room-1', available: false })
    for (const bad of [{ ...page, roomId: 'other' },
      { ...page, entries: [{ ...entry, scope: 'team' }] },
      { ...page, sizes: { group: 4, team: 0 } },
      { ...page, entries: [{ ...entry, secret: 'private' }] }])
      expect(() => parseHostBotRoomMemory(bad, request)).toThrow()
    for (const bad of [{ roomId: '../room-1', cursor: null, limit: 2, summarize: true },
      { roomId: 'room-1', cursor: null, limit: 21, summarize: true },
      { roomId: 'room-1', cursor: null, limit: 2, summarize: true, profile: 'other' }])
      expect(() => parseHostBotRoomMemoryRequest(bad)).toThrow()
  })
})
