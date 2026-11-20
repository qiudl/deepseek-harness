import { describe, expect, it } from 'vitest'
import {
  parseHostBotRoomReplyRequest, parseHostBotRoomReplyReceiptRequest, parseHostBotRoomReplyTargetsRequest,
  parseHostBotRoomReplyReceipt, parseHostBotRoomReplyTargets,
} from '../src/bot-room-reply.ts'

describe('owner group replies', () => {
  const room = parseHostBotRoomReplyTargetsRequest({ roomId: 'room-1' })
  const identity = parseHostBotRoomReplyReceiptRequest({
    ...room, requestId: '11111111-1111-4111-8111-111111111111',
  })
  const target = { messageId: 'original', who: 'User', text: 'Original message' }

  it('admits only fixed requests with a bounded target and text', () => {
    const value = { ...identity, text: ' Reply ', replyToMessageId: 'original' }
    expect(parseHostBotRoomReplyRequest(value).text).toBe('Reply')
    for (const candidate of [
      { ...value, owner: 'other' }, { ...value, roomId: '..' }, { ...value, requestId: 'invalid' },
      { ...value, replyToMessageId: 'bad\nline' }, { ...value, text: '界'.repeat(5462) }, { ...value, text: '  ' },
    ]) expect(() => parseHostBotRoomReplyRequest(candidate)).toThrow()
  })

  it('checks target list scope, uniqueness, exact fields and total size', () => {
    expect(parseHostBotRoomReplyTargets({ ...room, targets: [target] }, room)?.targets).toEqual([target])
    for (const value of [
      { roomId: 'other', targets: [target] },
      { ...room, targets: [target, target] },
      { ...room, targets: [{ ...target, privateState: 'hidden' }] },
      { ...room, targets: Array.from({ length: 40 }, (_, i) => ({
        ...target, messageId: String(i).padStart(256, '0'), who: '界'.repeat(160), text: '界'.repeat(160),
      })) },
    ]) expect(() => parseHostBotRoomReplyTargets(value, room)).toThrow()
  })

  it('returns a message ID only for a recorded result of the original request', () => {
    const recorded = { ...identity, state: 'recorded', messageId: 'persisted' }
    expect(parseHostBotRoomReplyReceipt(recorded, identity)).toEqual(recorded)
    expect(parseHostBotRoomReplyReceipt({ ...identity, state: 'pending' }, identity)?.state).toBe('pending')
    for (const value of [
      { ...recorded, roomId: 'other' }, { ...recorded, requestId: 'other' }, { ...recorded, state: 'pending' },
      { ...identity, state: 'recorded' }, { ...recorded, body: 'private' },
    ]) expect(() => parseHostBotRoomReplyReceipt(value, identity)).toThrow()
  })
})
