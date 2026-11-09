/** REQ-20261031-0006 / Task26557: original consumed-step metadata, without attribution or permission. */
import { createHash } from 'node:crypto'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CollaborationConsumptionRecord } from './collaboration-consumption-journal.ts'
import { collaborationJournalDigest, encodeCollaborationJournalJson } from './collaboration-source-journal.ts'

/** Exact original native events; arguments and results are never included. */
export interface OriginalCollaborationOperationPair {
  readonly callId: string
  readonly toolName: string
  readonly callSeq: number
  readonly callTime: number
  readonly callEventDigest: string
  readonly resultSeq: number
  readonly resultTime: number
  readonly resultEventDigest: string
}

const fail = (code: string): never => { throw Error('collaboration_operation_origin_' + code) }
const eventDigest = (event: SessionEvent): string => createHash('sha256')
  .update('dsh.project-operation-source-event/v1\0').update(encodeCollaborationJournalJson(event)).digest('hex')

/** Inspect the original consumed step in a fixed raw durable prefix.
 * @param record - Actual parsed consumption journal entry; prepared/started entries do not qualify.
 * @param events - Contiguous original persisted events, captured by the owning provider's durability barrier.
 * @param inheritedEventCount - Exact inherited prefix supplied by that same persistence handle.
 * @param afterResultSeq - Exclusive original result-sequence boundary, or null for the first page.
 * @returns At most50 completed native pairs and the actual prefix digest; establishes no owner/project or sharing right.
 */
export function observeOriginalCollaborationOperations(record: CollaborationConsumptionRecord, events: readonly SessionEvent[],
  inheritedEventCount: number, afterResultSeq: number | null = null): {
  readonly pairs: readonly OriginalCollaborationOperationPair[]
  readonly durableEventCount: number
  readonly durableLogDigest: string
  readonly eof: boolean
} {
  if (record.state !== 'consumed') return fail('not_consumed')
  const { evidence } = record, step = evidence.consuming_step
  if (step.start_event_seq < inheritedEventCount) return fail('inherited')
  if (events.some((event, index) => event.seq !== index) || evidence.session_prefix.event_count > events.length
    || collaborationJournalDigest(events.slice(0, evidence.session_prefix.event_count)) !== evidence.session_prefix.log_digest)
    return fail('prefix_changed')
  const start = events[step.start_event_seq], consumed = events[evidence.session_event_seq]
  if (start?.type !== 'step/start' || start.data.turn !== step.turn || start.data.step !== step.step
    || consumed?.type !== 'user/message' || consumed.data.id !== record.binding.message_id) return fail('consumption_changed')
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
  const seen = new Set<string>(), pairs: OriginalCollaborationOperationPair[] = []
  let eof = true
  // Inspect the complete step even after the output limit, so a second consumed
  // input cannot be hidden by paging before that input.
  for (const event of events.slice(step.start_event_seq + 1)) {
    if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/end') break
    if (event.type === 'user/message' && event.seq !== evidence.session_event_seq) return fail('ambiguous_input')
    if (event.type === 'tool/call') {
      if (event.seq < evidence.session_prefix.event_count || event.data.turn !== step.turn || event.data.step !== step.step
        || seen.has(event.data.callId)) return fail('call_changed')
      seen.add(event.data.callId); calls.set(event.data.callId, event)
    } else if (event.type === 'tool/result') {
      const call = calls.get(event.data.message.toolCallId)
      if (!call || event.data.turn !== step.turn || event.data.step !== step.step
        || event.data.message.source.callId !== call.data.callId)
        return fail('result_changed')
      calls.delete(call.data.callId)
      if (call.data.name === RUN_CODE_NAME) continue
      if (afterResultSeq !== null && event.seq <= afterResultSeq) continue
      if (pairs.length === 50) { eof = false; continue }
      pairs.push({ callId: call.data.callId, toolName: call.data.name,
        callSeq: call.seq, callTime: call.time, callEventDigest: eventDigest(call),
        resultSeq: event.seq, resultTime: event.time, resultEventDigest: eventDigest(event) })
    }
  }
  return { pairs, durableEventCount: events.length, durableLogDigest: collaborationJournalDigest(events), eof }
}
