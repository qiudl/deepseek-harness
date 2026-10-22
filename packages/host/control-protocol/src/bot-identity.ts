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
