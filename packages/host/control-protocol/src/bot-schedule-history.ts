/** One bounded page of durable ScheduleService inbox acknowledgments. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

export interface HostBotScheduleHistoryRequest {
  readonly sessionId: string
  readonly id: string
  readonly limit: number
  readonly before: string | null
}
export interface HostBotScheduleHistoryRecord {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
  readonly prompt: string | null
}
export interface HostBotScheduleHistory {
  readonly available: boolean
  readonly sessionId: string
  readonly id: string
  readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' | null
  readonly records: readonly HostBotScheduleHistoryRecord[]
  readonly nextBefore: string | null
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned: boolean
  readonly retention: { readonly days: number; readonly records: number } | null
}
const bytes = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const id = (value: unknown, max: number): value is string => bytes(value, max) && value.length > 0
const message = (value: unknown): value is string => id(value, 256) && /^[!-~]+$/u.test(value)
const instant = (value: unknown): value is string => bytes(value, 40) && !Number.isNaN(Date.parse(value))

/** Validate an exact task selector before crossing the Profile boundary. */
export function parseHostBotScheduleHistoryRequest(value: unknown): HostBotScheduleHistoryRequest {
  if (!record(value) || !exact(value, ['sessionId', 'id', 'limit', 'before']) ||
    !id(value.sessionId, 256) || !id(value.id, 200) ||
    typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) ||
    value.limit < 1 || value.limit > 20 ||
    value.before !== null && !message(value.before)) throw Error('invalid_bot_schedule_history_request')
  return { sessionId: value.sessionId, id: value.id, limit: value.limit, before: value.before }
}

/** Correlate a Profile response to its exact task and project allowed fields. */
export function parseHostBotScheduleHistory(value: unknown,
  request: HostBotScheduleHistoryRequest): HostBotScheduleHistory | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['available', 'sessionId', 'id', 'code', 'records',
    'nextBefore', 'earlierRecordsUnavailable', 'earlierRecordsPruned', 'retention']) ||
    typeof value.available !== 'boolean' || value.sessionId !== request.sessionId ||
    value.id !== request.id || !Array.isArray(value.records) ||
    value.records.length > request.limit ||
    value.nextBefore !== null && !message(value.nextBefore) ||
    typeof value.earlierRecordsUnavailable !== 'boolean' ||
    typeof value.earlierRecordsPruned !== 'boolean' ||
    value.code !== null && value.code !== 'schedule_not_found' &&
      value.code !== 'delivery_cursor_not_found') throw Error('invalid_bot_schedule_history_result')
  const records: HostBotScheduleHistoryRecord[] = []
  for (const item of value.records) {
    if (!record(item) || !exact(item, ['scheduledAt', 'deliveredAt', 'messageId', 'prompt']) ||
      !instant(item.scheduledAt) || !instant(item.deliveredAt) || !message(item.messageId) ||
      item.prompt !== null && !bytes(item.prompt, 16_000)) throw Error('invalid_bot_schedule_history_result')
    records.push({ scheduledAt: item.scheduledAt, deliveredAt: item.deliveredAt,
      messageId: item.messageId, prompt: item.prompt })
  }
  if (value.code !== null || !value.available) {
    if (records.length || value.nextBefore !== null || value.retention !== null ||
      value.earlierRecordsUnavailable || value.earlierRecordsPruned ||
      !value.available && value.code !== null || value.available && value.code === null)
      throw Error('invalid_bot_schedule_history_result')
    return { available: value.available, sessionId: request.sessionId, id: request.id,
      code: value.code, records: [], nextBefore: null,
      earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: null }
  }
  if (!record(value.retention) || !exact(value.retention, ['days', 'records']) ||
    typeof value.retention.days !== 'number' || !Number.isSafeInteger(value.retention.days) ||
    value.retention.days < 1 || value.retention.days > 3650 ||
    typeof value.retention.records !== 'number' || !Number.isSafeInteger(value.retention.records) ||
    value.retention.records < 1 || value.retention.records > 10_000 ||
    value.nextBefore !== null && (records.length === 0 ||
      value.nextBefore !== records.at(-1)?.messageId) ||
    new Set(records.map(item => item.messageId)).size !== records.length ||
    request.before !== null && records.some(item => item.messageId === request.before))
    throw Error('invalid_bot_schedule_history_result')
  return { available: true, sessionId: request.sessionId, id: request.id,
    code: null, records, nextBefore: value.nextBefore,
    earlierRecordsUnavailable: value.earlierRecordsUnavailable,
    earlierRecordsPruned: value.earlierRecordsPruned,
    retention: { days: value.retention.days, records: value.retention.records } }
}
