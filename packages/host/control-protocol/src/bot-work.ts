/** Bounded, read-only Bot execution work projection for an authorized Profile. */
import { botMutationId as botId, botMutationSessionId as sessionId } from './bot-value-shape.js'

export interface HostBotWorkRequest { readonly cursor: string | null; readonly limit: number }

export interface HostBotWorkItem {
  readonly taskId: string
  readonly botId: string
  readonly sessionId: string
  readonly messageId: string
  readonly admissionEventSeq: number
  readonly instructionEventSeq: number | null
  readonly turn: number | null
  readonly terminalEventSeq: number | null
  readonly state: 'queued' | 'running' | 'reply_complete' | 'failed' | 'stopped' | 'unknown'
  readonly updatedAt: number
}

export type HostBotWork = {
  readonly schemaVersion: 1
  readonly state: 'loading' | 'unavailable' | 'snapshot_changed'
} | {
  readonly schemaVersion: 1
  readonly state: 'ready'
  readonly generation: number
  readonly total: number
  readonly items: readonly HostBotWorkItem[]
  readonly nextCursor: string | null
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const cursor = (value: unknown): value is string | null => value === null ||
  (typeof value === 'string' && value.length > 0 && value.length <= 400 && /^[A-Za-z0-9_-]+$/u.test(value))
const invalid = (): never => { throw Error('invalid_bot_work') }

/** Reject authority, Profile, Session and Bot selectors supplied by the caller. */
export function parseHostBotWorkRequest(value: unknown): HostBotWorkRequest {
  if (!record(value)) return invalid()
  if (!exact(value, ['cursor', 'limit']) || !cursor(value.cursor)
    || !integer(value.limit) || value.limit < 1 || value.limit > 50) return invalid()
  return { cursor: value.cursor as string | null, limit: value.limit as number }
}

/** Capture the whole worker result before it crosses the trusted Host boundary. */
export function parseHostBotWork(value: unknown, request: HostBotWorkRequest): HostBotWork | null {
  if (value === null) return null
  if (!record(value)) return invalid()
  if (value.schemaVersion !== 1 || typeof value.state !== 'string') return invalid()
  if (value.state === 'loading' || value.state === 'unavailable' || value.state === 'snapshot_changed') {
    if (!exact(value, ['schemaVersion', 'state'])) return invalid()
    return value as HostBotWork
  }
  if (value.state !== 'ready' || !exact(value, ['schemaVersion', 'state', 'generation', 'total', 'items', 'nextCursor'])
    || !integer(value.generation) || !integer(value.total) || !cursor(value.nextCursor)
    || !Array.isArray(value.items) || value.items.length > request.limit || value.total < value.items.length
    || (value.items.length === 0 && value.nextCursor !== null)) return invalid()
  const seen = new Set<string>()
  for (const item of value.items) {
    if (!record(item)) return invalid()
    if (!exact(item, ['taskId', 'botId', 'sessionId', 'messageId',
      'admissionEventSeq', 'instructionEventSeq', 'turn', 'terminalEventSeq', 'state', 'updatedAt'])
      || !digest(item.taskId) || !botId(item.botId) || !sessionId(item.sessionId)
      || typeof item.messageId !== 'string' || item.messageId.length < 1 || item.messageId.length > 256
      || !integer(item.admissionEventSeq)
      || (item.instructionEventSeq !== null && !integer(item.instructionEventSeq))
      || (item.turn !== null && (!integer(item.turn) || item.turn < 1))
      || (item.terminalEventSeq !== null && !integer(item.terminalEventSeq))
      || !['queued', 'running', 'reply_complete', 'failed', 'stopped', 'unknown'].includes(String(item.state))
      || !integer(item.updatedAt) || seen.has(item.taskId)) return invalid()
    seen.add(item.taskId)
  }
  return value as HostBotWork
}
