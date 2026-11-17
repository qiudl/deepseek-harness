/** Native About update install and durable status lookup under a controlled Bot Session. */
import { botExactKeys as exact, botRecord as record,
  botMutationId as botId, botMutationSessionId as sessionId } from './bot-value-shape.js'

const requestId = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
const version = (value: unknown): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= 80 && /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(value)

/** An installation request or a lookup using the same durable request ID. */
export type HostBotUpdateMutationRequest =
  | { readonly mode: 'start'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly target: 'bot' | 'dsh'
    readonly version: string }
  | { readonly mode: 'status'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly target: 'bot' | 'dsh' }

/** Receipt persisted by DS Bot, with no private installer details. */
export interface HostBotUpdateMutationReceipt {
  readonly requestId: string
  readonly target: 'bot' | 'dsh' | null
  readonly version: string | null
  readonly state: 'pending' | 'installing' | 'installed' | 'failed' |
    'conflict' | 'unavailable' | 'unknown'
}

/** Validate one native update request before it enters the Host control channel.
 * @param value - Untrusted command request.
 * @returns Bounded request tied to a Bot Session.
 */
export function parseHostBotUpdateMutationRequest(value: unknown): HostBotUpdateMutationRequest {
  if (!record(value) || !botId(value.ownerBotId) || !sessionId(value.sessionId) ||
    !requestId(value.requestId) || !['bot', 'dsh'].includes(String(value.target)))
    throw Error('invalid_bot_update_mutation')
  if (value.mode === 'status' && exact(value,
    ['mode', 'ownerBotId', 'sessionId', 'requestId', 'target']))
    return value as HostBotUpdateMutationRequest
  if (value.mode === 'start' && exact(value,
    ['mode', 'ownerBotId', 'sessionId', 'requestId', 'target', 'version']) && version(value.version))
    return value as HostBotUpdateMutationRequest
  throw Error('invalid_bot_update_mutation')
}

/** Correlate DS Bot's update receipt with its original request.
 * @param value - Untrusted Host result.
 * @param request - Validated mutation request.
 * @returns Safe receipt or null when the Host service is unavailable.
 */
export function parseHostBotUpdateMutationReceipt(value: unknown,
  request: HostBotUpdateMutationRequest): HostBotUpdateMutationReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['requestId', 'target', 'version', 'state']) ||
    value.requestId !== request.requestId ||
    !['pending', 'installing', 'installed', 'failed', 'conflict', 'unavailable', 'unknown']
      .includes(String(value.state)) ||
    (value.target !== null && value.target !== request.target) ||
    (value.version !== null && !version(value.version)) ||
    (value.state === 'unknown' ? value.target !== null || value.version !== null :
      value.target !== request.target || value.version === null) ||
    (request.mode === 'start' && value.state !== 'unknown' && value.version !== request.version))
    throw Error('invalid_bot_update_mutation_receipt')
  const state = value.state as HostBotUpdateMutationReceipt['state']
  return { requestId: request.requestId, target: value.target as HostBotUpdateMutationReceipt['target'],
    version: value.version, state }
}
