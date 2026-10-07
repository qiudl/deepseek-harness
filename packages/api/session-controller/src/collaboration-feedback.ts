import { bindRequestTrace } from '@deepseek-ai/dsh-llm'
import { parseCollaborationConsumptionGrant } from './collaboration-consumption-journal.ts'
/** Original-root feedback uses the existing plugin relay and durable inbox vocabulary. */
import { z } from 'zod'
import { parseCollaborationRootTarget } from './collaboration-root-journal.ts'
import { parseCollaborationExecutionSelection } from './collaboration-root-execution-journal.ts'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { parseCollaborationExecutionRecord } from './collaboration-root-execution-journal.ts'
import { parseCollaborationDeliveryRecord } from './collaboration-delivery-journal.ts'
import { collaborationJournalDigest, parseCollaborationSourceSnapshot, describeCollaborationSource } from './collaboration-source-journal.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Attribution for a committed Slark result; readers preserve the complete logged text without this producer.
     * @persistenceAttribution
     */
    'collaboration-result': { readonly kind: 'collaboration-result'; readonly form: 'relay' }
  }
}

/** Persisted evidence; queued input alone certifies neither model consumption nor continuation. */
export interface CollaborationFeedbackObservation {
  readonly message_id: MessageId
  readonly status: 'not_enqueued' | 'queued' | 'claimed_or_removed' | 'context_applied'
  readonly event_count: number
  readonly log_digest: string
  readonly session_event_seq?: number
  readonly consuming_step?: { readonly turn: number; readonly step: number; readonly start_event_seq: number }
  readonly assistant_event_seq?: number
  readonly continuation_observed: boolean
}
/** Build one deterministic relay from the original admitted invocation and committed reply.
 * @param executionValue - Original durable concrete execution, including its historical admission receipt.
 * @param deliveryValue - Immutable Profile reply; the caller checks current Source and cloud authorization separately.
 * @param sourceValue - Original committed Source snapshot containing the initiating user message.
 * @returns Complete model-visible relay. Parsing and matching do not grant permission to enqueue or continue.
 */
export function createCollaborationFeedbackMessage(executionValue: unknown, deliveryValue: unknown, sourceValue: unknown): UserMessage {
  const execution = parseCollaborationExecutionRecord(executionValue)
  const delivery = parseCollaborationDeliveryRecord(deliveryValue)
  const source = parseCollaborationSourceSnapshot(sourceValue)
  if (describeCollaborationSource(source).snapshot_digest !== delivery.source_snapshot_digest
    || Object.entries(delivery.source_locator).some(([key, value]) => source[key as keyof typeof delivery.source_locator] !== value)
    || execution.state !== 'admitted' || execution.root.namespace_id !== delivery.namespace_id
    || execution.root.source_digest !== delivery.source_snapshot_digest
    || execution.receipt.invocation_id !== delivery.invocation_id || execution.selection.plan_id !== delivery.plan_id
    || execution.selection.task_id !== delivery.task_id || execution.selection.task_revision !== delivery.task_revision)
    throw Error('collaboration_feedback_execution_mismatch')
  const identity = { namespace_id: delivery.namespace_id, root_task_id: execution.root.root_task_id,
    root_trace_id: execution.root.root_trace_id, execution_command_id: execution.execution_command_id,
    invocation_id: delivery.invocation_id, delivery_id: delivery.delivery_id, result_digest: delivery.result_digest }
  return { id: brandString<MessageId>('collaboration-feedback-' + collaborationJournalDigest(identity)), role: 'user',
    source: { kind: 'collaboration-result', form: 'relay' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'collaboration_result', ...identity,
      plan_id: delivery.plan_id, task_id: delivery.task_id, task_revision: delivery.task_revision,
      source: delivery.source_locator, original_message: source.original_message, target: delivery.target,
      execution_state: delivery.execution_state,
      answer: delivery.answer ?? null, failure_code: delivery.failure_code ?? null }) }] }
}
/** Inspect an already validated, persisted Session prefix without dispatching or changing input.
 * @param events - Full contiguous Session log, read after the persistence barrier by the owning controller.
 * @param message - Deterministic original relay with the complete expected content.
 * @returns Historical enqueue/consumption evidence and exact prefix token for a subsequent compare-and-enqueue.
 */
