/** Parent-owned request identity for one original Session group message. */
import type { DesktopCollaborationSourceInput } from './collaboration-source.ts'

/** Bounded group ledger commands and parent-owned pending key operations. */
export type GroupAgentMentionSpan = {
  mention_id: string
  actor_ref: string
  start: number
  end: number
  agent_name: string
  project_name: string
  capability_snapshot: string
}
export type GroupMessageCommand =
  | {
    operation: 'send'
    workspace_id: string
    session_id: string
    request_id: string
    expected_group_version: 2
    body: string
    mention_refs?: string[]
    mention_spans?: GroupAgentMentionSpan[]
  }
  | { operation: 'receipt'; workspace_id: string; session_id: string; request_id: string }
  | { operation: 'work-source'; workspace_id: string; session_id: string; message_id: string }
  | { operation: 'page'; workspace_id: string; session_id: string; after_seq: number; limit: number }
  | { operation: 'pending_claim'; workspace_id: string; session_id: string; group_id: string; digest: string }
  | { operation: 'pending_ack'; workspace_id: string; session_id: string; group_id: string; digest: string; request_id: string }
  | { operation: 'pending_status'; workspace_id: string; session_id: string; group_id: string }

/** Exact group ledger or parent pending-key reply. */
export type GroupMessageReply =
  | { state: 'recorded'; message_id: string; seq: number }
  | { state: 'recorded_source'
    group_id: string
    request_id: string
    payload_digest: string
    message_seq: number
    source: DesktopCollaborationSourceInput }
  | { state: 'missing' | 'conflict' | 'retry_required' }
  | { state: 'pending'; request_id: string }
  | { state: 'pending_status'; request_id: string; digest: string }
  | { state: 'pending_empty' }
  | { state: 'pending_other' | 'acknowledged' }
  | {
    state: 'page'
    items: readonly { id: string; seq: number; actor_kind: string; actor_ref: string; body: string; created_at: number }[]
    next_seq: number
    has_more: boolean
    last_seq: number
  }

/** The verified Slark parent owns this bridge in bundled remote mode. */
export interface GroupMessageBridge {
  collaborationGroupMessages?(command: GroupMessageCommand): Promise<GroupMessageReply>
}

const recordedState = 'recorded' as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
async function digest(body: string, refs: readonly string[], spans: readonly GroupAgentMentionSpan[]): Promise<string> {
  const bytes = new TextEncoder().encode(refs.length
    ? JSON.stringify(['group_text_with_agent_mentions_v2', body, refs, spans]) : body)
  const value = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A missing receipt may be retried only with the parent's request ID and identical body.
 * @param input - current group coordinates, text and verified parent bridge.
 * @returns the recorded key for draft acknowledgment, or a retained-draft failure.
 */
export async function sendGroupText(input: {
  bridge: GroupMessageBridge
  workspaceId: string
  sessionId: string
  groupId: string
  body: string
  mentionRefs?: string[]
  mentionSpans?: GroupAgentMentionSpan[]
}): Promise<{ state: 'recorded'; requestId: string; digest: string } | { state: 'retry_required' | 'pending_other' }> {
  const { bridge, workspaceId, sessionId, groupId, body } = input
  const refs = input.mentionRefs ?? [], spans = input.mentionSpans ?? []
  if (!bridge.collaborationGroupMessages || !uuid.test(groupId) || !uuid.test(workspaceId) ||
    !sessionId || body.length < 1 || body.length > 16_000 || new TextEncoder().encode(body).length > 24_000 ||
    !Array.isArray(refs) || refs.length > 10 || new Set(refs).size !== refs.length ||
    refs.some(ref => !/^slark-agent:[0-9a-f]{64}$/u.test(ref)) || spans.length !== refs.length)
    return { state: 'retry_required' }
  const commandBody = { operation: 'send', workspace_id: workspaceId, session_id: sessionId,
    request_id: '00000000-0000-4000-8000-000000000000', expected_group_version: 2, body,
    ...(refs.length ? { mention_refs: refs, mention_spans: spans } : {}) }
  if (new TextEncoder().encode(JSON.stringify(commandBody)).byteLength > 24 * 1024)
    return { state: 'retry_required' }
  try {
    const bodyDigest = await digest(body, refs, spans)
    const pending = await bridge.collaborationGroupMessages({ operation: 'pending_claim',
      workspace_id: workspaceId, session_id: sessionId, group_id: groupId, digest: bodyDigest })
    if (pending.state === 'pending_other') return { state: 'pending_other' }
    if (pending.state !== 'pending' || !uuid.test(pending.request_id)) return { state: 'retry_required' }
    const receipt = await bridge.collaborationGroupMessages({ operation: 'receipt',
      workspace_id: workspaceId, session_id: sessionId, request_id: pending.request_id })
    if (receipt.state === recordedState) return { state: recordedState, requestId: pending.request_id, digest: bodyDigest }
    if (receipt.state !== 'missing') return { state: 'retry_required' }
    const result = await bridge.collaborationGroupMessages({ operation: 'send',
      workspace_id: workspaceId, session_id: sessionId, request_id: pending.request_id,
      expected_group_version: 2, body,
      ...(refs.length ? { mention_refs: refs, mention_spans: spans } : {}) })
    if (result.state !== recordedState) return { state: 'retry_required' }
    return { state: recordedState, requestId: pending.request_id, digest: bodyDigest }
  } catch { return { state: 'retry_required' } }
}

/** Release a recorded tombstone only after the composer has visibly cleared its draft.
 * @param input - the exact recorded parent key and group coordinates.
 * @returns whether the parent acknowledged the cleared draft.
 */
export async function acknowledgeGroupText(input: {
  bridge: GroupMessageBridge
  workspaceId: string
  sessionId: string
  groupId: string
  requestId: string
  digest: string
}): Promise<boolean> {
  try {
    const result = await input.bridge.collaborationGroupMessages?.({ operation: 'pending_ack',
      workspace_id: input.workspaceId, session_id: input.sessionId, group_id: input.groupId,
      digest: input.digest, request_id: input.requestId })
    return result?.state === 'acknowledged'
  } catch { return false }
}
