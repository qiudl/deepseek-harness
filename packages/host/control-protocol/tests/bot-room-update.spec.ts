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
  it('accepts a stop request without a settings revision change', () => {
    const parsed = parseHostBotRoomUpdateRequest({ ...request,
      change: { kind: 'member-stop', value: 'main' } })
    expect(parseHostBotRoomUpdateReceipt({ roomId: 'room-1', revision: 7,
      state: 'applied', details: { ...details, revision: 7 } }, parsed)?.state).toBe('applied')
    expect(() => parseHostBotRoomUpdateReceipt({ roomId: 'room-1', revision: 7,
      state: 'applied', details: { ...details, revision: 7 } },
    parseHostBotRoomUpdateRequest(request))).toThrow('invalid_bot_room_update_receipt')
  })

  it.each([
    { kind: 'name', value: 'Planning' }, { kind: 'notice', value: '' },
    { kind: 'reply-mode', value: 'admin' }, { kind: 'reply-mode', value: 'everyone' },
    { kind: 'relay-limit', value: null }, { kind: 'relay-limit', value: 1 }, { kind: 'relay-limit', value: 200 },
    { kind: 'permission', value: null }, { kind: 'permission', value: 'approve' },
    { kind: 'admin', value: null }, { kind: 'admin', value: 'main' },
    { kind: 'member-add', value: 'delegate_1' }, { kind: 'member-remove', value: 'delegate_1' },
  ])('accepts the bounded $kind edit with value $value', (change) => {
    const next = { ...request, change }
    expect(parseHostBotRoomUpdateRequest(next)).toEqual(next)
  })

  it.each([
    { kind: 'name', value: '  ' }, { kind: 'name', value: '界'.repeat(171) },
    { kind: 'notice', value: 12 }, { kind: 'reply-mode', value: 'anonymous' },
    { kind: 'relay-limit', value: '10' }, { kind: 'relay-limit', value: 0 },
    { kind: 'relay-limit', value: 1.5 }, { kind: 'permission', value: ' ' },
    { kind: 'permission', value: '界'.repeat(67) }, { kind: 'admin', value: 'unknown bot' },
  ])('refuses the invalid $kind edit with value $value', (change) => {
    expect(() => parseHostBotRoomUpdateRequest({ ...request, change })).toThrow('invalid_bot_room_update')
  })

  it('distinguishes an absent plugin from an incomplete or mismatched saved-state receipt', () => {
    const selected = parseHostBotRoomUpdateRequest(request)
    const receipt = { roomId: selected.roomId, revision: 8, state: 'applied' }
    expect(parseHostBotRoomUpdateReceipt(null, selected)).toBeNull()
    for (const savedDetails of [null, { ...details, revision: 9 }]) {
      expect(() => parseHostBotRoomUpdateReceipt({ ...receipt, details: savedDetails }, selected))
        .toThrow('invalid_bot_room_update_receipt')
    }
  })
})
