/** Original Bot attachment transfer, bound to a visible message and one Profile writer. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** Selector for one original attachment in a Bot chat message. */
export interface HostBotChatAttachmentDownloadOpenRequest {
  readonly botId: string
  readonly sessionId: string
  readonly eventSeq: number
  readonly attachmentId: string
}
/** Selector for one retained original in an owner Bot group line. */
export interface HostBotRoomAttachmentDownloadOpenRequest {
  readonly roomId: string
  readonly lineSeq: number
  readonly attachmentId: string
}
/** Exact selector for a Bot chat event or a retained Bot group line. */
export type HostBotAttachmentDownloadOpenRequest = HostBotChatAttachmentDownloadOpenRequest |
  HostBotRoomAttachmentDownloadOpenRequest

/** Short lived transfer handle. */
export interface HostBotAttachmentDownloadOpen {
  readonly transferId: string
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number | null
}

/** Sequential byte offset for a transfer. */
export interface HostBotAttachmentDownloadReadRequest {
  readonly transferId: string
  readonly offset: number
}

/** One original byte chunk, encoded without changing its contents. */
export interface HostBotAttachmentDownloadChunk extends HostBotAttachmentDownloadReadRequest {
  readonly bytes: number | null
  readonly chunk: string
  readonly hasMore: boolean
}

const MAX_BYTES = 2 * 1024 * 1024 * 1024
const CHUNK_BYTES = 40 * 1024
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
const size = (value: unknown): value is number | null => value === null ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_BYTES)

/** Validate a message-bound open selector.
 * @param value - Untrusted request.
 * @returns Exact selector.
 */
export function parseHostBotAttachmentDownloadOpenRequest(value: unknown): HostBotAttachmentDownloadOpenRequest {
  if (record(value) && exact(value, ['roomId', 'lineSeq', 'attachmentId']) &&
    typeof value.roomId === 'string' && /^[!-~]{1,256}$/u.test(value.roomId) &&
    !value.roomId.includes('/') && !value.roomId.includes('\\') &&
    value.roomId !== '.' && value.roomId !== '..' &&
    typeof value.lineSeq === 'number' && Number.isSafeInteger(value.lineSeq) && value.lineSeq >= 1 &&
    typeof value.attachmentId === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value.attachmentId))
    return { roomId: value.roomId, lineSeq: value.lineSeq, attachmentId: value.attachmentId }
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'eventSeq', 'attachmentId']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    typeof value.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(value.sessionId) ||
    value.sessionId.includes('/') || value.sessionId.includes('\\') ||
    value.sessionId === '.' || value.sessionId === '..' ||
    typeof value.eventSeq !== 'number' || !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 1 ||
    typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId))
    throw Error('invalid_bot_attachment_download_request')
  return { botId: value.botId, sessionId: value.sessionId,
    eventSeq: value.eventSeq, attachmentId: value.attachmentId }
}

/** Validate an issued handle without leaking file contents.
 * @param value - Untrusted plugin result.
 * @param request - Original open selector.
 * @returns Validated handle or null.
 */
export function parseHostBotAttachmentDownloadOpen(value: unknown,
  request: HostBotAttachmentDownloadOpenRequest): HostBotAttachmentDownloadOpen | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['transferId', 'attachmentId', 'name', 'bytes']) ||
    !uuid(value.transferId) || value.attachmentId !== request.attachmentId ||
    typeof value.name !== 'string' || value.name.length === 0 ||
    Buffer.byteLength(value.name, 'utf8') > 512 || value.name.includes('/') || value.name.includes('\\') ||
    value.name === '.' || value.name === '..' ||
    Array.from(value.name).some((char) => { const point = char.codePointAt(0) ?? 0; return point < 32 || point === 127 }) ||
    !size(value.bytes)) throw Error('invalid_bot_attachment_download_result')
  return { transferId: value.transferId, attachmentId: request.attachmentId,
    name: value.name, bytes: value.bytes }
}

/** Validate a sequential read request.
 * @param value - Untrusted request.
 * @returns Exact transfer and byte offset.
 */
export function parseHostBotAttachmentDownloadReadRequest(value: unknown): HostBotAttachmentDownloadReadRequest {
  if (!record(value) || !exact(value, ['transferId', 'offset']) || !uuid(value.transferId) ||
    typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) ||
    value.offset < 0 || value.offset > MAX_BYTES || value.offset % CHUNK_BYTES !== 0)
    throw Error('invalid_bot_attachment_download_request')
  return { transferId: value.transferId, offset: value.offset }
}

/** Validate one bounded original-byte chunk.
 * @param value - Untrusted plugin result.
 * @param request - Original transfer and offset.
 * @returns Correlated chunk or null after revocation.
 */
export function parseHostBotAttachmentDownloadChunk(value: unknown,
  request: HostBotAttachmentDownloadReadRequest): HostBotAttachmentDownloadChunk | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['transferId', 'offset', 'bytes', 'chunk', 'hasMore']) ||
    value.transferId !== request.transferId || value.offset !== request.offset ||
    !size(value.bytes) || typeof value.chunk !== 'string' || value.chunk.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.chunk) ||
    typeof value.hasMore !== 'boolean') throw Error('invalid_bot_attachment_download_result')
  const data = Buffer.from(value.chunk, 'base64')
  if (data.toString('base64') !== value.chunk ||
    data.length > CHUNK_BYTES || (value.hasMore && data.length !== CHUNK_BYTES) ||
    (data.length === 0 && (value.hasMore || request.offset !== 0)) ||
    request.offset + data.length > MAX_BYTES ||
    (value.bytes !== null && (value.hasMore
      ? request.offset + data.length >= value.bytes
      : request.offset + data.length !== value.bytes)))
    throw Error('invalid_bot_attachment_download_result')
  return { transferId: request.transferId, offset: request.offset,
    bytes: value.bytes, chunk: value.chunk, hasMore: value.hasMore }
}
