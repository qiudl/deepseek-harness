/** Owner reply candidates and request receipts for the selected group Session. */
import { roomIdValid, type HostBotRoomId } from './bot-room-list.ts'
import { botRecord as record, botExactKeys as exact } from './bot-value-shape.ts'

export interface HostBotRoomReplyTargetsRequest {
  readonly roomId: HostBotRoomId
}

export interface HostBotRoomReplyReceiptRequest extends HostBotRoomReplyTargetsRequest {
  readonly requestId: string
}

export interface HostBotRoomReplyRequest extends HostBotRoomReplyReceiptRequest {
  readonly replyToMessageId: string
  readonly text: string
}

export interface HostBotRoomReplyTargets extends HostBotRoomReplyTargetsRequest {
  readonly targets: readonly { readonly messageId: string; readonly who: string; readonly text: string }[]
}

export type HostBotRoomReplyReceipt = HostBotRoomReplyReceiptRequest & (
  | { readonly state: 'recorded'; readonly messageId: string }
  | { readonly state: 'pending' | 'unobserved' | 'stale' | 'conflict' | 'full' }
)

function requestIdValid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function messageIdValid(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Buffer.byteLength(value, 'utf8') <= 256 &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

/** Decode a target list request bound to a room. */
export function parseHostBotRoomReplyTargetsRequest(value: unknown): HostBotRoomReplyTargetsRequest {
  if (!record(value) || !exact(value, ['roomId']) || !roomIdValid(value.roomId))
    throw Error('invalid_bot_room_reply')
  return { roomId: value.roomId as HostBotRoomId }
}

/** Decode a read-only request for the previous result. */
export function parseHostBotRoomReplyReceiptRequest(value: unknown): HostBotRoomReplyReceiptRequest {
  if (!record(value) || !exact(value, ['roomId', 'requestId']) ||
      !roomIdValid(value.roomId) || !requestIdValid(value.requestId)) throw Error('invalid_bot_room_reply')
  return { roomId: value.roomId as HostBotRoomId, requestId: value.requestId }
}

/** Check the exact target and text before admission to the room worker. */
export function parseHostBotRoomReplyRequest(value: unknown): HostBotRoomReplyRequest {
  if (!record(value) || !exact(value, ['roomId', 'requestId', 'replyToMessageId', 'text']) ||
      !roomIdValid(value.roomId) || !requestIdValid(value.requestId) || !messageIdValid(value.replyToMessageId) ||
      typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > 16_384 || !value.text.trim())
    throw Error('invalid_bot_room_reply')
  return { roomId: value.roomId as HostBotRoomId, requestId: value.requestId,
    replyToMessageId: value.replyToMessageId, text: value.text.trim() }
}

/** Check that a bounded list belongs to the requested room before returning it. */
export function parseHostBotRoomReplyTargets(value: unknown, request: HostBotRoomReplyTargetsRequest): HostBotRoomReplyTargets | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['roomId', 'targets']) || value.roomId !== request.roomId ||
      !Array.isArray(value.targets) || value.targets.length > 40)
    throw Error('invalid_bot_room_reply_targets')
  const seen = new Set<string>()
  const targets = value.targets.map((entry: unknown) => {
    if (!record(entry) || !exact(entry, ['messageId', 'who', 'text']) || !messageIdValid(entry.messageId) ||
        seen.has(entry.messageId) || typeof entry.who !== 'string' || entry.who.length > 160 ||
        typeof entry.text !== 'string' || entry.text.length > 160)
      throw Error('invalid_bot_room_reply_targets')
    seen.add(entry.messageId)
    return { messageId: entry.messageId, who: entry.who, text: entry.text }
  })
  const result = { roomId: request.roomId, targets }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32_768) throw Error('invalid_bot_room_reply_targets')
  return result
}

/** A recorded reply alone may carry a message ID. Pending requests must only be queried. */
export function parseHostBotRoomReplyReceipt(value: unknown, request: HostBotRoomReplyReceiptRequest): HostBotRoomReplyReceipt | null {
  if (value === null) return null
  if (!record(value) || value.roomId !== request.roomId || value.requestId !== request.requestId)
    throw Error('invalid_bot_room_reply_receipt')
  const identity = { roomId: request.roomId, requestId: request.requestId }
  if (value.state === 'recorded' && exact(value, ['roomId', 'requestId', 'state', 'messageId']) &&
      messageIdValid(value.messageId)) return { ...identity, state: value.state, messageId: value.messageId }
  if (exact(value, ['roomId', 'requestId', 'state']) &&
      (value.state === 'pending' || value.state === 'unobserved' || value.state === 'stale' ||
        value.state === 'conflict' || value.state === 'full')) return { ...identity, state: value.state }
  throw Error('invalid_bot_room_reply_receipt')
}
