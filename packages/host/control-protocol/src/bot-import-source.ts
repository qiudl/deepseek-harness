/** Private, bounded DS Bot Session transfer. This contract carries no Account read grant. */
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const SESSION = /^session-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const DIGEST = /^[0-9a-f]{64}$/u
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_BYTES = 64_000_000
const CHUNK_BYTES = 32 * 1024
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max

/** Open, advance or close one raw Session transfer. */
export type HostBotImportSourceRequest =
  | { readonly kind: 'open'; readonly operationId: string; readonly sourceDigest: string; readonly sessionId: string }
  | { readonly kind: 'next'; readonly operationId: string; readonly transferId: string; readonly offset: number }
  | { readonly kind: 'close'; readonly operationId: string; readonly transferId: string }

/** Repeated on every Host frame so an operation grant can be checked on every page. */
export interface HostBotImportSourceScope {
  readonly source_digest: string
  readonly session_id: string
  readonly target_device_id: string
}

/** Validate the repeated operation scope.
 * @param value Untrusted Host frame scope.
 * @returns Bounded source and target selector.
 */
export function parseHostBotImportSourceScope(value: unknown): HostBotImportSourceScope {
  if (!row(value) || !exact(value, ['source_digest', 'session_id', 'target_device_id']) ||
      typeof value.source_digest !== 'string' || !DIGEST.test(value.source_digest) ||
      typeof value.session_id !== 'string' || !SESSION.test(value.session_id) ||
      typeof value.target_device_id !== 'string' || !DEVICE.test(value.target_device_id))
    throw Error('invalid_bot_import_source_scope')
  return { source_digest: value.source_digest,
    session_id: value.session_id, target_device_id: value.target_device_id }
}

/** Bounded transfer metadata, event bytes or close receipt. */
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

/** Validate a private raw Session transfer command.
 * @param value Untrusted command.
 * @returns Strict transfer command.
 */
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

/** Validate a bounded worker result and optionally match its request.
 * @param value Untrusted worker result.
 * @param request Original transfer command, when available.
 * @returns Strict transfer result.
 */
export function parseHostBotImportSourceResult(value: unknown,
  request?: HostBotImportSourceRequest): HostBotImportSourceResult {
  if (!row(value) || value.version !== 1) throw Error('invalid_bot_import_source_result')
  if (exact(value, ['version', 'closed']) && value.closed === true &&
      (!request || request.kind === 'close'))
    return { version: 1, closed: true }
  if ((!request || request.kind !== 'close') &&
      (!request || value.operationId === request.operationId) &&
      typeof value.operationId === 'string' && UUID.test(value.operationId) &&
      typeof value.transferId === 'string' && UUID.test(value.transferId) &&
      typeof value.sessionId === 'string' && SESSION.test(value.sessionId) &&
      typeof value.eventDigest === 'string' && DIGEST.test(value.eventDigest) &&
      integer(value.eventCount, 0, 10_000_000) && integer(value.totalBytes, 2, MAX_BYTES) &&
      (!request || request.kind !== 'next' || value.transferId === request.transferId)) {
    if ((!request || request.kind === 'open' && value.sessionId === request.sessionId) &&
        exact(value, ['version', 'transferId', 'operationId', 'sessionId', 'eventDigest',
          'eventCount', 'totalBytes'])) return value as HostBotImportSourceResult
    if ((!request || request.kind === 'next' && value.offset === request.offset) &&
      exact(value, ['version', 'transferId', 'operationId',
        'sessionId', 'eventDigest', 'eventCount', 'offset', 'totalBytes', 'contentBase64',
        'nextOffset']) && integer(value.offset, 0, MAX_BYTES) &&
      typeof value.contentBase64 === 'string' && value.contentBase64.length <= 43_692 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.contentBase64)) {
      const bytes = Buffer.from(value.contentBase64, 'base64')
      const end = value.offset + bytes.length
      if (bytes.length > 0 && bytes.length <= CHUNK_BYTES &&
          bytes.toString('base64') === value.contentBase64 && end <= value.totalBytes &&
          (value.nextOffset === null ? end === value.totalBytes :
            value.nextOffset === end && end < value.totalBytes))
        return value as HostBotImportSourceResult
    }
  }
  throw Error('invalid_bot_import_source_result')
}
