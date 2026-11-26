import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { createHash } from 'node:crypto'

/** Host-private decoded evidence; only its schema and digest may enter public diagnostics. */
export type BotUpgradeState = Readonly<{
  schema: 'empty' | 'v1'
  digest: string
  value?: Readonly<Record<string, unknown>>
}>

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !['__proto__', 'prototype', 'constructor'].includes(value)
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)

/** Reject values the released reader would silently reset, prune or coerce. */
function validate(value: unknown): asserts value is Record<string, unknown> {
  if (!object(value) || value.version !== 1) throw new ProfileUpgradeFailure('bot_upgrade_schema_unsupported')
  if (Object.hasOwn(value, '__proto__')) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  const safe = (input: unknown, depth: number): void => {
    if (depth > 64) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
    if (object(input)) {
      for (const child of Object.values(input)) safe(child, depth + 1)
    } else if (Array.isArray(input)) for (const child of input) safe(child, depth + 1)
  }
  safe(value, 0)
  if (!object(value.bots) || !object(value.rooms) || !Array.isArray(value.mainBotIds) || !value.mainBotIds.every(id)
    || 'revision' in value && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  for (const key of ['agents', 'capabilities', 'prefs', 'works', 'questions', 'views', 'switching',
    'nativeScheduleRequests', 'nativeMemoryRequests', 'externalGroup']) {
    if (key in value && !object(value[key])) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  }
  if ('exchanges' in value && !Array.isArray(value.exchanges)) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  for (const [key, bot] of Object.entries(value.bots)) {
    if (!id(key) || !object(bot) || 'id' in bot && bot.id !== key
      || 'capabilities' in bot && !Array.isArray(bot.capabilities)
      || 'segments' in bot && !Array.isArray(bot.segments)) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  }
  for (const [key, room] of Object.entries(value.rooms)) {
    if (!id(key) || !object(room) || 'id' in room && room.id !== key
      || !Array.isArray(room.members) || !room.members.every(id)
      || 'log' in room && !Array.isArray(room.log)) throw new ProfileUpgradeFailure('bot_upgrade_data_malformed')
  }
}

/** Decode a bounded, zero-write source inventory. Absence alone is empty; malformed bytes are never empty.
 * @param bytes Owner-read source bytes, or undefined for an absent file.
 * @returns Private schema evidence, not a promise that every v1 instance can be migrated.
 */
export function inspectBotUpgradeState(bytes: Uint8Array | undefined): BotUpgradeState {
  if (bytes === undefined) return { schema: 'empty', digest: createHash('sha256').update('absent').digest('hex') }
  if (bytes.byteLength > 16 * 1024 * 1024) throw new ProfileUpgradeFailure('bot_upgrade_data_too_large')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new ProfileUpgradeFailure('bot_upgrade_data_malformed') }
  validate(value)
  return { schema: 'v1', digest: createHash('sha256').update(canonical(value)).digest('hex'), value }
}

/** Require additive conversion until an explicit, tested field migration is declared.
 * @param source Immutable source inventory.
 * @param converted Target-reader result obtained only in an isolated copy.
 * @returns Nothing; missing or altered source fields prevent any live switch.
 */
export function assertBotUpgradePreserved(source: BotUpgradeState, converted: BotUpgradeState): void {
  if (source.schema === 'empty') return
  if (converted.schema !== 'v1' || !source.value || !converted.value) throw new ProfileUpgradeFailure('bot_upgrade_data_loss')
  const preserves = (before: unknown, after: unknown, path: readonly string[]): boolean => {
    if (Array.isArray(before)) return Array.isArray(after) && before.length === after.length
      && before.every((entry, index) => preserves(entry, after[index], [...path, String(index)]))
    if (object(before)) return object(after) && Object.entries(before).every(([key, value]) =>
      Object.hasOwn(after, key) && (path.length === 0 && key === 'revision'
        ? Number.isSafeInteger(after[key]) && (after[key] as number) >= (value as number)
        : preserves(value, after[key], [...path, key])))
    return before === after
  }
  if (!preserves(source.value, converted.value, [])) throw new ProfileUpgradeFailure('bot_upgrade_data_loss')
}
