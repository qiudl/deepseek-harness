/** REQ-20261021-0013: private, revision-checked logical Session reads for the parent Desktop Host. */
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const MAX_SESSIONS = 10_000
const PAGE_SIZE = 64
const MAX_EVENTS = 100_000
const MAX_BYTES = 64 * 1024 * 1024

/** One Profile-local inventory page. */
export interface DesktopMemorySessionPage {
  readonly items: readonly { readonly sessionId: string; readonly revision: string }[]
  readonly nextAfter: string | null
}

/** Logical event view, redacted by the parent Host before indexing. */
export interface DesktopMemorySessionSnapshot {
  readonly sessionId: string
  readonly revision: string
  readonly meta: unknown
  readonly events: readonly unknown[]
}

/** The current Profile persistence operations used by this private route. */
export type DesktopMemoryPersistence = Pick<SessionPersistence, 'listSnapshots' | 'borrowSession'>

function topLevel(meta: Record<string, unknown>): boolean {
  return meta.version === SESSION_FORMAT_VERSION && meta.isSeeded === undefined
    && meta.seedLength === undefined && meta.parentSession === undefined
    && meta.origin === undefined && (meta.delegationDepth === undefined || meta.delegationDepth === 0)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

async function inventory(persistence: DesktopMemoryPersistence, signal: AbortSignal): Promise<DesktopMemorySessionPage['items']> {
  const snapshots = await persistence.listSnapshots(signal)
  signal.throwIfAborted()
  if (snapshots.length > MAX_SESSIONS) throw Error('inventory_too_large')
  const items = snapshots.filter(item => topLevel(item.header as unknown as Record<string, unknown>))
    .map(item => ({ sessionId: item.header.id as string, revision: item.revision as string }))
    .sort((left, right) => left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  if (items.some((item, index) => !validId(item.sessionId) || item.revision.length < 1
    || item.revision.length > 256 || index > 0 && item.sessionId === items[index - 1]?.sessionId))
    throw Error('invalid_inventory')
  return items
}

/** List bounded, sorted Session identities from this Profile only. */
export async function listDesktopMemorySessions(persistence: DesktopMemoryPersistence, after: string | null,
  signal: AbortSignal): Promise<DesktopMemorySessionPage> {
  signal.throwIfAborted()
  if (after !== null && !validId(after)) throw Error('invalid_cursor')
  const all = await inventory(persistence, signal)
  const start = after === null ? 0 : all.findIndex(item => item.sessionId > after)
  if (start < 0) return { items: [], nextAfter: null }
  const items = all.slice(start, start + PAGE_SIZE)
  return { items, nextAfter: start + PAGE_SIZE < all.length
    ? (items[PAGE_SIZE - 1] as { sessionId: string }).sessionId : null }
}

/** Borrow one cold, durable logical view and refuse live or changing Sessions. */
export async function readDesktopMemorySession(persistence: DesktopMemoryPersistence, sessionId: string,
  signal: AbortSignal): Promise<DesktopMemorySessionSnapshot> {
  signal.throwIfAborted()
  if (!validId(sessionId)) throw Error('invalid_session')
  const before = (await inventory(persistence, signal)).find(item => item.sessionId === sessionId)
  if (!before) throw Error('session_unavailable')
  const borrowed = await persistence.borrowSession(SessionId(sessionId), signal)
  try {
    signal.throwIfAborted()
    if (borrowed.source !== 'prepared' || borrowed.revision !== before.revision
      || borrowed.inspection.meta.id !== sessionId
      || !topLevel(borrowed.inspection.meta as unknown as Record<string, unknown>)) throw Error('session_changed')
    const { meta, events } = borrowed.inspection
    if (events.length > MAX_EVENTS) throw Error('session_too_large')
    const bytes = Buffer.byteLength(JSON.stringify({ meta, events }), 'utf8')
    if (bytes > MAX_BYTES) throw Error('session_too_large')
    const after = (await inventory(persistence, signal)).find(item => item.sessionId === sessionId)
    if (!after || after.revision !== before.revision) throw Error('session_changed')
    signal.throwIfAborted()
    return { sessionId, revision: before.revision, meta, events }
  } finally {
    borrowed[Symbol.dispose]()
  }
}

function parsePage(value: unknown): DesktopMemorySessionPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_result')
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE) throw Error('invalid_result')
  const items = page.items.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('invalid_result')
    const item = entry as Record<string, unknown>
    if (!validId(item.sessionId) || typeof item.revision !== 'string' || item.revision.length < 1
      || item.revision.length > 256) throw Error('invalid_result')
    return { sessionId: item.sessionId, revision: item.revision }
  })
  if (page.nextAfter !== null && !validId(page.nextAfter)) throw Error('invalid_result')
  return { items, nextAfter: page.nextAfter }
}

function parseSnapshot(value: unknown): DesktopMemorySessionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_result')
  const snapshot = value as Record<string, unknown>
  if (!validId(snapshot.sessionId) || typeof snapshot.revision !== 'string'
    || snapshot.revision.length < 1 || snapshot.revision.length > 256
    || !Array.isArray(snapshot.events) || snapshot.events.length > MAX_EVENTS
    || !snapshot.meta || typeof snapshot.meta !== 'object' || Array.isArray(snapshot.meta)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) throw Error('invalid_result')
  return { sessionId: snapshot.sessionId, revision: snapshot.revision,
    meta: snapshot.meta, events: snapshot.events }
}

/** Authenticate and serve one Profile inventory page to the parent Host. */
export function handleDesktopMemorySessionsRequest(req: IncomingMessage, res: ServerResponse,
  token: string, persistence: DesktopMemoryPersistence): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => listDesktopMemorySessions(persistence, target.after, signal),
    (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_input')
      const target = value as Record<string, unknown>
      if (Object.keys(target).length !== 1 || target.after !== null && !validId(target.after))
        throw Error('invalid_input')
      return { after: target.after as string | null }
    }, parsePage, () => true, 2048)
}

/** Authenticate and serve one logical Session view to the parent Host. */
export function handleDesktopMemorySessionRequest(req: IncomingMessage, res: ServerResponse,
  token: string, persistence: DesktopMemoryPersistence): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => readDesktopMemorySession(persistence, target.sessionId, signal),
    (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_input')
      const target = value as Record<string, unknown>
      if (Object.keys(target).length !== 1 || !validId(target.sessionId)) throw Error('invalid_input')
      return { sessionId: target.sessionId }
    }, parseSnapshot, (result, target) => result.sessionId === target.sessionId, 2048)
}
