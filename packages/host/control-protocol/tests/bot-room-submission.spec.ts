import { describe, expect, it } from 'vitest'
import { parseHostBotRoomReceipt, parseHostBotRoomSubmission } from '../src/bot-room-submission.ts'

describe('fixed owner Bot room submission', () => {
  it('accepts an exact bounded request and correlates a minimal receipt', () => {
    const request = parseHostBotRoomSubmission({ roomId: 'room-1',
      submissionId: '11111111-1111-4111-8111-111111111111', text: '  Plan  ' })
    expect(request.text).toBe('Plan')
    expect(parseHostBotRoomReceipt({ roomId: request.roomId, submissionId: request.submissionId,
      state: 'accepted' }, request)?.state).toBe('accepted')
  })

  it('rejects caller scope, invalid targets and substituted receipts', () => {
    const input = { roomId: 'room-1', submissionId: '11111111-1111-4111-8111-111111111111', text: 'Plan' }
    for (const invalid of [{ ...input, accountSubject: 'other' }, { ...input, roomId: '../private' },
      { ...input, text: ' ' }, { ...input, submissionId: 'bad' }])
      expect(() => parseHostBotRoomSubmission(invalid)).toThrow('invalid_bot_room_submission')
    const request = parseHostBotRoomSubmission(input)
    expect(() => parseHostBotRoomReceipt({ roomId: 'other', submissionId: request.submissionId,
      state: 'accepted' }, request)).toThrow('invalid_bot_room_receipt')
    expect(() => parseHostBotRoomReceipt({ roomId: request.roomId, submissionId: request.submissionId,
      state: 'accepted', text: 'private' }, request)).toThrow('invalid_bot_room_receipt')
  })
})
