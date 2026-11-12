/** Fixed native About status, sourced from the existing DS Bot and DSH updaters. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** A native check can explicitly refresh the Host's cached update status. */
export interface HostBotAboutRequest { readonly fresh: boolean }
/** Public state of one updater, with raw installer errors removed. */
export interface HostBotAboutUpdater {
  readonly current: string | null
  readonly checkedAt: number
  readonly phase: 'idle' | 'installing' | 'installed' | 'failed'
  readonly installed: string | null
  readonly error: 'update_failed' | null
  readonly available: boolean
}
/** Exact information shown by the native About page. */
export interface HostBotAbout {
  readonly bot: HostBotAboutUpdater & Readonly<{
    name: string
    current: string
    latest: string | null
    source: string
    notesUrl: string | null
    repoUrl: string | null
    enabled: boolean
  }>
  readonly dsh: (HostBotAboutUpdater & Readonly<{
    verified: string | null
    kind: 'app' | 'npm'
    blockedBy: string | null
  }>) | null
}
const bytes = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const optional = (value: unknown, max: number): value is string | null => value === null || bytes(value, max)
const url = (value: unknown): value is string | null => value === null ||
  bytes(value, 512) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.*)?$/u.test(value)
const stamp = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0
const phase = (value: unknown): value is HostBotAboutUpdater['phase'] =>
  value === 'idle' || value === 'installing' || value === 'installed' || value === 'failed'
const updater = (value: Record<string, unknown>): value is Record<string, unknown> & HostBotAboutUpdater =>
  optional(value.current, 80) && stamp(value.checkedAt) &&
  phase(value.phase) && optional(value.installed, 80) &&
  (value.error === null || value.error === 'update_failed') && typeof value.available === 'boolean'

/**
 * Validate a native About selector without accepting an injected Profile identity.
 * @param value - Untrusted remote UI selector.
 * @returns The explicit refresh choice.
 */
export function parseHostBotAboutRequest(value: unknown): HostBotAboutRequest {
  if (!record(value) || !exact(value, ['fresh']) || typeof value.fresh !== 'boolean')
    throw Error('invalid_bot_about_request')
  return { fresh: value.fresh }
}

/**
 * Correlate and project the Host updater states before they cross the mobile transport.
 * @param value - Untrusted result of the DS Bot service.
 * @returns Fixed About status, or null if the service is unavailable.
 */
export function parseHostBotAbout(value: unknown): HostBotAbout | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['bot', 'dsh']) || !record(value.bot) ||
    !exact(value.bot, ['name', 'current', 'latest', 'source', 'notesUrl', 'repoUrl',
      'enabled', 'checkedAt', 'phase', 'installed', 'error', 'available']) ||
    !updater(value.bot) || !bytes(value.bot.name, 100) || !bytes(value.bot.current, 80) ||
    !optional(value.bot.latest, 80) ||
    !bytes(value.bot.source, 40) || !url(value.bot.notesUrl) || !url(value.bot.repoUrl) ||
    typeof value.bot.enabled !== 'boolean') throw Error('invalid_bot_about_result')
  const bot: HostBotAbout['bot'] = {
    name: value.bot.name, current: value.bot.current, latest: value.bot.latest,
    source: value.bot.source, notesUrl: value.bot.notesUrl, repoUrl: value.bot.repoUrl,
    enabled: value.bot.enabled, checkedAt: value.bot.checkedAt, phase: value.bot.phase,
    installed: value.bot.installed, error: value.bot.error, available: value.bot.available,
  }
  let dsh: HostBotAbout['dsh'] = null
  if (value.dsh !== null) {
    if (!record(value.dsh) || !exact(value.dsh, ['current', 'verified', 'kind', 'blockedBy',
      'checkedAt', 'phase', 'installed', 'error', 'available']) || !updater(value.dsh) ||
      !optional(value.dsh.verified, 80) || !optional(value.dsh.blockedBy, 80) ||
      value.dsh.kind !== 'app' && value.dsh.kind !== 'npm') throw Error('invalid_bot_about_result')
    dsh = { current: value.dsh.current, verified: value.dsh.verified,
      kind: value.dsh.kind, blockedBy: value.dsh.blockedBy,
      checkedAt: value.dsh.checkedAt, phase: value.dsh.phase, installed: value.dsh.installed,
      error: value.dsh.error, available: value.dsh.available }
  }
  const result = { bot, dsh }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4_096) throw Error('invalid_bot_about_result')
  return result
}
