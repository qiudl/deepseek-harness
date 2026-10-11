/** REQ-20261004-0008: first durable assistant reply in the original consumer step. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'
import { observeCollaborationFeedback } from './collaboration-feedback.ts'
import { collaborationConsumptionCommit, parseCollaborationConsumptionRecord, type CollaborationConsumptionRecord } from './collaboration-consumption-journal.ts'

const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const schema = z.strictObject({
  schema_version: z.literal(1),
  observation_id: z.uuid(),
  consumption: z.unknown().transform((value, ctx) => {
    try {
      const record = parseCollaborationConsumptionRecord(value)
      if (record.state !== 'consumed') throw Error('consumption_missing')
      return record
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid consumed record' })
      return z.NEVER
    }
  }),
  assistant_event_seq: seq,
  session_prefix: z.strictObject({ event_count: seq, log_digest: z.string().regex(/^[a-f0-9]{64}$/u) }),
}).refine(r => r.assistant_event_seq > r.consumption.evidence.session_event_seq
  && r.assistant_event_seq < r.session_prefix.event_count
  && r.session_prefix.event_count >= r.consumption.evidence.session_prefix.event_count)
type ObservationRecord = Readonly<z.infer<typeof schema>>
const spec = defineDomain({ name: 'collaboration_continuation_v1', version: 1, layout: 'single',
  tables: { observations: domainTable<string, ObservationRecord>(schema) } })

interface ContinuationJournal {
  observe(consumption: CollaborationConsumptionRecord, sessionId: SessionId,
    events: readonly SessionEvent[], message: UserMessage, signal: AbortSignal): Promise<ObservationRecord | undefined>
  close(): Promise<void>
}
type ContinuationCommit = Readonly<{
  consumption: NonNullable<ReturnType<typeof collaborationConsumptionCommit>>
  observation_id: string
  observation_kind: 'assistant_message_committed'
  assistant_event_seq: number
  session_prefix: ObservationRecord['session_prefix']
}>
/** Open first-reply observations independently of the released consumption writer.
 * @param facility - Original Profile's single-writer durable storage owner.
 * @returns Serialized observer; recovery never grants permission to run a model.
 */
export async function openCollaborationContinuationJournal(facility: Pick<DomainFacility, 'open'>): Promise<ContinuationJournal> {
  const domain = await facility.open(spec), table = domain.table('observations')
  try {
    if (table.size > 4096) throw Error('collaboration_continuation_capacity')
    const ids = new Set<string>()
    for (const [key, record] of table.entries()) {
      if (key !== record.consumption.consumption_id || ids.has(record.observation_id)) throw Error('collaboration_continuation_corrupt')
      ids.add(record.observation_id)
      deepFreeze(record)
    }
  } catch (error) { await domain.close(); throw error }
  let tail = Promise.resolve(), closing: Promise<void> | undefined, uncertain = false
  const healthy = () => { if (closing || uncertain) throw Error('collaboration_continuation_recovery_required') }
  return {
    /** Capture the first reply only from events read after the Session persistence barrier.
     * @param consumption - Original durable consumer record.
     * @param sessionId - Session identity supplied by the persistence owner.
     * @param events - Contiguous persisted prefix from that record's Session.
     * @param message - Exact deterministic feedback message owned by the Profile.
     * @param signal - Current Profile and caller lifetime.
     * @returns First immutable observation, or undefined while no reply has committed.
     */
    async observe(consumption: CollaborationConsumptionRecord, sessionId: SessionId,
      events: readonly SessionEvent[], message: UserMessage, signal: AbortSignal) {
      healthy(); signal.throwIfAborted()
      const work = tail.then(async () => {
        healthy(); signal.throwIfAborted()
        if (consumption.state !== 'consumed') throw Error('collaboration_continuation_consumption_missing')
        if (sessionId !== consumption.binding.source_locator.session_id || events.some((event, index) => event.seq !== index))
          throw Error('collaboration_continuation_binding_conflict')
        const observed = observeCollaborationFeedback(events, message), evidence = consumption.evidence
        if (message.id !== consumption.binding.message_id || observed.status !== 'context_applied'
          || observed.session_event_seq !== evidence.session_event_seq || hash(observed.consuming_step) !== hash(evidence.consuming_step)
          || events.length < evidence.session_prefix.event_count
          || hash(events.slice(0, evidence.session_prefix.event_count)) !== evidence.session_prefix.log_digest)
          throw Error('collaboration_continuation_binding_conflict')
        const prior = table.get(consumption.consumption_id)
        if (prior) {
          if (hash(prior.consumption) !== hash(consumption) || prior.assistant_event_seq !== observed.assistant_event_seq
            || events.length < prior.session_prefix.event_count
            || hash(events.slice(0, prior.session_prefix.event_count)) !== prior.session_prefix.log_digest)
            throw Error('collaboration_continuation_binding_conflict')
          return prior
        }
        if (observed.assistant_event_seq === undefined) return undefined
        if (table.size >= 4096) throw Error('collaboration_continuation_capacity')
        const record = deepFreeze(schema.parse({ schema_version: 1, observation_id: randomUUID(), consumption,
          assistant_event_seq: observed.assistant_event_seq,
          session_prefix: { event_count: observed.event_count, log_digest: observed.log_digest } }))
        try { await table.put(consumption.consumption_id, record) } catch (error) { uncertain = true; throw error }
        return record
      })
      tail = work.then(() => {}, () => {})
      return work
    },
    close() { closing ??= tail.then(() => domain.close()); return closing },
  }
}

/** Project immutable coordinates without copying assistant content into the receipt.
 * @param record - Committed first-reply observation.
 * @returns New-domain commit retaining the original consumption binding and its separate prefix.
 */
export function collaborationContinuationCommit(record: ObservationRecord): ContinuationCommit {
  return deepFreeze({ consumption: collaborationConsumptionCommit(record.consumption) as ContinuationCommit['consumption'], observation_id: record.observation_id,
    observation_kind: 'assistant_message_committed' as const, assistant_event_seq: record.assistant_event_seq, session_prefix: record.session_prefix })
}

/** Private read result; absence certifies no durable original-step reply. */
export type CollaborationContinuationResult = { kind: 'continuation'; commit: ReturnType<typeof collaborationContinuationCommit> | null }
