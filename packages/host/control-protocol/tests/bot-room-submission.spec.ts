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

  it('accepts ordered staged files with optional text and rejects malformed selectors', () => {
    const input = { roomId: 'room-1', submissionId: '11111111-1111-4111-8111-111111111111', text: '',
      files: [{ kind: 'image', receiptId: '22222222-2222-4222-8222-222222222222',
        attachmentId: `sha256:${'a'.repeat(64)}` }] }
    expect(parseHostBotRoomSubmission(input).files).toEqual(input.files)
    for (const files of [[], [input.files[0], input.files[0]],
      [{ ...input.files[0], receiptId: 'bad' }],
      [{ ...input.files[0], attachmentId: '../private' }],
      [{ ...input.files[0], extra: true }], Array(6).fill(input.files[0])])
      expect(() => parseHostBotRoomSubmission({ ...input, files })).toThrow('invalid_bot_room_submission')
  })
})
