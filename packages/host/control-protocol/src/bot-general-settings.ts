/** Versioned native access to the team's existing appearance preferences. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const theme = (value: unknown): value is string => bounded(value, 32) && /^[a-z][\w-]{0,31}$/u.test(value)
const accent = (value: unknown): value is string | null => value === null ||
  bounded(value, 7) && /^#[0-9a-f]{6}$/iu.test(value)
const motion = (value: unknown): value is 'quiet' | 'normal' | 'lively' =>
  value === 'quiet' || value === 'normal' || value === 'lively'
const width = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 50 && value <= 100
const revision = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0
const botId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const sessionId = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'

/** Empty selector; the Host authenticates and selects the Profile. */
export type HostBotGeneralSettingsRequest = Readonly<Record<string, never>>
/** Saved shared preferences, with browser defaults projected explicitly. */
export interface HostBotGeneralSettings {
  readonly revision: number
  readonly theme: string
  readonly accent: string | null
  readonly motion: 'quiet' | 'normal' | 'lively'
  readonly width: number
}
/** One optimistic change to a shared preference. */
export type HostBotGeneralSettingsUpdateRequest = Readonly<{
  botId: string
  sessionId: string
  expectedRevision: number
  change: Readonly<
    | { kind: 'theme'; value: string }
    | { kind: 'accent'; value: string | null }
    | { kind: 'motion'; value: 'quiet' | 'normal' | 'lively' }
    | { kind: 'width'; value: number }
  >
}>
/** Applied or stale reply includes the latest saved preference snapshot. */
export type HostBotGeneralSettingsUpdateResult = Readonly<{
  state: 'applied' | 'stale'
  settings: HostBotGeneralSettings
}>

/** Parse an exact native general settings selector.
 * @param value Untrusted request arguments.
 * @returns Empty selector.
 */
export function parseHostBotGeneralSettingsRequest(value: unknown): HostBotGeneralSettingsRequest {
  if (!record(value) || !exact(value, [])) throw Error('invalid_bot_general_request')
  return {}
}

/** Capture the exact bounded preferences returned by DS Bot.
 * @param value Untrusted plugin result.
 * @returns Current settings or null when the plugin cannot serve them.
 */
export function parseHostBotGeneralSettings(value: unknown): HostBotGeneralSettings | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['revision', 'theme', 'accent', 'motion', 'width']) ||
    !revision(value.revision) || !theme(value.theme) || !accent(value.accent) ||
    !motion(value.motion) || !width(value.width)) throw Error('invalid_bot_general_result')
  return { revision: value.revision, theme: value.theme, accent: value.accent,
    motion: value.motion, width: value.width }
}

/** Parse one versioned preference edit.
 * @param value Untrusted control request.
 * @returns Exact change without a caller-selected Profile.
 */
export function parseHostBotGeneralSettingsUpdateRequest(value: unknown): HostBotGeneralSettingsUpdateRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'expectedRevision', 'change']) ||
    !botId(value.botId) || !sessionId(value.sessionId) ||
    !revision(value.expectedRevision) || !record(value.change) ||
    !exact(value.change, ['kind', 'value'])) throw Error('invalid_bot_general_update')
  const change = value.change
  if (change.kind === 'theme' && theme(change.value))
    return { botId: value.botId, sessionId: value.sessionId,
      expectedRevision: value.expectedRevision, change: { kind: 'theme', value: change.value } }
  if (change.kind === 'accent' && accent(change.value))
    return { botId: value.botId, sessionId: value.sessionId,
      expectedRevision: value.expectedRevision, change: { kind: 'accent', value: change.value } }
  if (change.kind === 'motion' && motion(change.value))
    return { botId: value.botId, sessionId: value.sessionId,
      expectedRevision: value.expectedRevision, change: { kind: 'motion', value: change.value } }
  if (change.kind === 'width' && width(change.value))
    return { botId: value.botId, sessionId: value.sessionId,
      expectedRevision: value.expectedRevision, change: { kind: 'width', value: change.value } }
  throw Error('invalid_bot_general_update')
}

/** Validate and capture the result of a native preference change.
 * @param value Untrusted plugin reply.
 * @returns Applied/stale result, or null when writer authority was lost.
 */
export function parseHostBotGeneralSettingsUpdateResult(value: unknown): HostBotGeneralSettingsUpdateResult | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['state', 'settings']) ||
    (value.state !== 'applied' && value.state !== 'stale')) throw Error('invalid_bot_general_update_result')
  const settings = parseHostBotGeneralSettings(value.settings)
  if (settings === null) throw Error('invalid_bot_general_update_result')
  return { state: value.state, settings }
}
