/** Bounded owner Bot avatar slices, separate from the settings snapshot. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import type { HostBotChatId } from './bot-chat.js'

/** Selects one bounded avatar chunk for an owner Bot. */
export interface HostBotAvatarRequest {
  readonly botId: HostBotChatId
  readonly offset: number
}
/** Correlated avatar bytes and digest for ordered assembly. */
export interface HostBotAvatarChunk {
  readonly botId: HostBotChatId
  readonly totalBytes: number
  readonly offset: number
  readonly sha256: string
  readonly chunk: string
  readonly hasMore: boolean
}
const CHUNK = 20_000

/** Validate the requested Bot and chunk offset.
 * @param value - Untrusted request arguments.
 * @returns Bounded avatar selector.
 */
export function parseHostBotAvatarRequest(value: unknown): HostBotAvatarRequest {
  if (!record(value) || !exact(value, ['botId', 'offset']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) ||
    value.offset < 0 || value.offset >= 160_000 || value.offset % CHUNK !== 0)
    throw Error('invalid_bot_avatar_request')
  return { botId: value.botId as HostBotChatId, offset: value.offset }
}

/** Validate a chunk against its selector and declared digest.
 * @param value - Untrusted Host reply.
 * @param request - Captured avatar selector.
 * @returns Correlated chunk or null when unavailable.
 */
export function parseHostBotAvatar(value: unknown, request: HostBotAvatarRequest): HostBotAvatarChunk | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['botId', 'totalBytes', 'offset', 'sha256', 'chunk', 'hasMore']) ||
    value.botId !== request.botId || value.offset !== request.offset ||
    typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 1 || value.totalBytes > 160_000 || request.offset >= value.totalBytes ||
    typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256) ||
    typeof value.chunk !== 'string' || value.chunk.length !== Math.min(CHUNK, value.totalBytes - request.offset) ||
    Buffer.byteLength(value.chunk, 'utf8') !== value.chunk.length ||
    typeof value.hasMore !== 'boolean' || value.hasMore !== (request.offset + value.chunk.length < value.totalBytes))
    throw Error('invalid_bot_avatar_result')
  return { botId: request.botId, totalBytes: value.totalBytes, offset: request.offset,
    sha256: value.sha256, chunk: value.chunk, hasMore: value.hasMore }
}
