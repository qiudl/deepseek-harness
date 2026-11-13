/** Bounded native Bot memory pages from the verified Desktop Profile. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** Selector for one Bot's memory, with a stable cursor across pages. */
export interface HostBotMemoryRequest {
  readonly botId: string
  readonly cursor: string | null
  readonly limit: number
  readonly summarize: boolean
}
/** One saved memory entry visible to the Profile owner. */
export interface HostBotMemoryEntry {
  readonly scope: 'own' | 'team'
  readonly topic: string | null
  readonly text: string
  readonly added: string | null
  readonly by: string | null
  readonly source: string | null
}
/** Paged memory view, including the current summary state. */
export type HostBotMemory =
  | { readonly botId: string
    readonly available: false }
  | { readonly botId: string
    readonly available: true
    readonly total: number
    readonly entries: HostBotMemoryEntry[]
    readonly nextCursor: string | null
    readonly sizes: { readonly own: number
      readonly team: number }
    readonly limits: { readonly main: number }
    readonly summary: { readonly text: string
      readonly at: number } | null
    readonly fresh: boolean
    readonly summarizing: boolean
    readonly error: string | null }

const botId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const cursor = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{64}:[1-9][0-9]{0,5}$/u.test(value)
const bytes = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const optional = (value: unknown, max: number): value is string | null => value === null || bytes(value, max)
const size = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
const timestamp = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0

/** Validate a paged Bot memory request.
 * @param value - Untrusted remote UI arguments.
 * @returns A bounded Bot selector and cursor.
 */
export function parseHostBotMemoryRequest(value: unknown): HostBotMemoryRequest {
  if (!record(value) || !exact(value, ['botId', 'cursor', 'limit', 'summarize']) ||
    !botId(value.botId) || value.cursor !== null && !cursor(value.cursor) ||
    !Number.isSafeInteger(value.limit) || typeof value.limit !== 'number' ||
    value.limit < 1 || value.limit > 20 || typeof value.summarize !== 'boolean')
    throw Error('invalid_bot_memory_request')
  return { botId: value.botId, cursor: value.cursor, limit: value.limit,
    summarize: value.summarize }
}

/** Validate the Profile's memory page and its pagination continuity.
 * @param value - Untrusted plugin reply.
 * @param request - Captured request for correlation.
 * @returns The bounded memory page, or null when no writer serves the Profile.
 */
export function parseHostBotMemory(value: unknown, request: HostBotMemoryRequest): HostBotMemory | null {
  if (value === null) return null
  if (!record(value) || value.botId !== request.botId || typeof value.available !== 'boolean')
    throw Error('invalid_bot_memory_result')
  if (!value.available) {
    if (!exact(value, ['botId', 'available'])) throw Error('invalid_bot_memory_result')
    return { botId: request.botId, available: false }
  }
  if (!exact(value, ['botId', 'available', 'total', 'entries', 'nextCursor', 'sizes', 'limits',
    'summary', 'fresh', 'summarizing', 'error']) || !size(value.total) || value.total > 10000 ||
    !Array.isArray(value.entries) || value.entries.length > request.limit ||
    value.nextCursor !== null && !cursor(value.nextCursor) ||
    !record(value.sizes) || !exact(value.sizes, ['own', 'team']) ||
    !size(value.sizes.own) || !size(value.sizes.team) ||
    !record(value.limits) || !exact(value.limits, ['main']) || !size(value.limits.main) ||
    typeof value.fresh !== 'boolean' || typeof value.summarizing !== 'boolean' ||
    !optional(value.error, 2048)) throw Error('invalid_bot_memory_result')
  let summary: { text: string; at: number } | null = null
  if (value.summary !== null) {
    if (!record(value.summary) || !exact(value.summary, ['text', 'at']) ||
      !bytes(value.summary.text, 8000) || !timestamp(value.summary.at))
      throw Error('invalid_bot_memory_result')
    summary = { text: value.summary.text, at: value.summary.at }
  }
  const entries: HostBotMemoryEntry[] = value.entries.map((item: unknown) => {
    if (!record(item) || !exact(item, ['scope', 'topic', 'text', 'added', 'by', 'source']) ||
      (item.scope !== 'own' && item.scope !== 'team') || !optional(item.topic, 128) ||
      !bytes(item.text, 16000) || !optional(item.added, 256) ||
      !optional(item.by, 256) || !optional(item.source, 1024))
      throw Error('invalid_bot_memory_result')
    return { scope: item.scope, topic: item.topic, text: item.text,
      added: item.added, by: item.by, source: item.source }
  })
  const offset = request.cursor === null ? 0 : Number(request.cursor.split(':')[1])
  if (offset > value.total || offset + entries.length > value.total ||
    (offset < value.total && entries.length === 0) ||
    (value.nextCursor === null) !== (offset + entries.length === value.total))
    throw Error('invalid_bot_memory_result')
  if (value.nextCursor !== null &&
    (value.nextCursor.split(':')[0] !== (request.cursor?.split(':')[0] ?? value.nextCursor.split(':')[0]) ||
      Number(value.nextCursor.split(':')[1]) !== offset + entries.length))
    throw Error('invalid_bot_memory_result')
  return { botId: request.botId, available: true, total: value.total,
    entries, nextCursor: value.nextCursor, sizes: { own: value.sizes.own, team: value.sizes.team },
    limits: { main: value.limits.main }, summary,
    fresh: value.fresh, summarizing: value.summarizing, error: value.error }
}
