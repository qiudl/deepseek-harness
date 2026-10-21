/** Durable request identity for one original Session group message. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export type GroupMessageCommand =
  | {
    operation: 'send'
    workspace_id: string
    session_id: string
    request_id: string
    expected_group_version: 2
    body: string
  }
  | { operation: 'receipt'; workspace_id: string; session_id: string; request_id: string }
  | { operation: 'page'; workspace_id: string; session_id: string; after_seq: number; limit: number }

export type GroupMessageReply =
  | { state: 'recorded'; message_id: string; seq: number }
  | { state: 'missing' | 'conflict' | 'retry_required' }
  | {
    state: 'page'
    items: readonly { id: string; seq: number; actor_kind: string; actor_ref: string; body: string; created_at: number }[]
    next_seq: number
    has_more: boolean
    last_seq: number
  }

export interface GroupMessageBridge {
  collaborationGroupMessages?(command: GroupMessageCommand): Promise<GroupMessageReply>
}

type Pending = { request_id: string; digest: string }
const recordedState = 'recorded' as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha = /^[a-f0-9]{64}$/u
function pendingKey(groupId: string): string { return `dsh:slark-group-message:v1:${groupId}` }
function readPending(storage: Storage, key: string): Pending | undefined {
  const raw = storage.getItem(key)
  if (raw === null) return undefined
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'digest,request_id') throw Error('group_pending_invalid')
  const row = value as Record<string, unknown>
  if (typeof row.request_id !== 'string' || !uuid.test(row.request_id) ||
    typeof row.digest !== 'string' || !sha.test(row.digest)) throw Error('group_pending_invalid')
  return { request_id: row.request_id, digest: row.digest }
}
async function digest(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  const value = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A missing receipt may be retried only with the stored request ID and identical body. */
export async function sendGroupText(input: {
  bridge: GroupMessageBridge
  storage: Storage
  workspaceId: string
  sessionId: string
  groupId: string
  body: string
}): Promise<'recorded' | 'retry_required' | 'pending_other'> {
  const { bridge, storage, workspaceId, sessionId, groupId, body } = input
  if (!bridge.collaborationGroupMessages || !uuid.test(groupId) || !uuid.test(workspaceId) ||
    !sessionId || body.length < 1 || body.length > 16_000 || new TextEncoder().encode(body).length > 24_000)
    return 'retry_required'
  try {
    const key = pendingKey(groupId), bodyDigest = await digest(body)
    let pending = readPending(storage, key)
    if (pending) {
      const receipt = await bridge.collaborationGroupMessages({ operation: 'receipt',
        workspace_id: workspaceId, session_id: sessionId, request_id: pending.request_id })
      if (receipt.state === 'recorded') {
        storage.removeItem(key)
        return pending.digest === bodyDigest ? recordedState : 'pending_other'
      }
      if (receipt.state !== 'missing') return 'retry_required'
      if (pending.digest !== bodyDigest) return 'pending_other'
    } else {
      pending = { request_id: randomUUID(), digest: bodyDigest }
      storage.setItem(key, JSON.stringify(pending))
    }
    const result = await bridge.collaborationGroupMessages({ operation: 'send',
      workspace_id: workspaceId, session_id: sessionId, request_id: pending.request_id,
      expected_group_version: 2, body })
    if (result.state !== 'recorded') return 'retry_required'
    storage.removeItem(key)
    return recordedState
  } catch { return 'retry_required' }
}
