/** Private, bounded DS Bot Session transfer. This contract carries no Account read grant. */
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const SESSION = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/u
const MAX_BYTES = 64_000_000
const CHUNK_BYTES = 32 * 1024
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max

export type HostBotImportSourceRequest =
  | { readonly kind: 'open'; readonly operationId: string; readonly sourceDigest: string; readonly sessionId: string }
  | { readonly kind: 'next'; readonly operationId: string; readonly transferId: string; readonly offset: number }
  | { readonly kind: 'close'; readonly operationId: string; readonly transferId: string }

export type HostBotImportSourceResult =
  | {
    readonly version: 1
    readonly transferId: string
    readonly operationId: string
    readonly sessionId: string
    readonly eventDigest: string
    readonly eventCount: number
    readonly totalBytes: number
  }
  | {
    readonly version: 1
    readonly transferId: string
    readonly operationId: string
    readonly sessionId: string
    readonly eventDigest: string
    readonly eventCount: number
    readonly offset: number
    readonly totalBytes: number
    readonly contentBase64: string
    readonly nextOffset: number | null
  }
  | { readonly version: 1; readonly closed: true }

export function parseHostBotImportSourceRequest(value: unknown): HostBotImportSourceRequest {
  if (!row(value) || !UUID.test(String(value.operationId))) throw Error('invalid_bot_import_source_request')
  if (value.kind === 'open' && exact(value, ['kind', 'operationId', 'sourceDigest', 'sessionId']) &&
      typeof value.sourceDigest === 'string' && DIGEST.test(value.sourceDigest) &&
      typeof value.sessionId === 'string' && SESSION.test(value.sessionId))
    return value as HostBotImportSourceRequest
  if (value.kind === 'next' && exact(value, ['kind', 'operationId', 'transferId', 'offset']) &&
      typeof value.transferId === 'string' && UUID.test(value.transferId) &&
      integer(value.offset, 0, MAX_BYTES)) return value as HostBotImportSourceRequest
  if (value.kind === 'close' && exact(value, ['kind', 'operationId', 'transferId']) &&
      typeof value.transferId === 'string' && UUID.test(value.transferId))
    return value as HostBotImportSourceRequest
  throw Error('invalid_bot_import_source_request')
}

export function parseHostBotImportSourceResult(value: unknown,
  request: HostBotImportSourceRequest): HostBotImportSourceResult {
  if (!row(value) || value.version !== 1) throw Error('invalid_bot_import_source_result')
  if (request.kind === 'close' && exact(value, ['version', 'closed']) && value.closed === true)
    return { version: 1, closed: true }
  if (request.kind !== 'close' && value.operationId === request.operationId &&
      typeof value.transferId === 'string' && UUID.test(value.transferId) &&
      typeof value.sessionId === 'string' && SESSION.test(value.sessionId) &&
      typeof value.eventDigest === 'string' && DIGEST.test(value.eventDigest) &&
      integer(value.eventCount, 0, 10_000_000) && integer(value.totalBytes, 2, MAX_BYTES) &&
      (request.kind !== 'next' || value.transferId === request.transferId)) {
    if (request.kind === 'open' && value.sessionId === request.sessionId &&
        exact(value, ['version', 'transferId', 'operationId', 'sessionId', 'eventDigest',
          'eventCount', 'totalBytes'])) return value as HostBotImportSourceResult
    if (request.kind === 'next' && exact(value, ['version', 'transferId', 'operationId',
      'sessionId', 'eventDigest', 'eventCount', 'offset', 'totalBytes', 'contentBase64',
      'nextOffset']) && value.offset === request.offset &&
      typeof value.contentBase64 === 'string' && value.contentBase64.length <= 43_692 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.contentBase64)) {
      const bytes = Buffer.from(value.contentBase64, 'base64')
      const end = request.offset + bytes.length
      if (bytes.length > 0 && bytes.length <= CHUNK_BYTES &&
          bytes.toString('base64') === value.contentBase64 && end <= (value.totalBytes as number) &&
          (value.nextOffset === null ? end === value.totalBytes :
            value.nextOffset === end && end < (value.totalBytes as number)))
        return value as HostBotImportSourceResult
    }
  }
  throw Error('invalid_bot_import_source_result')
}
