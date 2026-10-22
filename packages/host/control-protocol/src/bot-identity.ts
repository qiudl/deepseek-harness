/** Bounded identity returned by a Profile-local Bot plugin; no chat content crosses the Host. */
export interface HostBotIdentity {
  readonly bot_id: string
  readonly actor_ref: string
  readonly display_name: string
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
  if (identities.some((bot, index) => index > 0 && bot.bot_id <= (identities[index - 1]?.bot_id ?? '')) ||
    (item.next_cursor !== null && item.next_cursor !== identities.at(-1)?.bot_id))
    throw Error('invalid_bot_roster_page')
  return { bots: identities, next_cursor: item.next_cursor }
}
