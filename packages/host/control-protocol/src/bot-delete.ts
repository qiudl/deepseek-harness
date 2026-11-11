/** Fixed owner Bot deletion under an authenticated, controlled Bot Session. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

export interface HostBotDeleteRequest {
  readonly botId: string
  readonly sessionId: string
  readonly expectedRevision: number
}
export interface HostBotDeleteReceipt {
  readonly botId: string
  readonly state: 'deleted' | 'stale' | 'missing'
  readonly revision: number
}
const botId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const sessionId = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const revision = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0

export function parseHostBotDeleteRequest(value: unknown): HostBotDeleteRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'expectedRevision']) ||
    !botId(value.botId) || !sessionId(value.sessionId) || !revision(value.expectedRevision))
    throw Error('invalid_bot_delete')
  return { botId: value.botId, sessionId: value.sessionId, expectedRevision: value.expectedRevision }
}

export function parseHostBotDeleteReceipt(value: unknown,
  request: HostBotDeleteRequest): HostBotDeleteReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['botId', 'state', 'revision']) ||
    value.botId !== request.botId || !revision(value.revision) ||
    (value.state !== 'deleted' && value.state !== 'stale' && value.state !== 'missing') ||
    (value.state === 'deleted' ? value.revision <= request.expectedRevision
      : value.state === 'missing' ? value.revision !== request.expectedRevision
        : value.revision < request.expectedRevision)) throw Error('invalid_bot_delete_receipt')
  return { botId: request.botId, state: value.state, revision: value.revision }
}
