/** Retained owner room messages read through the fixed Bot plugin service. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.js'

/** One bounded retained room-log page; no Account or Profile selector. */
export interface HostBotRoomHistoryRequest {
  readonly roomId: HostBotRoomId
  readonly afterSeq: number
  readonly limit: number
}
/** Display-only room lines with actual authorship and a retained-window boundary. */
export interface HostBotRoomHistory {
  readonly roomId: HostBotRoomId
  readonly revision: number
  readonly oldestSeq: number
  readonly latestSeq: number
  readonly truncatedBefore: boolean
  readonly messages: readonly {
    readonly seq: number
    readonly authorKind: 'user' | 'bot' | 'external' | 'system'
    readonly authorName: string
    readonly authorRef: string | null
    readonly kind: string | null
    readonly text: string
    readonly time: number | null
  }[]
  readonly nextCursor: number | null
}

/** Parse exact bounded room-history arguments.
 * @param value - Decoded untrusted carrier arguments.
 * @returns Canonical room-history request.
 */
export function parseHostBotRoomHistoryRequest(value: unknown): HostBotRoomHistoryRequest {
  if (!record(value) || !exact(value, ['roomId', 'afterSeq', 'limit']) || !roomIdValid(value.roomId) ||
    typeof value.afterSeq !== 'number' || !Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0 ||
    typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 20)
    throw Error('invalid_bot_room_history_request')
  return { roomId: value.roomId as HostBotRoomId, afterSeq: value.afterSeq, limit: value.limit }
}

/** Validate a plugin page before it crosses the current Host view lease.
 * @param value - Untrusted plugin result.
 * @param request - Exact request bound to this page.
 * @returns A bounded display-only page or null for an unavailable room.
 */
export function parseHostBotRoomHistory(value: unknown, request: HostBotRoomHistoryRequest): HostBotRoomHistory | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['roomId', 'revision', 'oldestSeq', 'latestSeq', 'truncatedBefore', 'messages', 'nextCursor']) ||
    value.roomId !== request.roomId || typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.oldestSeq !== 'number' || !Number.isSafeInteger(value.oldestSeq) || value.oldestSeq < 1 ||
    typeof value.latestSeq !== 'number' || !Number.isSafeInteger(value.latestSeq) || value.latestSeq < 0 ||
    value.oldestSeq > value.latestSeq + 1 || value.truncatedBefore !== (request.afterSeq < value.oldestSeq - 1) ||
    !Array.isArray(value.messages) || value.messages.length > request.limit ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'number' || !Number.isSafeInteger(value.nextCursor))))
    throw Error('invalid_bot_room_history_result')
  let previous = request.afterSeq
  const messages: HostBotRoomHistory['messages'][number][] = []
  for (const line of value.messages) {
    if (!record(line) || !exact(line, ['seq', 'authorKind', 'authorName', 'authorRef', 'kind', 'text', 'time']) ||
      typeof line.seq !== 'number' || !Number.isSafeInteger(line.seq) || line.seq <= previous ||
      line.seq < value.oldestSeq || line.seq > value.latestSeq ||
      typeof line.authorKind !== 'string' || !['user', 'bot', 'external', 'system'].includes(line.authorKind) ||
      typeof line.authorName !== 'string' || !line.authorName.trim() || Buffer.byteLength(line.authorName, 'utf8') > 512 ||
      (line.authorRef !== null && (typeof line.authorRef !== 'string' || line.authorRef.length < 1 || line.authorRef.length > 256)) ||
      (line.authorKind === 'bot') !== (line.authorRef !== null) ||
      (line.kind !== null && (typeof line.kind !== 'string' || line.kind.length < 1 || line.kind.length > 64)) ||
      typeof line.text !== 'string' || Buffer.byteLength(line.text, 'utf8') > 8192 ||
      (line.time !== null && (typeof line.time !== 'number' || !Number.isSafeInteger(line.time) || line.time < 0)))
      throw Error('invalid_bot_room_history_result')
    messages.push({ seq: line.seq, authorKind: line.authorKind as HostBotRoomHistory['messages'][number]['authorKind'],
      authorName: line.authorName, authorRef: line.authorRef, kind: line.kind, text: line.text, time: line.time })
    previous = line.seq
  }
  if (value.nextCursor !== null && (messages.length === 0 || value.nextCursor !== previous))
    throw Error('invalid_bot_room_history_result')
  return { roomId: request.roomId, revision: value.revision, oldestSeq: value.oldestSeq,
    latestSeq: value.latestSeq, truncatedBefore: value.truncatedBefore, messages,
    nextCursor: value.nextCursor }
}
