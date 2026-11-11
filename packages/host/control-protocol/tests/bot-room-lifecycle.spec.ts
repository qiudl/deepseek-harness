import { describe, expect, it } from 'vitest'
import { parseHostBotRoomCreateRequest, parseHostBotRoomCreateReceipt,
  parseHostBotRoomDeleteRequest, parseHostBotRoomDeleteReceipt } from '../src/bot-room-lifecycle.ts'

const create = { ownerBotId: 'main', sessionId: 'chat-1', expectedRevision: 7,
  members: ['main', 'design'], name: 'Planning', notice: 'Review', replyMode: 'admin', adminBotId: 'main' }
const details = { roomId: 'room-1', revision: 8, displayName: 'Planning', notice: 'Review',
  replyMode: 'admin', relayLimit: null, permissionPreset: null, permissionChoices: null,
  adminBotId: 'main', members: [{ botId: 'main', displayName: 'Main' },
    { botId: 'design', displayName: 'Design' }] }
const remove = { roomId: 'room-1', expectedRevision: 8 }

describe('fixed Bot room lifecycle protocol', () => {
  it('accepts exact create and saved details, rejects scope and substituted members', () => {
    const request = parseHostBotRoomCreateRequest(create)
    expect(parseHostBotRoomCreateReceipt({ state: 'created', revision: 8, details }, request))
      .toEqual({ state: 'created', revision: 8, details })
    expect(parseHostBotRoomCreateReceipt({ state: 'stale', revision: 9, details: null }, request))
      .toEqual({ state: 'stale', revision: 9, details: null })
    for (const patch of [{ accountSubject: 'other' }, { members: ['main', 'main'] },
      { adminBotId: 'outside' }, { name: 'x'.repeat(61) }])
      expect(() => parseHostBotRoomCreateRequest({ ...create, ...patch }))
        .toThrow('invalid_bot_room_create')
    for (const patch of [{ details: { ...details, workDir: '/private' } },
      { details: { ...details, members: [details.members[0]] } },
      { revision: 7 }])
      expect(() => parseHostBotRoomCreateReceipt({ state: 'created', revision: 8, details, ...patch }, request))
        .toThrow('invalid_bot_room_create_receipt')
  })
  it('correlates delete and distinguishes stale from missing', () => {
    const request = parseHostBotRoomDeleteRequest(remove)
    expect(parseHostBotRoomDeleteReceipt({ roomId: 'room-1', state: 'deleted', revision: 9 }, request))
      .toEqual({ roomId: 'room-1', state: 'deleted', revision: 9 })
    expect(parseHostBotRoomDeleteReceipt({ roomId: 'room-1', state: 'missing', revision: 8 }, request)?.state)
      .toBe('missing')
    for (const patch of [{ roomId: 'other' }, { privateState: true }, { revision: 7 }])
      expect(() => parseHostBotRoomDeleteReceipt({ roomId: 'room-1', state: 'deleted', revision: 9, ...patch }, request))
        .toThrow('invalid_bot_room_delete_receipt')
  })
})
