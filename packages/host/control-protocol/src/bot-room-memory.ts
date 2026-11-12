/** Bounded group memory pages from one verified Desktop Profile. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { parseHostBotMemory, parseHostBotMemoryRequest } from './bot-memory.js'

/** A group identity and cursor, without a caller-selected Profile. */
export interface HostBotRoomMemoryRequest {
  readonly roomId: string
  readonly cursor: string | null
  readonly limit: number
  readonly summarize: boolean
}
/** One group memory entry. */
export interface HostBotRoomMemoryEntry {
  readonly scope: 'group'
  readonly topic: string | null
  readonly text: string
  readonly added: string | null
  readonly by: string | null
  readonly source: string | null
}
/** The current group memory page and summary state. */
export type HostBotRoomMemory =
  | { readonly roomId: string
    readonly available: false }
  | { readonly roomId: string
    readonly available: true
    readonly total: number
    readonly entries: HostBotRoomMemoryEntry[]
    readonly nextCursor: string | null
    readonly sizes: { readonly group: number }
    readonly limits: { readonly main: number }
    readonly summary: { readonly text: string
      readonly at: number } | null
    readonly fresh: boolean
    readonly summarizing: boolean
    readonly error: string | null }

/** Validate a group memory selector.
 * @param value - Untrusted remote arguments.
 * @returns A bounded group selector and cursor.
 */
export function parseHostBotRoomMemoryRequest(value: unknown): HostBotRoomMemoryRequest {
  if (!record(value) || !exact(value, ['roomId', 'cursor', 'limit', 'summarize']) ||
    typeof value.roomId !== 'string' || !/^[!-~]{1,256}$/u.test(value.roomId) ||
    value.roomId === '.' || value.roomId === '..' || /[/\\]/u.test(value.roomId))
    throw Error('invalid_bot_room_memory_request')
  const checked = parseHostBotMemoryRequest({ botId: 'room', cursor: value.cursor,
    limit: value.limit, summarize: value.summarize })
  return { roomId: value.roomId, cursor: checked.cursor, limit: checked.limit,
    summarize: checked.summarize }
}

/** Validate and project a group memory page using the common pagination rules.
 * @param value - Untrusted plugin reply.
 * @param request - Captured group request.
 * @returns The bounded page, or null when the group is unavailable.
 */
export function parseHostBotRoomMemory(value: unknown,
  request: HostBotRoomMemoryRequest): HostBotRoomMemory | null {
  if (value === null) return null
  if (!record(value) || value.roomId !== request.roomId || typeof value.available !== 'boolean')
    throw Error('invalid_bot_room_memory_result')
  if (!value.available) {
    if (!exact(value, ['roomId', 'available'])) throw Error('invalid_bot_room_memory_result')
    return { roomId: request.roomId, available: false }
  }
  if (!exact(value, ['roomId', 'available', 'total', 'entries', 'nextCursor', 'sizes', 'limits',
    'summary', 'fresh', 'summarizing', 'error']) ||
    !record(value.sizes) || !exact(value.sizes, ['group']) || !Array.isArray(value.entries))
    throw Error('invalid_bot_room_memory_result')
  const entries = value.entries.map((item: unknown) => {
    if (!record(item) || !exact(item, ['scope', 'topic', 'text', 'added', 'by', 'source']) ||
      item.scope !== 'group') throw Error('invalid_bot_room_memory_result')
    return { ...item, scope: 'own' }
  })
  try {
    const checked = parseHostBotMemory({ botId: request.roomId, available: true,
      total: value.total, entries, nextCursor: value.nextCursor,
      sizes: { own: value.sizes.group, team: 0 }, limits: value.limits,
      summary: value.summary, fresh: value.fresh, summarizing: value.summarizing,
      error: value.error },
    { botId: request.roomId, cursor: request.cursor, limit: request.limit,
      summarize: request.summarize })
    if (checked === null || !checked.available) throw Error('invalid_bot_room_memory_result')
    return { roomId: request.roomId, available: true, total: checked.total,
      entries: checked.entries.map(item => ({ ...item, scope: 'group' as const })),
      nextCursor: checked.nextCursor, sizes: { group: checked.sizes.own },
      limits: checked.limits, summary: checked.summary, fresh: checked.fresh,
      summarizing: checked.summarizing, error: checked.error }
  } catch { throw Error('invalid_bot_room_memory_result') }
}
