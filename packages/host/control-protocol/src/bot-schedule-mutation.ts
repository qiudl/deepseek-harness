/** Native Bot schedule writes and durable result lookup under a controlled Bot Session. */
import { botExactKeys as exact, botRecord as record,
  botMutationId as botId, botMutationSessionId as sessionId } from './bot-value-shape.js'

const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const requestId = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
const time = (value: unknown): value is string => typeof value === 'string' &&
  /^([01]\d|2[0-3]):[0-5]\d$/u.test(value)

type ScheduleWhen = Readonly<
  { kind: 'at'; at: string } | { kind: 'every'; minutes: number } |
  { kind: 'daily'; time: string; timeZone: string } |
  { kind: 'weekly'; time: string; timeZone: string; weekdays: readonly number[] }>

/** A create, delete, or status query tied to an owner Bot Session. */
export type HostBotScheduleMutationRequest =
  | { readonly mode: 'create'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly targetKind: 'bot' | 'room'
    readonly targetId: string
    readonly title: string
    readonly prompt: string
    readonly when: ScheduleWhen }
  | { readonly mode: 'delete'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string
    readonly taskSessionId: string
    readonly taskId: string }
  | { readonly mode: 'status'
    readonly ownerBotId: string
    readonly sessionId: string
    readonly requestId: string }

/** Result retained by DS Bot for a mutation request. */
export interface HostBotScheduleMutationReceipt {
  readonly requestId: string
  readonly operation: 'create' | 'delete' | null
  readonly state: 'pending' | 'created' | 'deleted' | 'missing' | 'failed' | 'unavailable' | 'unknown'
  readonly taskId: string | null
  readonly sessionId: string | null
}

function parseWhen(value: unknown): ScheduleWhen {
  if (!record(value)) throw Error('invalid_bot_schedule_mutation')
  if (value.kind === 'at' && exact(value, ['kind', 'at']) && bounded(value.at, 40) &&
    !Number.isNaN(Date.parse(value.at))) return value as ScheduleWhen
  if (value.kind === 'every' && exact(value, ['kind', 'minutes']) &&
    Number.isSafeInteger(value.minutes) && Number(value.minutes) >= 1 &&
    Number(value.minutes) <= 10080) return value as ScheduleWhen
  if ((value.kind === 'daily' || value.kind === 'weekly') &&
    exact(value, value.kind === 'daily' ? ['kind', 'time', 'timeZone'] :
      ['kind', 'time', 'timeZone', 'weekdays']) && time(value.time) &&
    bounded(value.timeZone, 256) && value.timeZone.length > 0) {
    if (value.kind === 'daily') return value as ScheduleWhen
    if (Array.isArray(value.weekdays) && value.weekdays.length >= 1 && value.weekdays.length <= 7 &&
      value.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7) &&
      new Set(value.weekdays).size === value.weekdays.length) return value as ScheduleWhen
  }
  throw Error('invalid_bot_schedule_mutation')
}

/** Validate a complete native schedule request before it enters the Host control channel.
 * @param value - Untrusted command request.
 * @returns Bounded request with its durable identity.
 */
export function parseHostBotScheduleMutationRequest(value: unknown): HostBotScheduleMutationRequest {
  if (!record(value) || !botId(value.ownerBotId) || !sessionId(value.sessionId) ||
    !requestId(value.requestId)) throw Error('invalid_bot_schedule_mutation')
  if (value.mode === 'status' && exact(value, ['mode', 'ownerBotId', 'sessionId', 'requestId']))
    return value as HostBotScheduleMutationRequest
  if (value.mode === 'delete' && exact(value, ['mode', 'ownerBotId', 'sessionId',
    'requestId', 'taskSessionId', 'taskId']) && sessionId(value.taskSessionId) &&
    bounded(value.taskId, 200) && value.taskId.length > 0)
    return value as HostBotScheduleMutationRequest
  if (value.mode === 'create' && exact(value, ['mode', 'ownerBotId', 'sessionId',
    'requestId', 'targetKind', 'targetId', 'title', 'prompt', 'when']) &&
    (value.targetKind === 'bot' && botId(value.targetId) ||
      value.targetKind === 'room' && sessionId(value.targetId)) &&
    bounded(value.title, 512) && value.title.length > 0 && value.title.length <= 120 &&
    value.title.trim() === value.title && bounded(value.prompt, 16000) &&
    value.prompt.trim().length > 0 && value.prompt.trim() === value.prompt) {
    parseWhen(value.when)
    return value as HostBotScheduleMutationRequest
  }
  throw Error('invalid_bot_schedule_mutation')
}

/** Validate and correlate a DS Bot receipt with the original request.
 * @param value - Untrusted Host result.
 * @param request - Validated mutation request.
 * @returns The receipt, or null when the Host service is unavailable.
 */
export function parseHostBotScheduleMutationReceipt(value: unknown,
  request: HostBotScheduleMutationRequest): HostBotScheduleMutationReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['requestId', 'operation', 'state', 'taskId', 'sessionId']) ||
    value.requestId !== request.requestId ||
    value.operation !== 'create' && value.operation !== 'delete' && value.operation !== null ||
    !['pending', 'created', 'deleted', 'missing', 'failed', 'unavailable', 'unknown'].includes(String(value.state)) ||
    (value.taskId !== null && (!bounded(value.taskId, 200) || !value.taskId)) ||
    (value.sessionId !== null && !sessionId(value.sessionId)) ||
    (value.state === 'unknown' ? value.operation !== null : value.operation === null) ||
    (request.mode !== 'status' && value.operation !== request.mode) ||
    (value.state === 'created' && (value.operation !== 'create' || value.taskId === null || value.sessionId === null)) ||
    (value.state === 'deleted' && value.operation !== 'delete') ||
    (request.mode === 'delete' && (value.taskId !== request.taskId ||
      value.sessionId !== request.taskSessionId))) throw Error('invalid_bot_schedule_mutation_receipt')
  return value as unknown as HostBotScheduleMutationReceipt
}
