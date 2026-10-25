/** One bounded text-only page from a current-team Bot private chat part. */
const ID = /^bot:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MAX_BYTES = 60 * 1024
const CHUNK_BYTES = 32 * 1024
const MAX_PARTS = 10_000

/** Select a bounded byte page of one logical Bot chat part. */
export interface HostBotChatReadRequest {
  readonly schema_version: 'dsh-remote-bot-read/v1'
  readonly kind: 'bot-chat'
  readonly logical_id: string
  readonly part: number
  readonly limit: number
  readonly cursor?: string
}

/** Text projection page bound to the source event and row digests. */
export interface HostBotChatPage {
  readonly logical_id: string
  readonly part: number
  readonly part_count: number
  readonly team_revision: number
  readonly event_digest: string
  readonly rows_digest: string
  readonly complete: true
  readonly total_bytes: number
  readonly offset: number
  readonly content_base64: string
  readonly next_cursor: string | null
  readonly source: 'authority'
  readonly last_confirmed_at: string
}

const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Reject raw Session IDs, Profile paths and transport overrides.
 * @param value Untrusted request payload.
 * @returns Validated logical request.
 */
export function parseHostBotChatReadRequest(value: unknown): HostBotChatReadRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-read/v1' || value.kind !== 'bot-chat' ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    !Number.isSafeInteger(value.part) || (value.part as number) < 0 || (value.part as number) >= MAX_PARTS ||
    Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'part', 'limit', 'cursor'].includes(key)) ||
    (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 || (value.limit as number) > CHUNK_BYTES)) ||
    (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) throw Error('invalid_bot_chat_request')
  return { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
    logical_id: value.logical_id, part: value.part as number,
    limit: (value.limit as number | undefined) ?? CHUNK_BYTES,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) }
}

/** Validate the plugin page before it enters a Host control frame.
 * @param value Untrusted worker response.
 * @returns Validated text page.
 */
export function parseHostBotChatPage(value: unknown): HostBotChatPage {
  if (!row(value) || !exact(value, ['logical_id', 'part', 'part_count', 'team_revision',
    'event_digest', 'rows_digest', 'complete', 'total_bytes', 'offset', 'content_base64',
    'next_cursor', 'source', 'last_confirmed_at']) ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    !Number.isSafeInteger(value.part) || (value.part as number) < 0 ||
    !Number.isSafeInteger(value.part_count) || (value.part_count as number) < 1 ||
    (value.part_count as number) > MAX_PARTS || (value.part as number) >= (value.part_count as number) ||
    !Number.isSafeInteger(value.team_revision) || (value.team_revision as number) < 0 ||
    typeof value.event_digest !== 'string' || !DIGEST.test(value.event_digest) ||
    typeof value.rows_digest !== 'string' || !DIGEST.test(value.rows_digest) ||
    value.complete !== true || !Number.isSafeInteger(value.total_bytes) || (value.total_bytes as number) < 2 ||
    !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
    typeof value.content_base64 !== 'string' || value.content_base64.length > 43_692 ||
    !BASE64.test(value.content_base64) ||
    (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor))) ||
    value.source !== 'authority' || typeof value.last_confirmed_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.last_confirmed_at) ||
    Number.isNaN(Date.parse(value.last_confirmed_at))) throw Error('invalid_bot_chat_page')
  const bytes = Buffer.from(value.content_base64, 'base64')
  if (bytes.length > CHUNK_BYTES || bytes.toString('base64') !== value.content_base64 ||
    (value.offset as number) + bytes.length > (value.total_bytes as number) ||
    (value.offset as number) < (value.total_bytes as number) && bytes.length === 0 ||
    ((value.offset as number) + bytes.length < (value.total_bytes as number)) !== (value.next_cursor !== null)) throw Error('invalid_bot_chat_page')
  const page = { logical_id: value.logical_id, part: value.part as number,
    part_count: value.part_count as number, team_revision: value.team_revision as number,
    event_digest: value.event_digest, rows_digest: value.rows_digest, complete: true as const,
    total_bytes: value.total_bytes as number, offset: value.offset as number,
    content_base64: value.content_base64, next_cursor: value.next_cursor,
    source: 'authority' as const, last_confirmed_at: value.last_confirmed_at }
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_BYTES) throw Error('invalid_bot_chat_page')
  return page
}
