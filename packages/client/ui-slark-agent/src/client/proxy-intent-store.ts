/** REQ-20261020-0010: preserve one owner proxy request key across a page reload. */
export type ProxyIntent = {
  operation: 'proxy_select' | 'proxy_replace'
  request_id: string
  expected_binding_epoch: number
  bot_id: string
} | { operation: 'proxy_unbind'; request_id: string; expected_binding_epoch: number; bot_id: null }

const key = (workspaceId: string, sessionId: string, groupId: string) =>
  `slark:proxy-intent:v1:${workspaceId}:${sessionId}:${groupId}`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const botId = /^[A-Za-z0-9_-]{1,200}$/u

/**
 * Reject forged or stale shapes before an old browser intent can be replayed.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Current Slark group identity.
 * @returns The exact pending owner request or null.
 */
export function readProxyIntent(workspaceId: string, sessionId: string, groupId: string): ProxyIntent | null {
  let raw: string | null
  try { raw = window.sessionStorage.getItem(key(workspaceId, sessionId, groupId)) }
  catch { return null }
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (Object.keys(item).length !== 4 ||
      (item.operation !== 'proxy_select' && item.operation !== 'proxy_replace' && item.operation !== 'proxy_unbind') ||
      typeof item.request_id !== 'string' || !uuid.test(item.request_id) ||
      !Number.isSafeInteger(item.expected_binding_epoch) || Number(item.expected_binding_epoch) < 0 ||
      (item.operation === 'proxy_unbind' ? item.bot_id !== null :
        typeof item.bot_id !== 'string' || !botId.test(item.bot_id))) return null
    return item as ProxyIntent
  } catch { return null }
}

/**
 * Persist before sending. If storage fails, the caller must keep the request unsent.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Current Slark group identity.
 * @param intent - Exact request and target to replay.
 * @returns Whether the request key was durably stored in this browser tab.
 */
export function writeProxyIntent(workspaceId: string, sessionId: string, groupId: string, intent: ProxyIntent): boolean {
  try { window.sessionStorage.setItem(key(workspaceId, sessionId, groupId), JSON.stringify(intent)); return true }
  catch { return false }
}

/**
 * Forget an owner request only after the authority returns its matching receipt.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Current Slark group identity.
 */
export function clearProxyIntent(workspaceId: string, sessionId: string, groupId: string): void {
  try { window.sessionStorage.removeItem(key(workspaceId, sessionId, groupId)) }
  catch { /* The server receipt remains authoritative; an old intent must not be reused blindly. */ }
}
