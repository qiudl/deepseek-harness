/** REQ-20261020-0010: retain the exact owner decision request until its receipt is known. */
export type LeaveDecisionIntent = {
  request_id: string
  member_id: string
  member_cycle: number
  delivery_id: string
  decision: 'continue' | 'request_stop'
}

const key = (workspaceId: string, sessionId: string, groupId: string) =>
  `slark:leave-decision:v1:${workspaceId}:${sessionId}:${groupId}`
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/**
 * Read one unresolved decision for this original group.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Slark group identity.
 * @returns The exact pending decision, or null.
 */
export function readLeaveDecisionIntent(workspaceId: string, sessionId: string,
  groupId: string): LeaveDecisionIntent | null {
  try {
    const saved = window.sessionStorage.getItem(key(workspaceId, sessionId, groupId))
    if (saved === null) return null
    const value: unknown = JSON.parse(saved)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (Object.keys(item).length !== 5 || typeof item.request_id !== 'string' || !uuid.test(item.request_id) ||
      typeof item.member_id !== 'string' || !uuid.test(item.member_id) ||
      !Number.isSafeInteger(item.member_cycle) || Number(item.member_cycle) < 1 ||
      typeof item.delivery_id !== 'string' || !uuid.test(item.delivery_id) ||
      (item.decision !== 'continue' && item.decision !== 'request_stop')) return null
    return item as LeaveDecisionIntent
  } catch { return null }
}

/**
 * Save the request key before sending the owner decision.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Slark group identity.
 * @param intent - Exact decision to replay after an uncertain response.
 * @returns Whether the request was saved in this browser tab.
 */
export function writeLeaveDecisionIntent(workspaceId: string, sessionId: string,
  groupId: string, intent: LeaveDecisionIntent): boolean {
  try { window.sessionStorage.setItem(key(workspaceId, sessionId, groupId), JSON.stringify(intent)); return true }
  catch { return false }
}

/**
 * Remove a saved decision after its matching authority receipt.
 * @param workspaceId - Original workspace identity.
 * @param sessionId - Original Session identity.
 * @param groupId - Slark group identity.
 */
export function clearLeaveDecisionIntent(workspaceId: string, sessionId: string, groupId: string): void {
  try { window.sessionStorage.removeItem(key(workspaceId, sessionId, groupId)) }
  catch { /* The server receipt is authoritative. */ }
}
