/** Exact Profile-local memory page carried only by a private worker route. */
const ID = /^(?:team|(?:bot|room):[A-Za-z0-9][A-Za-z0-9._-]{0,122})$/u
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const FILE = /^(?:MEMORY|[\p{L}\p{N}][\p{L}\p{N}_-]{0,47})\.md$/u
const MAX_BYTES = 60 * 1024

/** Selector for one logical memory scope in the current Profile. */
export interface HostBotMemoryReadRequest {
  readonly schema_version: 'dsh-remote-bot-read/v1'
  readonly kind: 'memory'
  readonly logical_id: string
  readonly limit: number
  readonly cursor?: string
}

/** One bounded raw-byte chunk of a logical memory file. */
interface HostBotMemoryChunk {
  readonly file: string
  readonly offset: number
  readonly total_bytes: number
  readonly sha256: string
  readonly content_base64: string
}

/** One bounded raw-byte chunk of a logical memory scope. */
export interface HostBotMemoryPage {
  readonly logical_id: string
  readonly scope_revision: string
  readonly next_cursor: string | null
  readonly item: HostBotMemoryChunk | null
  readonly source: 'authority'
  readonly last_confirmed_at: string
}

const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/**
 * Keep path and Profile selectors out of the worker request.
 * @param value - Untrusted worker request body.
 * @returns A bounded logical scope selector.
 */
export function parseHostBotMemoryReadRequest(value: unknown): HostBotMemoryReadRequest {
  if (!row(value) || value.schema_version !== 'dsh-remote-bot-read/v1' || value.kind !== 'memory' ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    Object.keys(value).some(key => !['schema_version', 'kind', 'logical_id', 'limit', 'cursor'].includes(key)) ||
    (Object.hasOwn(value, 'limit') && (!Number.isSafeInteger(value.limit) ||
      (value.limit as number) < 1 || (value.limit as number) > 100)) ||
    (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor)))) {
    throw Error('invalid_bot_memory_request')
  }
  return { schema_version: 'dsh-remote-bot-read/v1', kind: 'memory', logical_id: value.logical_id,
    limit: (value.limit as number | undefined) ?? 50,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }) }
}

/**
 * Validate one byte-bounded chunk and copy only the memory wire fields.
 * @param value - Untrusted Profile plugin result.
 * @returns One validated memory page.
 */
export function parseHostBotMemoryPage(value: unknown): HostBotMemoryPage {
  if (!row(value) || !exact(value, ['logical_id', 'scope_revision', 'next_cursor', 'item', 'source', 'last_confirmed_at']) ||
    typeof value.logical_id !== 'string' || !ID.test(value.logical_id) ||
    typeof value.scope_revision !== 'string' || !DIGEST.test(value.scope_revision) ||
    (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor))) ||
    value.source !== 'authority' || typeof value.last_confirmed_at !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.last_confirmed_at) ||
    Number.isNaN(Date.parse(value.last_confirmed_at))) throw Error('invalid_bot_memory_page')
  let item: HostBotMemoryPage['item'] = null
  if (value.item !== null) {
    const entry = value.item
    if (!row(entry) || !exact(entry, ['file', 'offset', 'total_bytes', 'sha256', 'content_base64']) ||
      typeof entry.file !== 'string' || !FILE.test(entry.file) ||
      entry.file !== 'MEMORY.md' && entry.file !== entry.file.toLowerCase() ||
      !Number.isSafeInteger(entry.offset) || (entry.offset as number) < 0 ||
      !Number.isSafeInteger(entry.total_bytes) || (entry.total_bytes as number) < 0 ||
      (entry.total_bytes as number) > 1_000_000 || typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256) ||
      typeof entry.content_base64 !== 'string' || entry.content_base64.length > 43_692 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(entry.content_base64)) {
      throw Error('invalid_bot_memory_page')
    }
    const bytes = Buffer.from(entry.content_base64, 'base64')
    if (bytes.length > 32 * 1024 || bytes.toString('base64') !== entry.content_base64 ||
      (entry.offset as number) + bytes.length > (entry.total_bytes as number) ||
      (entry.total_bytes as number) > 0 && bytes.length === 0 ||
      (entry.offset as number) + bytes.length < (entry.total_bytes as number) && value.next_cursor === null) {
      throw Error('invalid_bot_memory_page')
    }
    item = { file: entry.file, offset: entry.offset as number,
      total_bytes: entry.total_bytes as number, sha256: entry.sha256, content_base64: entry.content_base64 }
  }
  if (item === null && value.next_cursor !== null) throw Error('invalid_bot_memory_page')
  const page = { logical_id: value.logical_id, scope_revision: value.scope_revision,
    next_cursor: value.next_cursor, item, source: 'authority' as const,
    last_confirmed_at: value.last_confirmed_at }
  if (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_BYTES) throw Error('invalid_bot_memory_page')
  return page
}
