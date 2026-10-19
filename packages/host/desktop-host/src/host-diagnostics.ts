import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'

const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const UNSAFE_TOKEN_CHARACTER = /[^A-Za-z0-9._]/u
const RECORD_TOKEN_MAXIMUM_CHARS = 64
const DEFAULT_MAXIMUM_LOG_BYTES = 256 * 1024
const LOG_DIRECTORY = 'diagnostics'
const LOG_FILENAME = 'host-errors.log'
const ROTATED_SUFFIX = '.1'

/** Host failure events one environment root records for field triage. */
export type HostDiagnosticsEvent = 'peer-attest' | 'control-session'

/** One redacted Host failure record; only stable codes and bounded numbers are accepted. */
export interface HostDiagnosticRecord {
  readonly event: HostDiagnosticsEvent
  /** Stable failure code; never carrier text, a path, or an identity. */
  readonly reason: string
  /** Control method name, present only when it identifies the rejected operation. */
  readonly method?: string
  /** Win32 HRESULT or status value, present only when the platform reported one. */
  readonly status?: number
}

/** Failure sink for Host authority seams whose caller must not learn the rejection cause. */
export interface HostDiagnostics {
  record(record: HostDiagnosticRecord): void
}

/** Physical log operations, injectable only to prove the writer cannot fail the Host. */
export interface HostDiagnosticsFileOperations {
  ensureDirectory(path: string): void
  append(path: string, contents: Buffer): void
  /** Current log length in bytes, or `undefined` when no log exists yet. */
  length(path: string): number | undefined
  /** Move `source` onto `target`, replacing any previous target. */
  replace(source: string, target: string): void
}

/** Environment root, clock, and bounds for one Host diagnostics log. */
export interface HostDiagnosticsOptions {
  readonly root: string
  readonly now?: () => number
  readonly maximumBytes?: number
  readonly fileOperations?: HostDiagnosticsFileOperations
}

/** Production filesystem operations; tests inject mapped equivalents to run on any platform. */
export const hostDiagnosticsFileOperations: HostDiagnosticsFileOperations = {
  ensureDirectory: (path) => { mkdirSync(path, { recursive: true }) },
  append: (path, contents) => { appendFileSync(path, contents) },
  length: path => existsSync(path) ? statSync(path).size : undefined,
  replace: (source, target) => {
    rmSync(target, { force: true })
    renameSync(source, target)
  },
}

/**
 * Reduce one reported value to a bounded lowercase token.
 * Only the leading run of `[A-Za-z0-9._]` survives, so a value that begins as a path, a user name,
 * a SID, or carrier text contributes at most its first character and never a path fragment.
 * @param value - reported code or method name; `undefined` keeps the field absent.
 * @param maximumChars - character budget for the token.
 * @returns the bounded token, or `undefined` when nothing safe remains.
 */
function recordToken(value: string | undefined, maximumChars: number): string | undefined {
  if (value === undefined) return undefined
  const prefix = value.slice(0, maximumChars)
  const unsafe = prefix.search(UNSAFE_TOKEN_CHARACTER)
  const token = (unsafe === -1 ? prefix : prefix.slice(0, unsafe)).toLowerCase()
  return token.length === 0 ? undefined : token
}

/**
 * Map one rejected operation onto a stable, path-free diagnostics reason.
 * @param error - rejection raised by Host authority or its dispatcher.
 * @returns the finer local reason when the rejection names one, otherwise the Host authority code,
 *   otherwise the error name, otherwise `unknown`.
 */
export function hostDiagnosticReason(error: unknown): string {
  if (error instanceof HostAuthorityError) return error.diagnosticReason ?? error.code
  if (error instanceof Error) return error.name
  return 'unknown'
}

/**
 * Name the failing step of one local Profile operation for local diagnostics.
 * The control protocol still carries the Host authority code; only the diagnostics log learns
 * which step rejected, so a stale selector is distinguishable from a rejected unlock or worker.
 * @param operation - step under diagnosis.
 * @param reason - stable, path-free reason recorded when the step rejects.
 * @returns the step result unchanged.
 */
export async function hostStepRejection<T>(operation: () => Promise<T> | T, reason: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HostAuthorityError && error.diagnosticReason === undefined) {
      throw new HostAuthorityError(error.code, reason)
    }
    throw error
  }
}

/**
 * Create the bounded failure log for one Windows Host environment root.
 * Records are single-line JSON holding only stable codes, and every filesystem or clock failure
 * is swallowed: diagnostics never change whether the Host serves or rejects a request.
 * @param options - environment root, clock, byte bound, and injectable file operations.
 * @returns the sink consumed by peer attestation and control-session failures.
 */
export function createHostDiagnostics(options: HostDiagnosticsOptions): HostDiagnostics {
  const root = options.root
  if (!DRIVE_ROOTED_PATH.test(root) || CONTROL_CHARACTER.test(root)
    || root.slice(2).includes(':') || win32.normalize(root) !== root) {
    throw new HostAuthorityError('invalid_input')
  }
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_LOG_BYTES
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new HostAuthorityError('invalid_input')
  const operations = options.fileOperations ?? hostDiagnosticsFileOperations
  const now = options.now ?? Date.now
  const directory = win32.join(root, LOG_DIRECTORY)
  const path = win32.join(directory, LOG_FILENAME)
  return {
    record(record) {
      try {
        const reason = recordToken(record.reason, RECORD_TOKEN_MAXIMUM_CHARS)
        if (reason === undefined) return
        const method = recordToken(record.method, RECORD_TOKEN_MAXIMUM_CHARS)
        // Per-field budgets keep a serialized record under 256 bytes, so one line never
        // approaches the file bound and rotation always leaves a valid log behind.
        const line = Buffer.from(`${JSON.stringify({
          ts: new Date(now()).toISOString(),
          event: record.event,
          reason,
          ...(method === undefined ? {} : { method }),
          ...(record.status === undefined ? {} : { status: record.status }),
        })}\n`)
        operations.ensureDirectory(directory)
        const current = operations.length(path)
        if (current !== undefined && current + line.length > maximumBytes) {
          operations.replace(path, `${path}${ROTATED_SUFFIX}`)
        }
        operations.append(path, line)
      } catch { /* diagnostics never affect Host control flow */ }
    },
  }
}
