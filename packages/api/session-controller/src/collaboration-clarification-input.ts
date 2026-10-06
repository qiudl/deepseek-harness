/** REQ-20260930-0004: immutable queued inputs for analysis of a trusted chat clarification. */
import { z } from 'zod'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest, parseCollaborationSourceSnapshot } from './collaboration-source-journal.ts'
import type { CollaborationSourceSnapshot } from './collaboration-source-journal.ts'

const id = z.string().regex(/^[\x21-\x7e]{1,256}$/u)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const version = z.string().refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n)
const ids = (minimum: number) => z.array(id).min(minimum).max(10).refine(values => new Set(values).size === values.length)
const text = (maximum: number) => z.string().refine(value => value.trim().length > 0 && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= maximum)
const snapshot = z.unknown().transform(parseCollaborationSourceSnapshot)
const pending = z.strictObject({
  pending_item_id: id.brand<'CollaborationPendingItemId'>(), revision: version,
  mention_ids: ids(1), target: z.strictObject({ project_id: id, agent_id: id }).nullable(),
  reason: z.enum(['target_ambiguous', 'task_ambiguous', 'reference_ambiguous', 'dependency_unsupported']),
  question: text(2048), source_evidence_spans: z.array(z.strictObject({
    source_message_id: id, source_revision: version, start: z.number().int().min(0), end: z.number().int().min(1),
  })).min(1).max(128),
})
const schema = z.strictObject({
  plan: z.strictObject({ plan_id: id.brand<'CollaborationPlanId'>(), plan_revision: version,
    input_version: version.refine(value => BigInt(value) > 1n) }),
  clarification_request_id: id.brand<'CollaborationClarificationRequestId'>(),
  original_snapshot: snapshot, reply_snapshot: snapshot,
  original_snapshot_digest: digest, reply_snapshot_digest: digest,
  pending_items: z.array(pending).min(1).max(10), frozen_task_ids: ids(0), mention_order: ids(1),
  prior_replies: z.array(z.strictObject({ clarification_request_id: id.brand<'CollaborationClarificationRequestId'>(),
    state: z.literal('irrelevant'), snapshot, snapshot_digest: digest, pending_item_ids: ids(1),
  })).max(30),
})
type DeepReadonly<T> = T extends string ? T : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
/** Coordinator-selected pending items and committed Sources, without model calls or admission authority. */
export type CollaborationClarificationInput = DeepReadonly<z.infer<typeof schema>>
function sameOwner(original: CollaborationSourceSnapshot, reply: CollaborationSourceSnapshot): boolean {
  return original.workspace_id === reply.workspace_id && original.session_id === reply.session_id
    && original.source_message_id !== reply.source_message_id && reply.active_mentions.length === 0
    && original.model_snapshot.provider === reply.model_snapshot.provider
    && original.model_snapshot.model === reply.model_snapshot.model
    && original.model_snapshot.adapter_fingerprint === reply.model_snapshot.adapter_fingerprint
    && original.model_snapshot.reasoning_effort === reply.model_snapshot.reasoning_effort
}
function splits(text: string, at: number): boolean {
  // Source parsing already requires well-formed Unicode, so a high surrogate has a low successor.
  return at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff
}
function valid(input: CollaborationClarificationInput): boolean {
  const original = input.original_snapshot
  if (!original.active_mentions.length || !sameOwner(original, input.reply_snapshot)
    || collaborationJournalDigest(original) !== input.original_snapshot_digest
    || collaborationJournalDigest(input.reply_snapshot) !== input.reply_snapshot_digest
    || !deepEqualJson(input.mention_order, [...original.active_mentions]
      .sort((a, b) => a.source_span.start - b.source_span.start).map(item => item.mention_id))) return false
  const pendingIds = new Set<string>(), mentionIds = new Set<string>()
  for (const item of input.pending_items) {
    if (pendingIds.has(item.pending_item_id) || input.frozen_task_ids.includes(item.pending_item_id)) return false
    pendingIds.add(item.pending_item_id)
    const bindings: CollaborationSourceSnapshot['active_mentions'][number]['binding'][] = []
    for (const id of item.mention_ids) {
      const mention = original.active_mentions.find(value => value.mention_id === id)
      if (!mention || mentionIds.has(id) || mention.binding.kind === 'unavailable'
        || !item.source_evidence_spans.some(span => span.start <= mention.source_span.start
          && span.end >= mention.source_span.end)) return false
      mentionIds.add(id)
      bindings.push(mention.binding)
    }
    // The schema requires a mention, and each validated mention contributes one binding.
    const [first] = bindings as [typeof bindings[number], ...typeof bindings[number][]]
    const target = first.kind === 'resolved' && bindings.every(binding => binding.kind === 'resolved' && deepEqualJson(binding.target, first.target))
      ? first.target : null
    if (!deepEqualJson(item.target, target) || item.source_evidence_spans.some(span => span.source_message_id !== original.source_message_id
      || span.source_revision !== original.source_revision || span.start >= span.end || span.end > original.original_message.length
      || splits(original.original_message, span.start) || splits(original.original_message, span.end))) return false
  }
  const requests = new Set<string>([input.clarification_request_id])
  const sources = new Set<string>([original.source_message_id, input.reply_snapshot.source_message_id])
  for (const item of input.prior_replies) {
    if (requests.has(item.clarification_request_id) || sources.has(item.snapshot.source_message_id)
      || !sameOwner(original, item.snapshot) || collaborationJournalDigest(item.snapshot) !== item.snapshot_digest
      || item.pending_item_ids.some(id => !pendingIds.has(id))) return false
    requests.add(item.clarification_request_id)
    sources.add(item.snapshot.source_message_id)
  }
  return Buffer.byteLength(JSON.stringify(input), 'utf8') <= 1024 * 1024
}
/**
 * Validate private coordinator JSON before joining Profile queues or persisting a manifest.
 * @param value - Original/reply snapshots, selected pending identities and fixed mention order.
 * @returns detached, deeply frozen input; parsing grants neither model dispatch nor task admission.
 * @throws when digests, ownership, model, identities, evidence or input budgets disagree.
 */
export function parseCollaborationClarificationInput(value: unknown): CollaborationClarificationInput {
  try {
    const parsed = schema.parse(value)
    if (!valid(parsed)) throw Error('invalid clarification input')
    return deepFreeze(parsed)
  } catch (error) {
    throw Error('collaboration_clarification_input_invalid', { cause: error })
  }
}


/**
 * Serialize only task-relevant messages and pending identities for the zero-tool analysis.
 * @param input - Parsed and frozen coordinator input.
 * @returns exact model-visible user text, excluding credentials, plan transport metadata and accepted task IDs.
 */
export function clarificationAnalysisMessage(input: CollaborationClarificationInput): string {
  const original = input.original_snapshot
  const reply = (snapshot: CollaborationSourceSnapshot) => ({ source_message_id: snapshot.source_message_id,
    source_revision: snapshot.source_revision, original_message: snapshot.original_message })
  return JSON.stringify({ original_request: { ...reply(original), active_mentions: original.active_mentions },
    clarification_messages: [...input.prior_replies.map(item => reply(item.snapshot)), reply(input.reply_snapshot)],
    pending_items: input.pending_items, mention_order: input.mention_order,
  })
}
