/** Project scope calls over the authenticated Slark parent port; execution is advertised separately. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { exchange, readJson } from './remote-response.ts'
import { createRemoteCollaborationExecution } from './remote-collaboration-execution.ts'

const schema = 'dsh-remote-collaboration/v1'
const groupSchema = 'dsh-remote-collaboration/v2'
const encoder = new TextEncoder()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const version = /^(0|[1-9][0-9]{0,18})$/u
const digest = /^[a-f0-9]{64}$/u
const agentRef = /^slark-agent:[a-f0-9]{64}$/u

function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return row(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= max &&
    !/[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}
function scope(value: unknown, workspace: string): boolean {
  return exact(value, ['workspace_id', 'version', 'selected_project_ids']) && value.workspace_id === workspace &&
    typeof value.version === 'string' && version.test(value.version) && BigInt(value.version) <= 9223372036854775807n &&
    Array.isArray(value.selected_project_ids) && value.selected_project_ids.length <= 50 &&
    value.selected_project_ids.every(id => text(id, 256)) &&
    new Set(value.selected_project_ids).size === value.selected_project_ids.length
}
function workspaceValue(value: unknown, input: Record<string, unknown>): boolean {
  const operation = input.operation
  if (!row(operation) || typeof input.workspace_id !== 'string') return false
  if (operation.kind === 'get' || operation.kind === 'apply') return scope(value, input.workspace_id)
  if (operation.kind !== 'projects' && operation.kind !== 'agents') return false
  const agents = operation.kind === 'agents'
  if (!exact(value, agents ? ['items', 'next_cursor', 'scope_version'] : ['items', 'next_cursor']) ||
    !Array.isArray(value.items) || !row(operation.query) || typeof operation.query.limit !== 'number' ||
    value.items.length > operation.query.limit ||
    !(value.next_cursor === null || text(value.next_cursor, 2048)) ||
    (agents && !(typeof value.scope_version === 'string' && version.test(value.scope_version) &&
      BigInt(value.scope_version) <= 9223372036854775807n))) return false
  return value.items.every(item => exact(item, agents ?
    ['project_id', 'project_name', 'agent_id', 'agent_name', 'available', 'capability_snapshot', 'reason_code'] :
    ['project_id', 'project_name']) && text(item.project_id, 256) && text(item.project_name, 512) &&
    (!agents || (text(item.agent_id, 256) && text(item.agent_name, 512) && typeof item.available === 'boolean' &&
      text(item.reason_code, 128) && (!item.available || item.reason_code === 'ready') &&
      typeof item.capability_snapshot === 'string' && /^[a-f0-9]{64}$/u.test(item.capability_snapshot))))
}
function result(value: unknown, input: Record<string, unknown>): boolean {
  if (!row(value)) return false
  if (value.ok === true) return exact(value, ['ok', 'value']) && workspaceValue(value.value, input)
  return value.ok === false && Object.keys(value).every(key => ['ok', 'errorCode', 'refreshRequired', 'currentScope'].includes(key)) &&
    text(value.errorCode, 128) && typeof value.refreshRequired === 'boolean' &&
    (value.currentScope === undefined || (typeof input.workspace_id === 'string' && scope(value.currentScope, input.workspace_id)))
}
function capture(value: unknown): Record<string, unknown> {
  const bytes = JSON.stringify(value)
  if (encoder.encode(bytes).length > 32 * 1024) throw Error('remote collaboration request too large')
  const input: unknown = JSON.parse(bytes)
  if (!exact(input, ['workspace_id', 'session_id', 'operation']) || typeof input.workspace_id !== 'string' ||
    !uuid.test(input.workspace_id) || !text(input.session_id, 256) ||
    !row(input.operation)) throw Error('remote collaboration request is invalid')
  const op = input.operation
  if (op.kind === 'get' && exact(op, ['kind'])) return input
  if (op.kind === 'apply' && exact(op, ['kind', 'expected_version', 'selected_project_ids']) &&
    typeof op.expected_version === 'string' && version.test(op.expected_version) &&
    BigInt(op.expected_version) <= 9223372036854775807n &&
    Array.isArray(op.selected_project_ids) && op.selected_project_ids.length <= 50 &&
    op.selected_project_ids.every(id => text(id, 256)) &&
    new Set(op.selected_project_ids).size === op.selected_project_ids.length) return input
  if ((op.kind === 'agents' || op.kind === 'projects') && exact(op, ['kind', 'query']) && row(op.query) &&
    Object.keys(op.query).every(key => ['limit', 'query', 'cursor'].includes(key)) &&
    typeof op.query.limit === 'number' && Number.isInteger(op.query.limit) && op.query.limit >= 1 && op.query.limit <= 20 &&
    (op.query.query === undefined || op.query.query === '' || text(op.query.query, 128)) &&
    (op.query.cursor === undefined || text(op.query.cursor, 2048))) return input
  throw Error('remote collaboration operation is invalid')
}
function groupResult(value: unknown): boolean {
  if (!row(value)) return false
  if (value.state === 'pending') return exact(value, ['state', 'request_id'])
    && typeof value.request_id === 'string' && uuid.test(value.request_id)
  if (value.state === 'pending_status') return exact(value, ['state', 'request_id', 'digest'])
    && typeof value.request_id === 'string' && uuid.test(value.request_id)
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/u.test(value.digest)
  if (value.state === 'pending_empty') return exact(value, ['state'])
  if (value.state === 'pending_other' || value.state === 'acknowledged')
    return exact(value, ['state'])
  if (['missing', 'conflict', 'retry_required'].includes(String(value.state)))
    return exact(value, ['state'])
  if (value.state === 'recorded') return exact(value, ['state', 'message_id', 'seq'])
    && typeof value.message_id === 'string' && uuid.test(value.message_id)
    && Number.isSafeInteger(value.seq) && Number(value.seq) > 0
  if (value.state === 'recorded_source') {
    const source = value.source
    const originalMessage = row(source) ? source.original_message : undefined
    if (!exact(value, ['state', 'group_id', 'request_id', 'payload_digest', 'message_seq', 'source'])
      || typeof value.group_id !== 'string' || !uuid.test(value.group_id)
      || typeof value.request_id !== 'string' || !uuid.test(value.request_id)
      || typeof value.payload_digest !== 'string' || !digest.test(value.payload_digest)
      || !Number.isSafeInteger(value.message_seq) || Number(value.message_seq) < 1
      || !exact(source, ['workspace_id', 'session_id', 'source_message_id', 'source_revision',
        'original_message', 'active_mentions']) || typeof source.workspace_id !== 'string'
      || !uuid.test(source.workspace_id) || !text(source.session_id, 256)
      || typeof source.source_message_id !== 'string' || !uuid.test(source.source_message_id)
      || source.source_revision !== '1' || typeof originalMessage !== 'string'
      || !originalMessage.trim() || encoder.encode(originalMessage).length > 32 * 1024
      || !originalMessage.isWellFormed()
      || !Array.isArray(source.active_mentions) || source.active_mentions.length < 1
      || source.active_mentions.length > 10) return false
    return source.active_mentions.every((mention) => {
      if (!exact(mention, ['mention_id', 'source_span', 'display_snapshot', 'binding'])
        || typeof mention.mention_id !== 'string' || !uuid.test(mention.mention_id)
        || !exact(mention.source_span, ['source_message_id', 'source_revision', 'start', 'end'])
        || mention.source_span.source_message_id !== source.source_message_id
        || mention.source_span.source_revision !== '1'
        || !Number.isSafeInteger(mention.source_span.start)
        || !Number.isSafeInteger(mention.source_span.end)
        || Number(mention.source_span.start) < 0
        || Number(mention.source_span.end) > originalMessage.length
        || Number(mention.source_span.end) <= Number(mention.source_span.start) + 1
        || originalMessage[Number(mention.source_span.start)] !== '@'
        || !exact(mention.display_snapshot, ['agent_name', 'project_name'])
        || !text(mention.display_snapshot.agent_name, 512)
        || !text(mention.display_snapshot.project_name, 512)
        || !exact(mention.binding, ['kind', 'target', 'capability_snapshot'])
        || mention.binding.kind !== 'resolved' || !exact(mention.binding.target, ['project_id', 'agent_id'])
        || !text(mention.binding.target.project_id, 256) || !text(mention.binding.target.agent_id, 256)
        || typeof mention.binding.capability_snapshot !== 'string'
        || !digest.test(mention.binding.capability_snapshot)) return false
      return originalMessage.slice(Number(mention.source_span.start), Number(mention.source_span.end))
        === `@${mention.display_snapshot.agent_name} · ${mention.display_snapshot.project_name}`
    })
  }
  if (value.state !== 'page' || !exact(value, ['state', 'items', 'next_seq', 'has_more', 'last_seq'])
    || !Array.isArray(value.items) || value.items.length > 100
    || !Number.isSafeInteger(value.next_seq) || Number(value.next_seq) < 0
    || !Number.isSafeInteger(value.last_seq) || Number(value.last_seq) < Number(value.next_seq)
    || typeof value.has_more !== 'boolean') return false
  let previous = 0
  for (const item of value.items) {
    if (!exact(item, ['id', 'seq', 'actor_kind', 'actor_ref', 'body', 'created_at'])
      || typeof item.id !== 'string' || !uuid.test(item.id)
      || !Number.isSafeInteger(item.seq) || Number(item.seq) <= previous
      || !['human', 'bot', 'slark_agent', 'system'].includes(String(item.actor_kind))
      || !text(item.actor_ref, 256) || typeof item.body !== 'string'
      || item.body.length < 1 || item.body.length > 16_000
      || !Number.isSafeInteger(item.created_at) || Number(item.created_at) < 1) return false
    previous = Number(item.seq)
  }
  return !value.items.length || previous === value.next_seq
}
function groupMentionCommand(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, 'mention_refs') && !Object.hasOwn(value, 'mention_spans')) return true
  const refs = value.mention_refs, spans = value.mention_spans
  if (!Array.isArray(refs) || !Array.isArray(spans)
    || refs.length < 1 || refs.length > 10
    || spans.length !== refs.length
    || new Set(refs).size !== refs.length
    || refs.some(ref => typeof ref !== 'string' || !agentRef.test(ref))) return false
  const used = new Set<string>()
  let previousEnd = 0
  return spans.every((span, index) => {
    if (!exact(span, ['mention_id', 'actor_ref', 'start', 'end', 'agent_name', 'project_name', 'capability_snapshot'])
      || typeof span.mention_id !== 'string' || !uuid.test(span.mention_id) || used.has(span.mention_id)
      || span.actor_ref !== refs[index] || !Number.isSafeInteger(span.start)
      || !Number.isSafeInteger(span.end) || Number(span.start) < previousEnd
      || Number(span.end) <= Number(span.start) + 1 || typeof value.body !== 'string'
      || Number(span.end) > value.body.length || !text(span.agent_name, 512)
      || !text(span.project_name, 512) || typeof span.capability_snapshot !== 'string'
      || !digest.test(span.capability_snapshot)
      || value.body.slice(Number(span.start), Number(span.end)) !== `@${span.agent_name} · ${span.project_name}`)
      return false
    used.add(span.mention_id)
    previousEnd = Number(span.end)
    return true
  })
}
function groupMemberInput(value: unknown): value is Record<string, unknown> {
  if (!row(value)) return false
  const fields = value.operation === 'status' ? ['operation', 'workspace_id', 'session_id']
    : value.operation === 'bots' ? ['operation', 'workspace_id', 'session_id', 'after_bot_id', 'limit']
      : value.operation === 'inflight' ? ['operation', 'workspace_id', 'session_id',
        'member_id', 'after_delivery_id', 'limit']
        : value.operation === 'proxy_status' ? ['operation', 'workspace_id', 'session_id']
          : value.operation === 'proxy_select' || value.operation === 'proxy_replace'
            ? ['operation', 'workspace_id', 'session_id',
              'request_id', 'expected_binding_epoch', 'bot_id']
            : value.operation === 'proxy_unbind' ? ['operation', 'workspace_id', 'session_id',
              'request_id', 'expected_binding_epoch']
              : ['proxy_handoff_seal', 'proxy_handoff_revoke', 'proxy_handoff_attach',
                'proxy_handoff_complete'].includes(String(value.operation))
                ? ['operation', 'workspace_id', 'session_id', 'binding_id', 'target_epoch']
                : value.operation === 'proxy_attach' ? ['operation', 'workspace_id', 'session_id',
                  'request_id', 'expected_membership_version', 'bot_id', 'binding_id', 'binding_epoch']
                  : value.operation === 'receipt' ? ['operation', 'workspace_id', 'session_id', 'request_id']
                    : value.operation === 'join' ? ['operation', 'workspace_id', 'session_id', 'request_id',
                      'expected_membership_version', 'bot_id']
                      : value.operation === 'leave' ? ['operation', 'workspace_id', 'session_id', 'request_id',
                        'expected_membership_version', 'member_id'] : []
  if (!fields.length || !exact(value, fields) || typeof value.workspace_id !== 'string'
    || !uuid.test(value.workspace_id) || typeof value.session_id !== 'string'
    || !/^[!-~]{1,256}$/u.test(value.session_id) || /[/\\]/u.test(value.session_id)
    || value.session_id === '.' || value.session_id === '..') return false
  if (value.operation === 'status') return true
  if (value.operation === 'proxy_status') return true
  if (value.operation === 'bots') return typeof value.after_bot_id === 'string'
    && (value.after_bot_id === '' || /^[A-Za-z0-9_-]{1,200}$/u.test(value.after_bot_id))
    && Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100
  if (value.operation === 'inflight') return typeof value.member_id === 'string'
    && uuid.test(value.member_id) && typeof value.after_delivery_id === 'string'
    && (value.after_delivery_id === '' || uuid.test(value.after_delivery_id))
    && Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100
  if (['proxy_handoff_seal', 'proxy_handoff_revoke', 'proxy_handoff_attach',
    'proxy_handoff_complete'].includes(String(value.operation)))
    return typeof value.binding_id === 'string' && uuid.test(value.binding_id)
      && Number.isSafeInteger(value.target_epoch) && Number(value.target_epoch) >= 1
  if (typeof value.request_id !== 'string' || !uuid.test(value.request_id)) return false
  if (value.operation === 'receipt') return true
  if (value.operation === 'proxy_select' || value.operation === 'proxy_replace')
    return Number.isSafeInteger(value.expected_binding_epoch)
    && Number(value.expected_binding_epoch) >= (value.operation === 'proxy_replace' ? 1 : 0)
    && typeof value.bot_id === 'string'
    && /^[A-Za-z0-9_-]{1,200}$/u.test(value.bot_id)
  if (value.operation === 'proxy_unbind') return Number.isSafeInteger(value.expected_binding_epoch)
    && Number(value.expected_binding_epoch) >= 1
  if (value.operation === 'proxy_attach') return Number.isSafeInteger(value.expected_membership_version)
    && Number(value.expected_membership_version) >= 1 && typeof value.bot_id === 'string'
    && /^[A-Za-z0-9_-]{1,200}$/u.test(value.bot_id)
    && typeof value.binding_id === 'string' && uuid.test(value.binding_id)
    && Number.isSafeInteger(value.binding_epoch) && Number(value.binding_epoch) >= 1
  if (!Number.isSafeInteger(value.expected_membership_version)
    || Number(value.expected_membership_version) < 1) return false
  return value.operation === 'join'
    ? typeof value.bot_id === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value.bot_id)
    : typeof value.member_id === 'string' && uuid.test(value.member_id)
}
function groupMemberResult(value: unknown): boolean {
  if (!row(value)) return false
  if (['missing', 'conflict', 'retry_required'].includes(String(value.state)))
    return exact(value, ['state'])
  if (value.state === 'bot_roster') {
    if (!exact(value, ['state', 'bots', 'next_cursor']) || !Array.isArray(value.bots)
      || value.bots.length > 100 ||
      (value.next_cursor !== null && typeof value.next_cursor !== 'string')) return false
    let prior = ''
    for (const bot of value.bots) {
      if (!exact(bot, ['bot_id', 'actor_ref', 'display_name']) ||
        typeof bot.bot_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(bot.bot_id) ||
        bot.bot_id <= prior || bot.actor_ref !== `deepseek-bot:${bot.bot_id}` ||
        typeof bot.display_name !== 'string' || !bot.display_name.trim() ||
        encoder.encode(bot.display_name).length > 512) return false
      prior = bot.bot_id
    }
    return value.next_cursor === null || value.next_cursor === prior
  }
  if (value.state === 'inflight') {
    if (!exact(value, ['state', 'member_id', 'member_cycle', 'deliveries', 'next_cursor']) ||
      typeof value.member_id !== 'string' || !uuid.test(value.member_id) ||
      !Number.isSafeInteger(value.member_cycle) || Number(value.member_cycle) < 1 ||
      !Array.isArray(value.deliveries) || value.deliveries.length > 100 ||
      (value.next_cursor !== null && (typeof value.next_cursor !== 'string' ||
        !uuid.test(value.next_cursor)))) return false
    let prior = ''
    for (const item of value.deliveries) {
      if (!exact(item, ['delivery_id', 'message_seq', 'payload_digest', 'state']) ||
        typeof item.delivery_id !== 'string' || !uuid.test(item.delivery_id) ||
        item.delivery_id <= prior || !Number.isSafeInteger(item.message_seq) ||
        Number(item.message_seq) < 1 || typeof item.payload_digest !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(item.payload_digest) ||
        item.state !== 'pending_reconciliation') return false
      prior = item.delivery_id
    }
    return value.next_cursor === null || value.next_cursor === prior
  }
  if (value.state === 'proxy_binding') return exact(value,
    ['state', 'binding_id', 'binding_epoch', 'bot_ref', 'binding_state'])
    && (value.binding_id === null || typeof value.binding_id === 'string' && uuid.test(value.binding_id))
    && Number.isSafeInteger(value.binding_epoch) && Number(value.binding_epoch) >= 0
    && (value.bot_ref === null || typeof value.bot_ref === 'string'
      && /^deepseek-bot:[A-Za-z0-9_-]{1,200}$/u.test(value.bot_ref))
    && ['unbound', 'active', 'transferring', 'needs_reselection'].includes(String(value.binding_state))
  if (value.state === 'proxy_bound') return exact(value,
    ['state', 'binding_id', 'binding_epoch', 'bot_ref'])
    && typeof value.binding_id === 'string' && uuid.test(value.binding_id)
    && Number.isSafeInteger(value.binding_epoch) && Number(value.binding_epoch) >= 1
    && typeof value.bot_ref === 'string'
    && /^deepseek-bot:[A-Za-z0-9_-]{1,200}$/u.test(value.bot_ref)
  if (value.state === 'proxy_changed') return exact(value,
    ['state', 'operation', 'binding_id', 'binding_epoch', 'bot_ref', 'binding_state'])
    && typeof value.binding_id === 'string' && uuid.test(value.binding_id)
    && Number.isSafeInteger(value.binding_epoch) && Number(value.binding_epoch) >= 1
    && (value.operation === 'replace' && value.binding_state === 'transferring'
      && typeof value.bot_ref === 'string' && /^deepseek-bot:[A-Za-z0-9_-]{1,200}$/u.test(value.bot_ref)
      || value.operation === 'unbind' && value.binding_state === 'unbound' && value.bot_ref === null)
  if (value.state === 'handoff_sealed') return exact(value,
    ['state', 'handoff_id', 'namespace_count', 'item_count'])
    && typeof value.handoff_id === 'string' && uuid.test(value.handoff_id)
    && Number.isSafeInteger(value.namespace_count) && Number(value.namespace_count) >= 1
    && Number.isSafeInteger(value.item_count) && Number(value.item_count) >= 0
  if (value.state === 'handoff_step') return exact(value, ['state', 'operation', 'result'])
    && (value.operation === 'complete' && ['active', 'complete'].includes(String(value.result))
      || (value.operation === 'revoke' || value.operation === 'attach')
        && ['recorded', 'idle', 'blocked'].includes(String(value.result)))
  if (value.state === 'recorded') return exact(value, ['state', 'operation', 'member_id',
    'membership_version', 'seq']) && ['join', 'leave', 'proxy_attach', 'proxy_revoke'].includes(String(value.operation))
    && typeof value.member_id === 'string' && uuid.test(value.member_id)
    && Number.isSafeInteger(value.membership_version) && Number(value.membership_version) >= 1
    && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0
  if (value.state !== 'snapshot' || !exact(value, ['state', 'group_id', 'membership_version',
    'last_seq', 'members']) || typeof value.group_id !== 'string' || !uuid.test(value.group_id)
    || !Number.isSafeInteger(value.membership_version) || Number(value.membership_version) < 1
    || !Number.isSafeInteger(value.last_seq) || Number(value.last_seq) < 0
    || !Array.isArray(value.members) || value.members.length > 100) return false
  let owners = 0
  for (const member of value.members) {
    if (!exact(member, ['member_id', 'actor_kind', 'actor_ref', 'role', 'cycle', 'joined_seq', 'sources'])
      || typeof member.member_id !== 'string' || !uuid.test(member.member_id)
      || !['human', 'bot', 'slark_agent', 'system'].includes(String(member.actor_kind))
      || !text(member.actor_ref, 256) || !['owner', 'member'].includes(String(member.role))
      || !Number.isSafeInteger(member.cycle) || Number(member.cycle) < 1
      || !Number.isSafeInteger(member.joined_seq) || Number(member.joined_seq) < 0
      || !Array.isArray(member.sources) || member.sources.length > 2
      || !member.sources.every(source => source === 'manual' || source === 'personal_proxy')) return false
    if (member.actor_kind === 'human' && member.role === 'owner') owners++
  }
  return owners === 1
}
function groupPreparationResult(value: unknown, input: Record<string, unknown>): boolean {
  if (!row(value)) return false
  if (value.state === 'retry_required') return exact(value, ['state'])
  if (input.operation === 'lookup') {
    if (value.state === 'missing') return exact(value, ['state'])
    return exact(value, ['group_id', 'last_seq', 'session_id', 'state', 'version', 'workspace_id'])
      && (value.state === 'preparing' || value.state === 'group_active')
      && value.version === (value.state === 'preparing' ? 1 : 2)
      && Number.isSafeInteger(value.last_seq) && Number(value.last_seq) >= 0
      && typeof value.group_id === 'string' && uuid.test(value.group_id)
      && value.workspace_id === input.workspace_id && value.session_id === input.session_id
  }
  return exact(value, ['group_id', 'session_id', 'state', 'version', 'workspace_id'])
    && value.state === 'preparing' && value.version === 1
    && typeof value.group_id === 'string' && uuid.test(value.group_id)
    && value.workspace_id === input.workspace_id && value.session_id === input.session_id
}
function groupActivationResult(value: unknown): boolean {
  return row(value) && (value.state === 'retry_required' && exact(value, ['state']) ||
    value.state === 'group_active' && exact(value, ['state', 'group_id', 'version']) &&
    typeof value.group_id === 'string' && uuid.test(value.group_id) && value.version === 2)
}
/**
 * Negotiate scope support before applying Client plugins. Old parents leave the bridge absent.
 * @param fetch - Unary transport using only the authenticated parent port.
 * @returns Completion after the supported bridge is installed or capability discovery is refused.
 */
