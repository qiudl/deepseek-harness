import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const DIGEST = /^[0-9a-f]{64}$/u
const CHUNK_BYTES = 48_000

export type HostBotFeedbackLogRequest = Readonly<{ offset: number; digest: string | null }>
export type HostBotFeedbackLogChunk = Readonly<{
  digest: string
  total: number
  chunk: string
  nextOffset: number | null
}>

export function parseHostBotFeedbackLogRequest(value: unknown): HostBotFeedbackLogRequest {
  if (!record(value) || !exact(value, ['offset', 'digest']) ||
    !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
    (value.offset as number) % CHUNK_BYTES !== 0 ||
    !((value.offset === 0 && value.digest === null) ||
      ((value.offset as number) > 0 && typeof value.digest === 'string' && DIGEST.test(value.digest))))
    throw Error('invalid_bot_feedback_log_request')
  return { offset: value.offset as number, digest: value.digest as string | null }
}

export function parseHostBotFeedbackLogChunk(value: unknown, request: HostBotFeedbackLogRequest): HostBotFeedbackLogChunk | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['digest', 'total', 'chunk', 'nextOffset']) ||
    typeof value.digest !== 'string' || !DIGEST.test(value.digest) ||
    request.digest !== null && request.digest !== value.digest ||
    !Number.isSafeInteger(value.total) || (value.total as number) < 0 || (value.total as number) > 1_100_000 ||
    typeof value.chunk !== 'string' || value.chunk.length > 64_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.chunk) ||
    Buffer.from(value.chunk, 'base64').length > CHUNK_BYTES ||
    (value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) ||
      (value.nextOffset as number) !== request.offset + Buffer.from(value.chunk, 'base64').length ||
      Buffer.from(value.chunk, 'base64').length !== CHUNK_BYTES)) ||
    request.offset + Buffer.from(value.chunk, 'base64').length > (value.total as number) ||
    (value.nextOffset === null) !== (request.offset + Buffer.from(value.chunk, 'base64').length === value.total))
    throw Error('invalid_bot_feedback_log_result')
  return { digest: value.digest, total: value.total as number, chunk: value.chunk,
    nextOffset: value.nextOffset as number | null }
}
