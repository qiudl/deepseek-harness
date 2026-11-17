import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** A stable page selector for the authenticated Profile's Bot and group tasks. */
export interface HostBotSchedulesRequest {
  readonly cursor: string | null
  readonly limit: number
}

/** One task from the Profile's Automation tasks catalog. */
export interface HostBotSchedule {
  readonly id: string
  readonly sessionId: string
  readonly ownerKind: 'bot' | 'room'
  readonly ownerId: string
  readonly roomId: string | null
  readonly title: string
  readonly prompt: string
  readonly kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'
  readonly status: 'active' | 'inactive'
  readonly scheduledAt: string
  readonly timing: Record<string, string | number | number[]>
  readonly lastDelivery: { readonly scheduledAt: string
    readonly deliveredAt: string
    readonly messageId: string } | null
}

/** Bounded task catalog page; unavailable means Automation tasks is disabled. */
export interface HostBotSchedules {
  readonly available: boolean
  readonly total: number
  readonly tasks: HostBotSchedule[]
  readonly nextCursor: string | null
}

const bytes = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const nonempty = (value: unknown, max: number): value is string => bytes(value, max) && value.length > 0
const stamp = (value: unknown): value is string => bytes(value, 40) && !Number.isNaN(Date.parse(value))
const pageCursor = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{64}:[1-9][0-9]{0,5}$/u.test(value)

/** Validate the exact task page selector.
 * @param value - Untrusted remote UI arguments.
 * @returns The bounded selector.
 */
export function parseHostBotSchedulesRequest(value: unknown): HostBotSchedulesRequest {
  if (!record(value) || !exact(value, ['cursor', 'limit']) ||
    value.cursor !== null && !pageCursor(value.cursor) ||
    typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) ||
    value.limit < 1 || value.limit > 20) throw Error('invalid_bot_schedules_request')
  return { cursor: value.cursor, limit: value.limit }
}

function parseTiming(value: unknown, kind: HostBotSchedule['kind']): HostBotSchedule['timing'] {
  if (!record(value)) throw Error('invalid_bot_schedules_result')
  if (kind === 'after' || kind === 'every') {
    const key = kind === 'after' ? 'afterSeconds' : 'everySeconds'
    if (!exact(value, [key]) || typeof value[key] !== 'number' ||
      !Number.isSafeInteger(value[key]) || value[key] < (kind === 'after' ? 1 : 60)) throw Error('invalid_bot_schedules_result')
    return { [key]: value[key] }
  }
  if (kind === 'at') {
    if (!exact(value, [])) throw Error('invalid_bot_schedules_result')
    return {}
  }
  if (kind === 'cron') {
    if (!exact(value, ['expression', 'timeZone']) ||
      !nonempty(value.expression, 256) || !nonempty(value.timeZone, 256)) throw Error('invalid_bot_schedules_result')
    return { expression: value.expression, timeZone: value.timeZone }
  }
  if (!exact(value, kind === 'weekly' ? ['time', 'timeZone', 'weekdays'] : ['time', 'timeZone']) ||
    !nonempty(value.time, 20) || !nonempty(value.timeZone, 256)) throw Error('invalid_bot_schedules_result')
  if (kind === 'daily') return { time: value.time, timeZone: value.timeZone }
  if (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7 ||
    value.weekdays.some((day: unknown) => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(value.weekdays).size !== value.weekdays.length) throw Error('invalid_bot_schedules_result')
  return { time: value.time, timeZone: value.timeZone, weekdays: [...(value.weekdays as number[])] }
}

function parseTask(value: unknown): HostBotSchedule {
  if (!record(value) || !exact(value, ['id', 'sessionId', 'ownerKind', 'ownerId', 'roomId',
    'title', 'prompt', 'kind', 'status', 'scheduledAt', 'timing', 'lastDelivery']) ||
    !nonempty(value.id, 200) || !nonempty(value.sessionId, 256) ||
    (value.ownerKind !== 'bot' && value.ownerKind !== 'room') ||
    !nonempty(value.ownerId, 256) ||
    value.roomId !== null && !nonempty(value.roomId, 256) ||
    (value.ownerKind === 'room' && value.roomId !== value.ownerId) ||
    !nonempty(value.title, 512) || !bytes(value.prompt, 16000) ||
    !['after', 'at', 'every', 'daily', 'weekly', 'cron'].includes(String(value.kind)) ||
    (value.status !== 'active' && value.status !== 'inactive') || !stamp(value.scheduledAt)) throw Error('invalid_bot_schedules_result')
  const kind = value.kind as HostBotSchedule['kind']
  const timing = parseTiming(value.timing, kind)
  let lastDelivery: HostBotSchedule['lastDelivery'] = null
  if (value.lastDelivery !== null) {
    if (!record(value.lastDelivery) || !exact(value.lastDelivery, ['scheduledAt', 'deliveredAt', 'messageId']) ||
      !stamp(value.lastDelivery.scheduledAt) || !stamp(value.lastDelivery.deliveredAt) ||
      !nonempty(value.lastDelivery.messageId, 256)) throw Error('invalid_bot_schedules_result')
    lastDelivery = { scheduledAt: value.lastDelivery.scheduledAt,
      deliveredAt: value.lastDelivery.deliveredAt, messageId: value.lastDelivery.messageId }
  }
  return { id: value.id, sessionId: value.sessionId, ownerKind: value.ownerKind,
    ownerId: value.ownerId, roomId: value.roomId, title: value.title, prompt: value.prompt,
    kind, status: value.status, scheduledAt: value.scheduledAt, timing, lastDelivery }
}

/** Validate a plugin task page and its cursor continuity.
 * @param value - Untrusted plugin reply.
 * @param request - Captured page selector.
 * @returns The validated page or null when no Profile writer serves it.
 */
export function parseHostBotSchedules(value: unknown, request: HostBotSchedulesRequest): HostBotSchedules | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['available', 'total', 'tasks', 'nextCursor']) ||
    typeof value.available !== 'boolean' || typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 10000 ||
    !Array.isArray(value.tasks) || value.tasks.length > request.limit ||
    value.nextCursor !== null && !pageCursor(value.nextCursor)) throw Error('invalid_bot_schedules_result')
  if (!value.available) {
    if (value.total !== 0 || value.tasks.length !== 0 || value.nextCursor !== null) throw Error('invalid_bot_schedules_result')
    return { available: false, total: 0, tasks: [], nextCursor: null }
  }
  const tasks = value.tasks.map(parseTask)
  const offset = request.cursor === null ? 0 : Number(request.cursor.split(':')[1])
  if (offset > value.total || offset + tasks.length > value.total ||
    (offset < value.total && tasks.length === 0) ||
    (value.nextCursor === null) !== (offset + tasks.length === value.total)) throw Error('invalid_bot_schedules_result')
  if (value.nextCursor !== null &&
    (request.cursor !== null && request.cursor.split(':')[0] !== value.nextCursor.split(':')[0] ||
      Number(value.nextCursor.split(':')[1]) !== offset + tasks.length)) throw Error('invalid_bot_schedules_result')
  return { available: true, total: value.total, tasks, nextCursor: value.nextCursor }
}