export async function installRemoteCollaboration(fetch: TunnelFetch): Promise<void> {
  const lifetime = new AbortController()
  let installed: object | undefined
  const onHide = (): void => {
    lifetime.abort()
    if (installed !== undefined && Reflect.get(window, '__DSH_DESKTOP_HOST__') === installed) {
      Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
    }
  }
  window.addEventListener('pagehide', onHide, { once: true })
  try {
    const discovery = new AbortController()
    const discoveryTimer = setTimeout(() => { discovery.abort() }, 5_000)
    const discoverySignal = AbortSignal.any([discovery.signal, lifetime.signal])
    let advertised: unknown
    let expectedSchema = schema
    try {
      for (const [path, candidateSchema] of [
        ['/__collaboration_v2__', groupSchema], ['/__collaboration__', schema],
      ] as const) {
        try {
          const response = await exchange(fetch, path, { method: 'GET' }, discoverySignal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); continue }
          const candidate = await readJson(response, discoverySignal)
          if (exact(candidate, ['schema', 'methods']) && candidate.schema === candidateSchema &&
            Array.isArray(candidate.methods)) {
            advertised = candidate
            expectedSchema = candidateSchema
            break
          }
        } catch (_error) {
          if (discoverySignal.aborted) return
          // An older parent may reject the v2 probe before legacy discovery succeeds.
        }
      }
    } catch (_error) {
      // A missing or unusable capability response does not prevent ordinary remote chat.
      return
    } finally { clearTimeout(discoveryTimer) }
    lifetime.signal.throwIfAborted()
    if (!exact(advertised, ['schema', 'methods']) || advertised.schema !== expectedSchema || !Array.isArray(advertised.methods)) return
    const methods: readonly unknown[] = advertised.methods
    const conversations = methods.includes('conversations')
    const archive = methods.includes('archive')
    const groupMessages = expectedSchema === groupSchema && methods.includes('groupMessages')
    const groupMembers = expectedSchema === groupSchema && methods.includes('groupMembers')
    const groupPreparation = expectedSchema === groupSchema && methods.includes('groupPreparation')
    const groupActivation = expectedSchema === groupSchema && methods.includes('groupActivation')
    const execution = ['workspace', 'submit', 'pending', 'deliveries'].every(method => methods.includes(method))
    if (!methods.includes('workspace') || methods.length !== (execution ? 4 : 1) + (conversations ? 1 : 0) + (archive ? 1 : 0)
      + (groupMessages ? 1 : 0) + (groupMembers ? 1 : 0)
      + (groupPreparation ? 1 : 0) + (groupActivation ? 1 : 0)
      || methods.some(method => !['workspace', 'submit', 'pending', 'deliveries', 'conversations', 'archive',
        'groupMessages', 'groupMembers', 'groupPreparation', 'groupActivation'].includes(String(method)))) return
    if (Reflect.get(window, '__DSH_DESKTOP_HOST__') !== undefined) throw Error('remote web: Host bridge already installed')
    let sequence = 0
    const bridge = {
      async accountIdentity(): Promise<{ name: string; avatarUrl: string | null } | null> {
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 10_000)
        const signal = AbortSignal.any([controller.signal, lifetime.signal])
        try {
          const response = await exchange(fetch, '/__account__', { method: 'GET' }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); return null }
          const value = await readJson(response, signal, 800 * 1024)
          if (!exact(value, ['name', 'avatarUrl']) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512
            || value.avatarUrl !== null && (typeof value.avatarUrl !== 'string'
              || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u.test(value.avatarUrl))) return null
          return { name: value.name, avatarUrl: value.avatarUrl }
        } finally { clearTimeout(timer) }
      },
      collaborationScopeAvailable: true,
      collaborationExecutionAvailable: execution,
      ...((execution || conversations || archive || groupMessages || groupMembers || groupPreparation || groupActivation) ? (() => {
        const call = async (method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
          const rpcId = 'collaboration-' + String(++sequence)
          const response = await exchange(fetch, '/api/' + method, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
              rpcId, method, payload: { args: { request: input } } }) }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error('remote collaboration refused') }
          const value = await readJson(response, signal, 800 * 1024)
          signal.throwIfAborted()
          if (!exact(value, ['type', 'rpcId', 'result']) || value.type !== 'server-response' || value.rpcId !== rpcId
            || !exact(value.result, ['ok', 'value']) || value.result.ok !== true) throw Error('invalid collaboration response')
          return value.result.value
        }
        const methods = createRemoteCollaborationExecution({ signal: lifetime.signal, call })
        return { ...(execution ? { collaborationSubmit: methods.collaborationSubmit,
          collaborationPending: methods.collaborationPending, collaborationDeliveries: methods.collaborationDeliveries } : {}),
        ...(conversations ? { collaborationConversations: methods.collaborationConversations } : {}),
        ...(groupMessages ? { collaborationGroupMessages: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            if (!row(raw) || typeof raw.workspace_id !== 'string' || !uuid.test(raw.workspace_id)
              || typeof raw.session_id !== 'string' || !/^[!-~]{1,256}$/u.test(raw.session_id)
              || /[/\\]/u.test(raw.session_id) || raw.session_id === '.' || raw.session_id === '..')
              throw Error('invalid group request')
            const fields = raw.operation === 'send' ? ['operation', 'request_id', 'workspace_id', 'session_id',
              'expected_group_version', 'body',
              ...(Object.hasOwn(raw, 'mention_refs') ? ['mention_refs'] : []),
              ...(Object.hasOwn(raw, 'mention_spans') ? ['mention_spans'] : [])] : raw.operation === 'pending_claim'
              ? ['operation', 'workspace_id', 'session_id', 'group_id', 'digest'] : raw.operation === 'pending_ack'
                ? ['operation', 'workspace_id', 'session_id', 'group_id', 'digest', 'request_id'] : raw.operation === 'pending_status'
                  ? ['operation', 'workspace_id', 'session_id', 'group_id'] : raw.operation === 'receipt'
                    ? ['operation', 'request_id', 'workspace_id', 'session_id'] : raw.operation === 'work-source'
                      ? ['operation', 'message_id', 'workspace_id', 'session_id'] : raw.operation === 'page'
                        ? ['operation', 'workspace_id', 'session_id', 'after_seq', 'limit'] : []
            if (!exact(raw, fields) || !fields.length) throw Error('invalid group request')
            if (raw.operation === 'pending_claim' || raw.operation === 'pending_ack' || raw.operation === 'pending_status') {
              if (typeof raw.group_id !== 'string' || !uuid.test(raw.group_id) ||
                raw.operation !== 'pending_status' &&
                (typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.digest)) ||
                raw.operation === 'pending_ack' && (typeof raw.request_id !== 'string' || !uuid.test(raw.request_id)))
                throw Error('invalid group pending')
            } else if (raw.operation === 'page') {
              if (!Number.isSafeInteger(raw.after_seq) || Number(raw.after_seq) < 0 ||
                !Number.isInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 100)
                throw Error('invalid group page')
            } else if (raw.operation === 'work-source') {
              if (typeof raw.message_id !== 'string' || !uuid.test(raw.message_id))
                throw Error('invalid group message identity')
            } else if (typeof raw.request_id !== 'string' || !uuid.test(raw.request_id)) {
              throw Error('invalid group key')
            }
            if (raw.operation === 'send' && (raw.expected_group_version !== 2 ||
              typeof raw.body !== 'string' || raw.body.length < 1 || raw.body.length > 16_000 ||
              encoder.encode(raw.body).length > 24_000 || !groupMentionCommand(raw))) throw Error('invalid group body')
            if (encoder.encode(JSON.stringify(raw)).length > 24 * 1024) throw Error('group command too large')
            const result = await call('collaboration/groupMessages', raw, signal)
            if (!groupResult(result) || raw.operation === 'work-source' && row(result) &&
              result.state === 'recorded_source' &&
              (!row(result.source) || result.source.workspace_id !== raw.workspace_id ||
                result.source.session_id !== raw.session_id || result.source.source_message_id !== raw.message_id))
              throw Error('invalid group reply')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}),
        ...(groupMembers ? { collaborationGroupMembers: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            if (!groupMemberInput(raw)) throw Error('invalid group member request')
            const result = await call('collaboration/groupMembers', raw, signal)
            if (!groupMemberResult(result)) throw Error('invalid group member reply')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}),
        ...(groupPreparation ? { collaborationGroupPreparation: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            const lookup = row(raw) && raw.operation === 'lookup'
            if (!exact(raw, lookup ? ['operation', 'workspace_id', 'session_id']
              : ['workspace_id', 'session_id', 'source_message_id', 'source_revision'])
              || typeof raw.workspace_id !== 'string' || !uuid.test(raw.workspace_id)
              || typeof raw.session_id !== 'string' || !/^[!-~]{1,256}$/u.test(raw.session_id)
              || /[/\\]/u.test(raw.session_id) || raw.session_id === '.' || raw.session_id === '..'
              || !lookup && (typeof raw.source_message_id !== 'string' ||
                !/^[!-~]{1,256}$/u.test(raw.source_message_id) ||
                /[/\\]/u.test(raw.source_message_id) || raw.source_message_id === '.' || raw.source_message_id === '..' ||
                typeof raw.source_revision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(raw.source_revision) ||
                BigInt(raw.source_revision) > 9223372036854775807n))
              throw Error('invalid group Source')
            const result = await call('collaboration/groupPreparation', raw, signal)
            if (!groupPreparationResult(result, raw)) throw Error('invalid group preparation')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}),
        ...(groupActivation ? { collaborationGroupActivation: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            if (!exact(raw, ['request_id', 'workspace_id', 'session_id']) ||
              typeof raw.request_id !== 'string' || !uuid.test(raw.request_id) ||
              typeof raw.workspace_id !== 'string' || !uuid.test(raw.workspace_id) ||
              typeof raw.session_id !== 'string' || !/^[!-~]{1,256}$/u.test(raw.session_id) ||
              /[/\\]/u.test(raw.session_id) || raw.session_id === '.' || raw.session_id === '..')
              throw Error('invalid group activation')
            const result = await call('collaboration/groupActivation', raw, signal)
            if (!groupActivationResult(result)) throw Error('invalid group activation reply')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}),
        ...(archive ? { collaborationArchive: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            const input = exact(raw, ['workspace_id', 'session_id', 'action']) ? raw : undefined
            if (!input || typeof input.workspace_id !== 'string' || !uuid.test(input.workspace_id)
                || typeof input.session_id !== 'string' || !/^[!-~]{1,256}$/u.test(input.session_id)
                || /[/\\]/u.test(input.session_id) || input.session_id === '.' || input.session_id === '..'
                || (input.action !== 'archive' && input.action !== 'restore'))
              throw Error('invalid archive action')
            const result = await call('collaboration/archive', input, signal)
            if (!exact(result, ['state']) || !['archived', 'restored', 'retry_required', 'conflict'].includes(String(result.state)))
              throw Error('invalid archive result')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}) }
      })() : {}),
      async collaborationWorkspace(raw: unknown): Promise<unknown> {
        let input: Record<string, unknown> | undefined
        let sent = false
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 30_000)
        const signal = AbortSignal.any([controller.signal, lifetime.signal])
        try {
          input = capture(raw)
          signal.throwIfAborted()
          const rpcId = 'workspace-' + String(++sequence)
          sent = true
          const response = await exchange(fetch, '/api/collaboration/workspace', { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method: 'collaboration/workspace', payload: { args: { request: input } } }),
          }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error('remote collaboration refused') }
          const value = await readJson(response, signal)
          signal.throwIfAborted()
          if (!exact(value, ['type', 'rpcId', 'result']) || value.type !== 'server-response' || value.rpcId !== rpcId ||
            !exact(value.result, ['ok', 'value']) || value.result.ok !== true || !result(value.result.value, input)) {
            throw Error('remote collaboration response is invalid')
          }
          return value.result.value
        } catch (_error) {
          return { ok: false, errorCode: 'collaboration_scope_unavailable',
            refreshRequired: sent && row(input?.operation) && input.operation.kind === 'apply' }
        } finally { clearTimeout(timer) }
      },
    }
    Reflect.set(window, '__DSH_DESKTOP_HOST__', bridge)
    installed = bridge
  } finally {
    if (installed === undefined) window.removeEventListener('pagehide', onHide)
  }
}
