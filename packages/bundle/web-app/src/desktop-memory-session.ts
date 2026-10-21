/** REQ-20261021-0013: bounded Profile-local Session extraction for the private Host worker. */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Reconstructed current-format JSONL, retained only in the calling Host process. */
export interface DesktopMemorySessionSnapshot {
  readonly sessionId: string
  readonly revision: string
  readonly text: string
}

const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_EVENTS = 100_000
const PAGE_SIZE = 256
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

function privateTopLevel(header: {
  readonly isSeeded: boolean
  readonly parentSession?: unknown
  readonly origin?: unknown
  readonly delegationDepth?: number
}): boolean {
  return !header.isSeeded && header.parentSession === undefined
    && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

/**
 * Read one already owned Profile's durable Session through its validating persistence service.
 * Callers must keep the returned raw JSONL within the authenticated local Host path and redact
 * it before any index, server, or model receives content. No filesystem path is accepted.
 * @param persistence - Persistence bound to the current Account Profile worker.
 * @param rawSessionId - Exact Session identity selected by the authenticated Host.
 * @param signal - Request lifetime, including binding and Host connection cancellation.
 * @returns A current-format bounded snapshot; missing, changed, delegated or oversized sessions refuse.
 */
export async function readDesktopMemorySession(
  persistence: Pick<SessionPersistence, 'stat' | 'open'>,
  rawSessionId: string,
  signal: AbortSignal,
): Promise<DesktopMemorySessionSnapshot> {
  signal.throwIfAborted()
  if (!SESSION_ID.test(rawSessionId)) throw new Error('memory_session_invalid')
  const id = SessionId(rawSessionId)
  const before = await persistence.stat(id, { signal })
  if (!before || !privateTopLevel(before.header)) throw new Error('memory_session_unavailable')
  const handle = await persistence.open(id, 'read', { signal })
  try {
    signal.throwIfAborted()
    if (handle.header.id !== id || !privateTopLevel(handle.header)
      || handle.header.createdAt !== before.header.createdAt)
      throw new Error('memory_session_changed')
    const headerLine = JSON.stringify(handle.header)
    const lines = [headerLine]
    let bytes = Buffer.byteLength(headerLine, 'utf8') + 1
    let offset = 0
    while (true) {
      signal.throwIfAborted()
      const { events } = await handle.read(offset, PAGE_SIZE, { signal })
      if (events.length === 0) break
      for (const event of events) {
        const line = JSON.stringify(event)
        bytes += Buffer.byteLength(line, 'utf8') + 1
        if (bytes > MAX_SESSION_BYTES || offset >= MAX_EVENTS)
          throw new Error('memory_session_oversized')
        lines.push(line)
        offset += 1
      }
      if (events.length < PAGE_SIZE) break
    }
    const after = await persistence.stat(id, { signal })
    signal.throwIfAborted()
    if (!after || after.revision !== before.revision || after.header.id !== id)
      throw new Error('memory_session_changed')
    return { sessionId: id, revision: String(after.revision), text: `${lines.join('\n')}\n` }
  } finally {
    await handle.close()
  }
}

/**
 * Serve a Profile Session only to its parent Host's independent memory bearer token.
 * Browser cookies and other private worker tokens confer no access.
 * @param req - Exact Session ID POST from the parent Host.
 * @param res - Noncacheable bounded raw snapshot or sanitized refusal.
 * @param token - Random memory-only token held by this worker and its parent Host.
 * @param persistence - Current Profile's validating persistence service.
 * @returns Resolution when the private response settles.
 */
export function handleDesktopMemorySessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  persistence: Pick<SessionPersistence, 'stat' | 'open'>,
): Promise<void> {
  return handleDesktopPrivateRequest(
    req, res, token,
    (target, signal) => readDesktopMemorySession(persistence, target.session_id, signal),
    (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_input')
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 1 || typeof record.session_id !== 'string'
        || !SESSION_ID.test(record.session_id)) throw Error('invalid_input')
      return { session_id: record.session_id }
    },
    (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_result')
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 3 || typeof record.sessionId !== 'string'
        || typeof record.revision !== 'string' || typeof record.text !== 'string'
        || Buffer.byteLength(record.text, 'utf8') > MAX_SESSION_BYTES) throw Error('invalid_result')
      return record as unknown as DesktopMemorySessionSnapshot
    },
    (result, target) => result.sessionId === target.session_id,
    2048,
  )
}
