/** Idempotent Bot copy and status lookup under an authenticated Bot Session. */
import { botExactKeys as exact, botRecord as record,
  botMutationId as botId, botMutationSessionId as sessionId, botMutationRequestId as uuid, botMutationRevision as revision } from './bot-value-shape.js'

/** Idempotent copy request tied to an owner Bot Session. */
export interface HostBotDuplicateRequest {
  readonly sourceBotId: string
  readonly sessionId: string
  readonly copyRequestId: string
  readonly expectedRevision: number
  readonly mode: 'create' | 'status'
}
/** Correlated copy result, including a recoverable missing state. */
export interface HostBotDuplicateReceipt {
  readonly sourceBotId: string
  readonly copyRequestId: string
  readonly state: 'created' | 'stale' | 'missing'
  readonly botId: string | null
  readonly revision: number
}
/** Validate the source Bot, revision, and durable copy identity.
 * @param value - Untrusted request arguments.
 * @returns Bounded copy request.
 */
export function parseHostBotDuplicateRequest(value: unknown): HostBotDuplicateRequest {
  if (!record(value) || !exact(value, ['sourceBotId', 'sessionId', 'copyRequestId', 'expectedRevision', 'mode']) ||
    !botId(value.sourceBotId) || !sessionId(value.sessionId) || !uuid(value.copyRequestId) ||
    !revision(value.expectedRevision) || (value.mode !== 'create' && value.mode !== 'status'))
    throw Error('invalid_bot_duplicate')
  return { sourceBotId: value.sourceBotId, sessionId: value.sessionId,
    copyRequestId: value.copyRequestId, expectedRevision: value.expectedRevision, mode: value.mode }
}

/** Validate a copy result against its source and request identity.
 * @param value - Untrusted Host reply.
 * @param request - Captured copy request.
 * @returns Correlated receipt or null when unavailable.
 */
export function parseHostBotDuplicateReceipt(value: unknown,
  request: HostBotDuplicateRequest): HostBotDuplicateReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['sourceBotId', 'copyRequestId', 'state', 'botId', 'revision']) ||
    value.sourceBotId !== request.sourceBotId || value.copyRequestId !== request.copyRequestId ||
    !revision(value.revision) || value.revision < request.expectedRevision ||
    (value.state !== 'created' && value.state !== 'stale' && value.state !== 'missing') ||
    (value.state === 'created' ? !botId(value.botId) || value.botId === request.sourceBotId
      : value.botId !== null) ||
    (value.state === 'stale' && request.mode === 'status')) throw Error('invalid_bot_duplicate_receipt')
  return { sourceBotId: request.sourceBotId, copyRequestId: request.copyRequestId,
    state: value.state, botId: value.botId as string | null, revision: value.revision }
}
