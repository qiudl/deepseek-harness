import type { HostProfileId } from './types.ts'

/** Bounded identity returned by a Profile-local Bot plugin; no chat content crosses the Host. */
export interface HostBotIdentity {
  readonly bot_id: string
  readonly actor_ref: string
  readonly display_name: string
}

/** Public Bot identity with the local Profile selected by the authenticated Host. */
export interface HostBotIdentityV2 extends HostBotIdentity {
  readonly host_profile_id: HostProfileId
}

/**
 * Validate the separate Profile-bearing response; v1 still accepts only three fields.
 * @param value - Untrusted Host control response.
 * @returns Public Bot and Host-local Profile coordinates, or absence.
 */
export function parseHostBotIdentityV2(value: unknown): HostBotIdentityV2 | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error('invalid_bot_identity_v2')
  const item = value as Record<string, unknown>
  const keys = ['bot_id', 'actor_ref', 'display_name', 'host_profile_id']
  if (Reflect.ownKeys(item).length !== keys.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(item, key)
    return !descriptor || !('value' in descriptor)
  }) || typeof item.host_profile_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.host_profile_id))
    throw Error('invalid_bot_identity_v2')
  const identity = parseHostBotIdentity({
    bot_id: item.bot_id, actor_ref: item.actor_ref, display_name: item.display_name,
  }) as HostBotIdentity
  return { ...identity, host_profile_id: item.host_profile_id as HostProfileId }
}

/**
 * Validate the exact Bot identity fields shared by the private worker and Host.
 * @param value - Untrusted worker response.
 * @returns Bounded public Bot identity or absence.
 */
export function parseHostBotIdentity(value: unknown): HostBotIdentity | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_bot_identity')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || !Object.hasOwn(item, 'bot_id')
    || !Object.hasOwn(item, 'actor_ref') || !Object.hasOwn(item, 'display_name')
    || typeof item.bot_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(item.bot_id)
    || item.actor_ref !== `deepseek-bot:${item.bot_id}`
    || typeof item.display_name !== 'string' || !item.display_name.trim()
    || Buffer.byteLength(item.display_name, 'utf8') > 512) throw Error('invalid_bot_identity')
  return { bot_id: item.bot_id, actor_ref: item.actor_ref, display_name: item.display_name }
}

/**
 * Validate a single caller-chosen Bot ID without accepting a Bot name or private chat ID.
 * @param value - Untrusted target object.
 * @returns Exact Bot ID target.
 */
export function parseHostBotIdentityTarget(value: unknown): { readonly bot_id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_target')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 1 || typeof item.bot_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/u.test(item.bot_id)) throw Error('invalid_bot_target')
  return { bot_id: item.bot_id }
}

/** One bounded page of public identities from the current Account Profile. */
export interface HostBotRosterPage {
  readonly bots: readonly HostBotIdentity[]
  readonly next_cursor: string | null
}

/**
 * Validate the only paging inputs allowed to cross the private Profile boundary.
 * @param value - Untrusted roster request target.
 * @returns Exact bounded cursor and page limit.
 */
export function parseHostBotRosterTarget(value: unknown): { readonly after_bot_id: string; readonly limit: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw Error('invalid_bot_roster_target')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 2 || typeof item.after_bot_id !== 'string' ||
    (item.after_bot_id !== '' && !/^[A-Za-z0-9_-]{1,200}$/u.test(item.after_bot_id)) ||
    !Number.isSafeInteger(item.limit) || Number(item.limit) < 1 || Number(item.limit) > 100)
    throw Error('invalid_bot_roster_target')
  return { after_bot_id: item.after_bot_id, limit: item.limit as number }
}

/**
 * Reject private fields, duplicate identities and forged continuation cursors.
 * @param value - Untrusted Profile worker roster response.
 * @returns Ordered public roster page, or absence when the worker has no roster.
 */
export function parseHostBotRosterPage(value: unknown): HostBotRosterPage | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_bot_roster_page')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 2 || !Array.isArray(item.bots) || item.bots.length > 100 ||
    (item.next_cursor !== null && typeof item.next_cursor !== 'string'))
    throw Error('invalid_bot_roster_page')
  const bots = item.bots.map(parseHostBotIdentity)
  if (bots.some(bot => bot === null)) throw Error('invalid_bot_roster_page')
  const identities = bots as HostBotIdentity[]
  if (identities.some((bot, index) => {
    const previousBotId = identities[index - 1]?.bot_id
    return previousBotId !== undefined && bot.bot_id <= previousBotId
  }) ||
    (item.next_cursor !== null && item.next_cursor !== identities.at(-1)?.bot_id))
    throw Error('invalid_bot_roster_page')
  return { bots: identities, next_cursor: item.next_cursor }
}
