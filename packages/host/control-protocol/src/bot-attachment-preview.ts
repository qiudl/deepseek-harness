/** Bounded text or image preview tied to one visible Bot chat attachment block. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

export interface HostBotAttachmentPreviewRequest {
  readonly botId: string
  readonly sessionId: string
  readonly eventSeq: number
  readonly attachmentId: string
  readonly offset: number
}

export interface HostBotAttachmentPreviewChunk extends HostBotAttachmentPreviewRequest {
  readonly name: string
  readonly total: number
  readonly sha256: string
  readonly chunk: string
  readonly hasMore: boolean
  readonly whole: boolean
}

const CHUNK = 8_000
const session = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !value.includes('/') && !value.includes('\\') &&
  value !== '.' && value !== '..'

/** Parse an exact selector supplied by a remote native client. */
export function parseHostBotAttachmentPreviewRequest(value: unknown): HostBotAttachmentPreviewRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'eventSeq', 'attachmentId', 'offset']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    !session(value.sessionId) || typeof value.eventSeq !== 'number' ||
    !Number.isSafeInteger(value.eventSeq) || value.eventSeq < 1 ||
    typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId) ||
    typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) ||
    value.offset < 0 || value.offset > 200_000 || value.offset % CHUNK !== 0)
    throw Error('invalid_bot_attachment_preview_request')
  return { botId: value.botId, sessionId: value.sessionId, eventSeq: value.eventSeq,
    attachmentId: value.attachmentId, offset: value.offset }
}

/** Validate a Host reply against the exact selector before forwarding it. */
export function parseHostBotAttachmentPreview(value: unknown,
  request: HostBotAttachmentPreviewRequest): HostBotAttachmentPreviewChunk | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'eventSeq', 'attachmentId', 'offset',
    'name', 'total', 'sha256', 'chunk', 'hasMore', 'whole']) ||
    value.botId !== request.botId || value.sessionId !== request.sessionId ||
    value.eventSeq !== request.eventSeq || value.attachmentId !== request.attachmentId ||
    value.offset !== request.offset || typeof value.name !== 'string' ||
    value.name.length < 1 || Buffer.byteLength(value.name, 'utf8') > 512 ||
    Array.from(value.name).some((char) => { const point = char.codePointAt(0) ?? 0; return point < 32 || point === 127 }) ||
    !(value.name === 'image' || /\.(?:txt|md|json|csv|log|ya?ml|xml|svg|html?|css|[cm]?js|tsx?|py|go|sh|png|jpe?g|webp|gif)$/iu.test(value.name)) ||
    typeof value.total !== 'number' || !Number.isSafeInteger(value.total) ||
    value.total < 0 || value.total > 200_000 || (request.offset >= value.total && request.offset !== 0) ||
    typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    typeof value.chunk !== 'string' || Array.from(value.chunk).length !== Math.min(CHUNK, value.total - request.offset) ||
    typeof value.hasMore !== 'boolean' || value.hasMore !== (request.offset + Array.from(value.chunk).length < value.total) ||
    typeof value.whole !== 'boolean') throw Error('invalid_bot_attachment_preview_result')
  return value as unknown as HostBotAttachmentPreviewChunk
}
