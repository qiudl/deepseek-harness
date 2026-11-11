import { describe, expect, it } from 'vitest'
import { parseHostBotRoomHistory, parseHostBotRoomHistoryRequest } from '../src/bot-room-history.ts'

describe('bounded owner Bot room history', () => {
  it('accepts an exact retained page with author identities and cursor', () => {
    const request = parseHostBotRoomHistoryRequest({ roomId: 'room-1', afterSeq: 0, limit: 2 })
    expect(parseHostBotRoomHistory({ roomId: 'room-1', revision: 7, oldestSeq: 2, latestSeq: 5,
      truncatedBefore: true, messages: [
        { seq: 2, authorKind: 'user', authorName: 'User', authorRef: null,
          kind: null, text: 'hello', time: null },
        { seq: 3, authorKind: 'bot', authorName: 'Design', authorRef: 'design',
          kind: null, text: 'plan', time: 123 },
      ], nextCursor: 3 }, request)?.messages).toHaveLength(2)
  })

  it('rejects caller-selected scope and malformed author or retained window', () => {
    expect(() => parseHostBotRoomHistoryRequest({ roomId: 'room-1', afterSeq: 0,
      limit: 2, profileId: 'other' })).toThrow('invalid_bot_room_history_request')
    expect(() => parseHostBotRoomHistoryRequest({ roomId: '../other', afterSeq: 0,
      limit: 2 })).toThrow('invalid_bot_room_history_request')
    const request = parseHostBotRoomHistoryRequest({ roomId: 'room-1', afterSeq: 0, limit: 1 })
    const page = { roomId: 'room-1', revision: 7, oldestSeq: 1, latestSeq: 1,
      truncatedBefore: false, messages: [{ seq: 1, authorKind: 'bot', authorName: 'Design',
        authorRef: null, kind: null, text: 'plan', time: null }], nextCursor: null }
    expect(() => parseHostBotRoomHistory(page, request)).toThrow('invalid_bot_room_history_result')
    expect(() => parseHostBotRoomHistory({ ...page, messages: [], truncatedBefore: true }, request))
      .toThrow('invalid_bot_room_history_result')
  })
})
