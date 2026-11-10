import { describe, expect, it } from 'vitest'
import { parseHostBotRoomList, parseHostBotRoomListRequest } from '../src/bot-room-list.ts'

describe('owner Bot room paging', () => {
  const request = parseHostBotRoomListRequest({ afterRoomId: '', limit: 1 })
  const page = { revision: 4, rooms: [{ roomId: 'room-1', displayName: 'Planning',
    botCount: 2, pinned: true, hidden: false }], nextCursor: 'room-1' }

  it('accepts a bounded owner page and correlates its cursor', () => {
    expect(parseHostBotRoomListRequest(request)).toEqual(request)
    expect(parseHostBotRoomList(page, request)).toEqual(page)
    expect(parseHostBotRoomList(null, request)).toBeNull()
  })

  it('rejects caller-selected identity and malformed pages', () => {
    for (const args of [{ ...request, profileId: 'other' }, { ...request, limit: 101 },
      { ...request, afterRoomId: '../other' }, { afterRoomId: '', limit: 0 }])
      expect(() => parseHostBotRoomListRequest(args)).toThrow()
    for (const value of [{ ...page, secret: 'private' }, { ...page, nextCursor: 'other' },
      { ...page, rooms: [{ ...page.rooms[0], roomId: 'other' }] },
      { ...page, rooms: [{ ...page.rooms[0], message: 'private' }] }])
      expect(() => parseHostBotRoomList(value, request)).toThrow()
  })
})