export function observeCollaborationFeedback(events: readonly SessionEvent[], message: UserMessage): CollaborationFeedbackObservation {
  const pending = { 'next-turn': [] as UserMessage[], 'next-step': [] as UserMessage[] }
  let inserted = false, consumed: number | undefined, consumingStep = false, continuation = false, stepOpen = false
  let activeStep: CollaborationFeedbackObservation['consuming_step']
  let admittedStep: CollaborationFeedbackObservation['consuming_step'], assistantSeq: number | undefined
  const match = (candidate: UserMessage): void => {
    if (!isDeepStrictEqual(candidate, message)) throw Error('collaboration_feedback_message_conflict')
  }
  for (const event of events) {
    if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') {
      consumingStep = false; stepOpen = event.type === 'step/start'
      activeStep = event.type === 'step/start' ? { turn: event.data.turn, step: event.data.step, start_event_seq: event.seq } : undefined
    }
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data, queue = pending[splice.target], removed = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > queue.length
        || !Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > queue.length)
        throw Error('collaboration_feedback_history_invalid')
      for (const item of splice.inserted) if (item.id === message.id) {
        match(item)
        if (inserted || consumed !== undefined) throw Error('collaboration_feedback_message_conflict')
        inserted = true
      }
      pending[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
    }
    if (event.type === 'user/message' && event.data.id === message.id) {
      match(event.data)
      if (!inserted || !stepOpen || consumed !== undefined) throw Error('collaboration_feedback_message_conflict')
      if (!activeStep || !Number.isSafeInteger(activeStep.turn) || activeStep.turn < 0
        || !Number.isSafeInteger(activeStep.step) || activeStep.step < 0) throw Error('collaboration_feedback_history_invalid')
      consumed = event.seq; consumingStep = true; admittedStep = activeStep
    }
    if (event.type === 'assistant/message' && consumingStep) { continuation = true; assistantSeq ??= event.seq }
  }
  return { message_id: message.id,
    status: consumed !== undefined ? 'context_applied'
      : pending['next-step'].some(m => m.id === message.id) || pending['next-turn'].some(m => m.id === message.id)
        ? 'queued' : inserted ? 'claimed_or_removed' : 'not_enqueued',
    event_count: events.length, log_digest: collaborationJournalDigest(events),
    ...(consumed === undefined ? {} : { session_event_seq: consumed }),
    ...(admittedStep === undefined ? {} : { consuming_step: admittedStep }),
    ...(assistantSeq === undefined ? {} : { assistant_event_seq: assistantSeq }), continuation_observed: continuation }
}

const targetSchema = z.unknown().transform((value, ctx) => {
  try { return parseCollaborationRootTarget(value) } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid feedback target' }); return z.NEVER
  }
})
const selectionSchema = z.unknown().transform((value, ctx) => {
  try { return parseCollaborationExecutionSelection(value) } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid feedback selection' }); return z.NEVER
  }
})
const shared = { target: targetSchema, selection: selectionSchema,
  delivery_id: z.string().refine(value => /^[!-~]{1,256}$/u.exec(value)?.[0] === value).refine(value => !/[/\\]/u.test(value) && value !== '.' && value !== '..') }
const operationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), ...shared }),
  z.strictObject({ action: z.literal('consumer_read'), ...shared }),
  z.strictObject({ action: z.literal('continuation_read'), ...shared }),
  z.strictObject({ action: z.literal('consumer_prepare'), ...shared, expected_event_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expected_log_digest: z.string().regex(/^[0-9a-f]{64}$/u) }),
  z.strictObject({ action: z.literal('consumer_start'), ...shared, grant: z.unknown().transform((value, ctx) => { try { return parseCollaborationConsumptionGrant(value) } catch { ctx.addIssue({ code: 'custom', message: 'invalid consumer grant' }); return z.NEVER } }) }),
  z.strictObject({ action: z.literal('enqueue'), ...shared, expected_event_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expected_log_digest: z.string().refine(value => /^[0-9a-f]{64}$/u.exec(value)?.[0] === value) }),
])
/** Parse private feedback commands without accepting caller content, trace IDs or receipt overrides.
 * @param value - Original root and execution selection, delivery identity and optional exact Session prefix.
 * @returns Detached command. The parent must authorize result consumption under the current Account.
 */
export function parseCollaborationFeedbackOperation(value: unknown): z.infer<typeof operationSchema> {
  const result = operationSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_feedback_operation_invalid')
  return deepFreeze(result.data)
}

/** Block participating Session dispatch until its complete logged context has reached durable storage.
 * @param ctx - Session Controller owner; registrations unwind with its Profile lifetime.
 * @param checkpoint - Optional Profile-owned consumption barrier before adapter dispatch.
 * @param participates - Read participation from durable root records, independently of message-source attribution.
 */
export function installCollaborationFeedbackCheckpoint(ctx: import('@deepseek-ai/cordis').Context,
  participates: (sessionId: SessionId) => Promise<boolean>, checkpoint?: (sessionId: SessionId) => Promise<string | undefined>): void {
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    return (async function* () {
      if (options.sessionId === undefined || !await participates(options.sessionId)) { yield* next(); return }
      const session = ctx.sessions.get(options.sessionId)
      if (!session || !ctx.get('sessionPersistence')) throw Error('collaboration_feedback_persistence_unavailable')
      if (!await ctx.sessions.flush(session)) throw Error('collaboration_feedback_persistence_unconfirmed')
      options.signal?.throwIfAborted()
      if (ctx.sessions.get(session.id) !== session) throw Error('collaboration_feedback_session_changed')
      const traceparent = await checkpoint?.(session.id)
      if (traceparent !== undefined) bindRequestTrace(options, traceparent)
      options.signal?.throwIfAborted()
      yield* next()
    })()
  })
}
