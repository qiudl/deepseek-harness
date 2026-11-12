/** Fixed owner Bot deletion under an authenticated, controlled Bot Session. */
import { botExactKeys as exact, botRecord as record,
  botMutationId as botId, botMutationSessionId as sessionId, botMutationRevision as revision } from './bot-value-shape.js'

/** Revision-bound deletion of one owner Bot. */
export interface HostBotDeleteRequest {
  readonly botId: string
  readonly sessionId: string
  readonly expectedRevision: number
}
/** Correlated deletion, stale, or missing result. */
export interface HostBotDeleteReceipt {
  readonly botId: string
  readonly state: 'deleted' | 'stale' | 'missing'
  readonly revision: number
}
/** Validate a deletion request and its owner Session.
 * @param value - Untrusted request arguments.
 * @returns Bounded deletion request.
 */
export function parseHostBotDeleteRequest(value: unknown): HostBotDeleteRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'expectedRevision']) ||
    !botId(value.botId) || !sessionId(value.sessionId) || !revision(value.expectedRevision))
    throw Error('invalid_bot_delete')
  return { botId: value.botId, sessionId: value.sessionId, expectedRevision: value.expectedRevision }
}

/** Validate the deletion result against the requested revision.
 * @param value - Untrusted Host reply.
 * @param request - Captured deletion request.
 * @returns Correlated receipt or null when unavailable.
 */
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
