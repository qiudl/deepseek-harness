/** Revision-checked owner Bot profile change. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { parseHostBotSettings, type HostBotSettings } from './bot-settings.js'
import type { HostBotChatId } from './bot-chat.js'

/** One fixed profile field changes per command. */
export type HostBotSettingsUpdateChange =
  | { readonly kind: 'name' | 'role' | 'instructions' | 'model' | 'primary' | 'work-dir' | 'avatar-image'; readonly value: string }
  | { readonly kind: 'color' | 'avatar-shape' | 'effort'; readonly value: string | null }
  | { readonly kind: 'pinned' | 'hidden' | 'main'; readonly value: boolean }
  | { readonly kind: 'capability'; readonly value: Readonly<{ name: string; attached: boolean }> }
/** The Bot Session is verified separately by the Profile worker. */
export interface HostBotSettingsUpdateRequest {
  readonly botId: HostBotChatId
  readonly sessionId: string
  readonly expectedRevision: number
  readonly change: HostBotSettingsUpdateChange
}
/** Applied contains the saved profile; stale requires a fresh read. */
export interface HostBotSettingsUpdateReceipt {
  readonly botId: HostBotChatId
  readonly state: 'applied' | 'stale'
  readonly revision: number
  readonly settings: HostBotSettings | null
}
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max
const botIdValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const sessionValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const colorValid = (value: string) => /^(?:#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{0,63})$/u.test(value)
const noAsciiControl = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 31 || unit === 127) return false
  }
  return true
}

/** Parse an exact bounded edit before the Profile worker sees it.
 * @param value - Decoded command request.
 * @returns Validated edit.
 */
export function parseHostBotSettingsUpdateRequest(value: unknown): HostBotSettingsUpdateRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId', 'expectedRevision', 'change']) ||
    !botIdValid(value.botId) || !sessionValid(value.sessionId) ||
    typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 || !record(value.change) || !exact(value.change, ['kind', 'value']))
    throw Error('invalid_bot_settings_update')
  const { kind } = value.change, setting = value.change.value
  let change: HostBotSettingsUpdateChange
  if (kind === 'name' && bounded(setting, 512) && setting.length <= 40 && setting.trim() !== '' && setting === setting.trim())
    change = { kind, value: setting }
  else if (kind === 'role' && bounded(setting, 72) && setting.length <= 24 && setting === setting.trim())
    change = { kind, value: setting }
  else if (kind === 'model' && bounded(setting, 512) && setting === setting.trim() &&
    setting.includes('/') && noAsciiControl(setting))
    change = { kind, value: setting }
  else if (kind === 'primary' && botIdValid(setting))
    change = { kind, value: setting }
  else if (kind === 'work-dir' && bounded(setting, 4096) && setting === setting.trim() &&
    noAsciiControl(setting))
    change = { kind, value: setting }
  else if (kind === 'avatar-image' && bounded(setting, 30_000) &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(setting))
    change = { kind, value: setting }
  else if (kind === 'effort' && (setting === null || (bounded(setting, 128) && setting.length > 0 &&
    setting === setting.trim() && noAsciiControl(setting))))
    change = { kind, value: setting }
  else if (kind === 'instructions' && bounded(setting, 32768) && setting === setting.trim())
    change = { kind, value: setting }
  else if (kind === 'color' && (setting === null || (bounded(setting, 64) && colorValid(setting))))
    change = { kind, value: setting }
  else if (kind === 'avatar-shape' && (setting === null ||
    (typeof setting === 'string' && /^[a-z][\w-]{0,31}$/u.test(setting))))
    change = { kind, value: setting }
  else if ((kind === 'pinned' || kind === 'hidden' || kind === 'main') && typeof setting === 'boolean')
    change = { kind, value: setting }
  else if (kind === 'capability' && record(setting) && exact(setting, ['name', 'attached']) &&
    typeof setting.name === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(setting.name) &&
    setting.name.length <= 32 && setting.name !== 'github' && typeof setting.attached === 'boolean')
    change = { kind, value: { name: setting.name, attached: setting.attached } }
  else throw Error('invalid_bot_settings_update')
  return { botId: value.botId as HostBotChatId, sessionId: value.sessionId,
    expectedRevision: value.expectedRevision, change }
}

/** Correlate a plugin save result with the requested Bot and revision.
 * @param value - Untrusted plugin result.
 * @param request - Captured edit.
 * @returns Saved result or unavailable plugin.
 */
export function parseHostBotSettingsUpdateReceipt(value: unknown,
  request: HostBotSettingsUpdateRequest): HostBotSettingsUpdateReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['botId', 'state', 'revision', 'settings']) ||
    value.botId !== request.botId || (value.state !== 'applied' && value.state !== 'stale') ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) ||
    value.revision < request.expectedRevision ||
    (value.state === 'applied' && value.revision <= request.expectedRevision) ||
    (value.state === 'stale' && value.settings !== null))
    throw Error('invalid_bot_settings_update_receipt')
  let settings: HostBotSettings | null = null
  if (value.state === 'applied') {
    try { settings = parseHostBotSettings(value.settings, { botId: request.botId }) }
    catch { throw Error('invalid_bot_settings_update_receipt') }
    if (settings === null || settings.revision !== value.revision)
      throw Error('invalid_bot_settings_update_receipt')
  }
  return { botId: request.botId, state: value.state, revision: value.revision, settings }
}
