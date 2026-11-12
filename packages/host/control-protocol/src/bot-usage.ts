/** Bounded native read of the existing DS Bot usage ledger. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const HOUR = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3])$/u
const ZONE = /^[A-Za-z0-9_+./-]{1,64}$/u
const cursor = (value: unknown): value is string | null => value === null ||
  typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9_-]+$/u.test(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const count = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0
const COUNTS = ['input', 'cacheRead', 'cacheWrite', 'output', 'calls'] as const

/** Exact native range and page selector without a caller supplied Profile. */
export interface HostBotUsageRequest {
  readonly rangeDays: 7 | 30 | 90
  readonly timeZone: string
  readonly cursor: string | null
  readonly limit: number
}

/** One flattened hourly bucket with its owner and model labels. */
export interface HostBotUsageRow {
  readonly hour: string
  readonly owner: Readonly<{
    key: string
    kind: 'bot' | 'room' | 'agent' | 'other'
    id?: string
    name?: string
    deleted?: boolean
  }>
  readonly model: Readonly<{
    key: string
    provider: string
    model: string
    name: string
    providerName?: string
  }>
  readonly kind: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly calls: number
}

/** Bounded usage page and totals for the selected time range. */
export interface HostBotUsage {
  readonly rangeDays: 7 | 30 | 90
  readonly timeZone: string
  readonly now: string
  readonly scanning: boolean
  readonly totals: Readonly<{
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    calls: number
  }>
  readonly rows: readonly HostBotUsageRow[]
  readonly nextCursor: string | null
}

/** Validate a local usage selector.
 * @param value Untrusted remote UI request.
 * @returns Exact native usage request.
 */
export function parseHostBotUsageRequest(value: unknown): HostBotUsageRequest {
  if (!record(value) || !exact(value, ['rangeDays', 'timeZone', 'cursor', 'limit']) ||
    value.rangeDays !== 7 && value.rangeDays !== 30 && value.rangeDays !== 90 ||
    !text(value.timeZone, 64) || !ZONE.test(value.timeZone) ||
    !cursor(value.cursor) || !count(value.limit) ||
    value.limit < 1 || value.limit > 40) throw Error('invalid_bot_usage_request')
  try { new Intl.DateTimeFormat('en-CA', { timeZone: value.timeZone }) }
  catch { throw Error('invalid_bot_usage_request') }
  return { rangeDays: value.rangeDays, timeZone: value.timeZone,
    cursor: value.cursor, limit: value.limit }
}

/** Validate a DS Bot usage page against its selected range.
 * @param value Untrusted plugin result.
 * @param request The exact range and page selector.
 * @returns Bounded usage, or null when DS Bot has no usage reader.
 */
export function parseHostBotUsage(value: unknown, request: HostBotUsageRequest): HostBotUsage | null {
  if (value === null) return null
  if (!record(value) || !exact(value,
    ['rangeDays', 'timeZone', 'now', 'scanning', 'totals', 'rows', 'nextCursor']) ||
    value.rangeDays !== request.rangeDays || value.timeZone !== request.timeZone ||
    !text(value.now, 13) || !HOUR.test(value.now) ||
    typeof value.scanning !== 'boolean' || !cursor(value.nextCursor) ||
    !record(value.totals) || !exact(value.totals, COUNTS) ||
    !Array.isArray(value.rows) || value.rows.length > request.limit) throw Error('invalid_bot_usage_result')
  const totals = value.totals as Record<string, unknown>
  if (!COUNTS.every(key => count(totals[key]))) throw Error('invalid_bot_usage_result')
  const rows: HostBotUsageRow[] = []
  for (const item of value.rows) {
    if (!record(item) || !exact(item,
      ['hour', 'owner', 'model', 'kind', ...COUNTS]) ||
      !text(item.hour, 13) || !HOUR.test(item.hour) ||
      !record(item.owner) || !record(item.model) ||
      !(exact(item.owner, ['key', 'kind']) ||
        exact(item.owner, ['key', 'kind', 'id']) ||
        exact(item.owner, ['key', 'kind', 'name']) ||
        exact(item.owner, ['key', 'kind', 'deleted']) ||
        exact(item.owner, ['key', 'kind', 'id', 'name']) ||
        exact(item.owner, ['key', 'kind', 'id', 'deleted']) ||
        exact(item.owner, ['key', 'kind', 'name', 'deleted']) ||
        exact(item.owner, ['key', 'kind', 'id', 'name', 'deleted'])) ||
      !text(item.owner.key, 256) ||
      !['bot', 'room', 'agent', 'other'].includes(item.owner.kind as string) ||
      (item.owner.id !== undefined && !text(item.owner.id, 256)) ||
      (item.owner.name !== undefined && !text(item.owner.name, 200)) ||
      (item.owner.deleted !== undefined && typeof item.owner.deleted !== 'boolean') ||
      !(exact(item.model, ['key', 'provider', 'model', 'name']) ||
        exact(item.model, ['key', 'provider', 'model', 'name', 'providerName'])) ||
      !text(item.model.key, 256) || !text(item.model.provider, 128) ||
      !text(item.model.model, 128) || !text(item.model.name, 200) ||
      (item.model.providerName !== undefined && !text(item.model.providerName, 200)) ||
      !text(item.kind, 80) || !COUNTS.every(key => count(item[key]))) {
      throw Error('invalid_bot_usage_result')
    }
    const owner = item.owner as Record<string, unknown>
    const model = item.model as Record<string, unknown>
    rows.push({ hour: item.hour as string,
      owner: { key: owner.key as string, kind: owner.kind as HostBotUsageRow['owner']['kind'],
        ...(owner.id === undefined ? {} : { id: owner.id as string }),
        ...(owner.name === undefined ? {} : { name: owner.name as string }),
        ...(owner.deleted === undefined ? {} : { deleted: owner.deleted as boolean }) },
      model: { key: model.key as string, provider: model.provider as string,
        model: model.model as string, name: model.name as string,
        ...(model.providerName === undefined ? {} : { providerName: model.providerName as string }) },
      kind: item.kind as string, input: item.input as number,
      cacheRead: item.cacheRead as number, cacheWrite: item.cacheWrite as number,
      output: item.output as number, calls: item.calls as number })
  }
  const result: HostBotUsage = { rangeDays: request.rangeDays, timeZone: request.timeZone,
    now: value.now, scanning: value.scanning,
    totals: { input: totals.input as number, cacheRead: totals.cacheRead as number,
      cacheWrite: totals.cacheWrite as number, output: totals.output as number,
      calls: totals.calls as number },
    rows, nextCursor: value.nextCursor }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32_768)
    throw Error('invalid_bot_usage_result')
  return result
}
