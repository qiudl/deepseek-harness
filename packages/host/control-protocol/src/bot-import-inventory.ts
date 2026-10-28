/** Private inventory of the current DS Bot team's raw Session IDs. */
const DIGEST = /^[0-9a-f]{64}$/u
const SESSION = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/u
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Selector for one page of the current team's Session inventory. */
export type HostBotImportInventoryRequest = Readonly<{ kind: 'inventory'; cursor?: string }>
/** Bounded Session IDs and a digest-bound continuation cursor. */
export type HostBotImportInventoryPage = Readonly<{
  version: 1
  sourceDigest: string
  teamRevision: number
  sessionIds: readonly string[]
  nextCursor: string | null
}>

/** Strict request; no Profile selector or caller-selected Session IDs.
 * @param value Untrusted request body.
 * @returns Validated inventory selector.
 */
export function parseHostBotImportInventoryRequest(value: unknown): HostBotImportInventoryRequest {
  if (!row(value) || value.kind !== 'inventory' ||
      !exact(value, value.cursor === undefined ? ['kind'] : ['kind', 'cursor']) ||
      value.cursor !== undefined && (typeof value.cursor !== 'string' || !CURSOR.test(value.cursor) ||
        Buffer.from(value.cursor, 'base64url').toString('base64url') !== value.cursor))
    throw Error('invalid_bot_import_inventory_request')
  return value.cursor === undefined ? { kind: 'inventory' } :
    { kind: 'inventory', cursor: value.cursor }
}

/** Validate a bounded page and its digest-bound cursor progression.
 * @param value Untrusted worker response.
 * @param request Original selector, when validating cursor progression.
 * @returns Validated bounded page.
 */
export function parseHostBotImportInventoryPage(value: unknown,
  request?: HostBotImportInventoryRequest): HostBotImportInventoryPage {
  const sessionIds = row(value) ? value.sessionIds : undefined
  if (!row(value) || !exact(value, ['version', 'sourceDigest', 'teamRevision',
    'sessionIds', 'nextCursor']) || value.version !== 1 ||
    typeof value.sourceDigest !== 'string' || !DIGEST.test(value.sourceDigest) ||
    !Number.isSafeInteger(value.teamRevision) || (value.teamRevision as number) < 0 ||
    !Array.isArray(sessionIds) || sessionIds.length > 128 ||
    sessionIds.some((id: unknown, index: number) =>
      typeof id !== 'string' || !SESSION.test(id) ||
      index > 0 && id <= sessionIds[index - 1]) ||
    value.nextCursor !== null &&
      (typeof value.nextCursor !== 'string' || !CURSOR.test(value.nextCursor)))
    throw Error('invalid_bot_import_inventory_page')
  let offset = 0
  if (request?.cursor !== undefined) {
    const cursor = decodeCursor(request.cursor)
    if (cursor.sourceDigest !== value.sourceDigest) throw Error('stale_bot_import_inventory')
    offset = cursor.offset
    if (sessionIds.length === 0) throw Error('invalid_bot_import_inventory_page')
  }
  if (value.nextCursor !== null) {
    const next = decodeCursor(value.nextCursor)
    if (sessionIds.length !== 128 || next.sourceDigest !== value.sourceDigest ||
        next.offset !== offset + sessionIds.length || next.offset > 5_000)
      throw Error('invalid_bot_import_inventory_page')
  }
  return { version: 1, sourceDigest: value.sourceDigest, teamRevision: value.teamRevision as number,
    sessionIds: Object.freeze(sessionIds.map((id: unknown) => String(id))),
    nextCursor: value.nextCursor }
}

function decodeCursor(value: string): { sourceDigest: string; offset: number } {
  try {
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value || bytes.length > 192) throw Error()
    const cursor: unknown = JSON.parse(bytes.toString('utf8'))
    if (!row(cursor) || !exact(cursor, ['sourceDigest', 'offset']) ||
      typeof cursor.sourceDigest !== 'string' || !DIGEST.test(cursor.sourceDigest) ||
      !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 1 ||
      (cursor.offset as number) > 5_000 || (cursor.offset as number) % 128 !== 0) throw Error()
    return { sourceDigest: cursor.sourceDigest, offset: cursor.offset as number }
  } catch { throw Error('invalid_bot_import_inventory_cursor') }
}
