/** A bounded byte page of committed DS Bot group history. */
const ID = /^room:[A-Za-z0-9][A-Za-z0-9._-]{0,122}$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const MAX_BYTES = 60 * 1024
const CHUNK_BYTES = 32 * 1024

/** Select one bounded page of a logical group's committed journal. */
export interface HostBotGroupHistoryReadRequest {
  readonly schema_version: 'dsh-remote-bot-read/v1'
  readonly kind: 'group-history'
  readonly logical_id: string
  readonly limit: number
  readonly cursor?: string
}

/** Committed group journal page bound to its sequence and digest. */
export interface HostBotGroupHistoryPage {
  readonly logical_id: string
  readonly seq: number
  readonly digest: string
  readonly complete: boolean
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

/** Parse a selector with no Profile path or transport override.
 * @param value Untrusted request payload.
 * @returns Validated logical request.
 */
export function parseHostBotGroupHistoryReadRequest(value: unknown): HostBotGroupHistoryReadRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-read/v1' || value.kind !== 'group-history' ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'limit', 'cursor'].includes(key)) ||
    (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 || (value.limit as number) > CHUNK_BYTES)) ||
    (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) {
    throw Error('invalid_bot_group_history_request')
  }
  return { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
    logical_id: value.logical_id, limit: (value.limit as number | undefined) ?? CHUNK_BYTES,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) }
}

/** Validate the private plugin page before it enters a Host control frame.
 * @param value Untrusted worker response.
 * @returns Validated journal page.
 */
export function parseHostBotGroupHistoryPage(value: unknown): HostBotGroupHistoryPage {
  if (!row(value) || !exact(value, ['logical_id', 'seq', 'digest', 'complete', 'total_bytes', 'offset',
    'content_base64', 'next_cursor', 'source', 'last_confirmed_at']) ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    !Number.isSafeInteger(value.seq) || (value.seq as number) < 0 ||
    typeof value.digest !== 'string' || !DIGEST.test(value.digest) ||
    typeof value.complete !== 'boolean' ||
    !Number.isSafeInteger(value.total_bytes) || (value.total_bytes as number) < 0 ||
    !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 ||
    typeof value.content_base64 !== 'string' || value.content_base64.length > 43_692 ||
    !BASE64.test(value.content_base64) ||
    (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor))) ||
    value.source !== 'authority' || typeof value.last_confirmed_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.last_confirmed_at) ||
    Number.isNaN(Date.parse(value.last_confirmed_at))) throw Error('invalid_bot_group_history_page')
  const bytes = Buffer.from(value.content_base64, 'base64')
  if (bytes.length > CHUNK_BYTES || bytes.toString('base64') !== value.content_base64 ||
    (value.offset as number) + bytes.length > (value.total_bytes as number) ||
    (value.offset as number) < (value.total_bytes as number) && bytes.length === 0 ||
    ((value.offset as number) + bytes.length < (value.total_bytes as number)) !== (value.next_cursor !== null) ||
    ((value.seq as number) === 0 && ((value.total_bytes as number) !== 0 || !value.complete))) {
    throw Error('invalid_bot_group_history_page')
  }
  const page = { logical_id: value.logical_id, seq: value.seq as number, digest: value.digest,
    complete: value.complete, total_bytes: value.total_bytes as number, offset: value.offset as number,
    content_base64: value.content_base64, next_cursor: value.next_cursor,
    source: 'authority' as const, last_confirmed_at: value.last_confirmed_at }
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_BYTES) throw Error('invalid_bot_group_history_page')
  return page
}
