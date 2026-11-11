import { describe, expect, it } from 'vitest'
import { parseHostBotRoomUpdateRequest, parseHostBotRoomUpdateReceipt } from '../src/bot-room-update.ts'

const request = { roomId: 'room-1', expectedRevision: 7, change: { kind: 'notice', value: 'Review' } }
const details = { roomId: 'room-1', revision: 8, displayName: 'Planning', notice: 'Review',
  replyMode: 'admin', relayLimit: null, permissionPreset: null, permissionChoices: null, adminBotId: 'main',
  members: [{ botId: 'main', displayName: 'Main' }] }

describe('fixed owner Bot room update contract', () => {
  it('accepts one exact edit and correlates a saved-state result', () => {
    const parsed = parseHostBotRoomUpdateRequest(request)
    expect(parsed).toEqual(request)
    expect(parseHostBotRoomUpdateReceipt({ roomId: 'room-1', revision: 8,
      state: 'applied', details }, parsed)).toEqual({ roomId: 'room-1', revision: 8,
      state: 'applied', details })
    expect(parseHostBotRoomUpdateReceipt({ roomId: 'room-1', revision: 9,
      state: 'stale', details: null }, parsed)).toEqual({ roomId: 'room-1', revision: 9,
      state: 'stale', details: null })
  })
  it('rejects caller authority, hidden patch fields and forged receipts', () => {
    for (const patch of [{ profileId: 'other' }, { roomId: '../other' },
      { change: { kind: 'notice', value: 'ok', workDir: '/private' } },
      { change: { kind: 'member-add', value: '../other' } },
      { change: { kind: 'relay-limit', value: 201 } }])
      expect(() => parseHostBotRoomUpdateRequest({ ...request, ...patch })).toThrow('invalid_bot_room_update')
    const parsed = parseHostBotRoomUpdateRequest(request)
    for (const patch of [{ roomId: 'other' }, { revision: 7 },
      { details: { ...details, workDir: '/private' } }, { state: 'stale' }])
      expect(() => parseHostBotRoomUpdateReceipt({ roomId: 'room-1', revision: 8,
        state: 'applied', details, ...patch }, parsed)).toThrow('invalid_bot_room_update_receipt')
  })
})
