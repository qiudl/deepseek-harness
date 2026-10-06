/** REQ-20261004-0008: Profile-owned consumer commands and persisted Session consumption evidence. */
import { randomUUID, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'
import type { CollaborationFeedbackObservation } from './collaboration-feedback.ts'
const exact = (re: RegExp) => z.string().refine(value => re.exec(value)?.[0] === value)
const uuid = z.uuid(),
  digest = exact(/^[a-f0-9]{64}$/u),
  seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const opaque = exact(/^[!-~]{1,256}$/u).refine(value => !/[/\\]/u.test(value) && value !== '.' && value !== '..')
const time = z.iso.datetime().refine(value => new Date(value).toISOString() === value)
const root = {
  namespace_id: exact(/^n2_[a-f0-9]{64}$/u),
  root_task_id: uuid,
  root_trace_id: exact(/^(?!0{32}$)[a-f0-9]{32}$/u),
  execution_command_id: uuid,
  delivery_id: opaque,
  result_digest: digest,
  message_id: exact(/^collaboration-feedback-[a-f0-9]{64}$/u),
}
const bindingSchema = z.strictObject({
  ...root,
  invocation_id: opaque,
  source_snapshot_digest: digest,
  source_locator: z.strictObject({
    workspace_id: uuid,
    session_id: opaque,
    source_message_id: opaque,
    source_revision: exact(/^[1-9][0-9]{0,18}$/u),
  }),
})
const commandSchema = z.strictObject({ command_id: uuid, expected_event_count: seq, expected_log_digest: digest })
const { namespace_id: _namespace, ...grantRoot } = root
const grantSchema = z
  .strictObject({
    ...grantRoot,
    ...commandSchema.shape,
    task_revision: z.literal(1),
    session_id: opaque,
    command_digest: digest,
    consumer_attempt_id: uuid,
    consumer_step_id: uuid,
    issued_at: time,
    expires_at: time,
    dispatch_granted: z.boolean(),
  })
  .refine(g => Date.parse(g.expires_at) > Date.parse(g.issued_at) && Date.parse(g.expires_at) - Date.parse(g.issued_at) <= 120000)
const common = { schema_version: z.literal(1), binding: bindingSchema, command: commandSchema }
const started = { grant: grantSchema, consumption_id: uuid, consumer_started_at: time }
const evidence = z.strictObject({
  session_event_seq: seq,
  consuming_step: z.strictObject({ turn: seq, step: seq, start_event_seq: seq }),
  session_prefix: z.strictObject({ event_count: seq, log_digest: digest }),
})
const recordSchema = z
  .discriminatedUnion('state', [
    z.strictObject({ ...common, state: z.literal('prepared') }),
    z.strictObject({ ...common, ...started, state: z.literal('started') }),
    z.strictObject({ ...common, ...started, evidence, state: z.literal('consumed') }),
  ])
  .refine(
    r =>
      r.state === 'prepared' ||
      (matches(r.binding, r.command, r.grant) &&
        r.grant.dispatch_granted &&
        Date.parse(r.consumer_started_at) >= Date.parse(r.grant.issued_at) &&
        Date.parse(r.consumer_started_at) < Date.parse(r.grant.expires_at) &&
        (r.state !== 'consumed' ||
          (r.evidence.consuming_step.start_event_seq >= r.command.expected_event_count &&
            r.evidence.consuming_step.start_event_seq < r.evidence.session_event_seq &&
            r.evidence.session_event_seq < r.evidence.session_prefix.event_count))),
  )
/** Original immutable root, execution and result binding. */
export type CollaborationConsumptionBinding = Readonly<z.infer<typeof bindingSchema>>
/** Durable command and first consumption evidence; never an executable recovery handle. */
export type CollaborationConsumptionRecord = Readonly<z.infer<typeof recordSchema>>
const requestSchema = z.strictObject({
  request_id: uuid,
  consumption_id: uuid,
  consumer_attempt_id: uuid,
  root_task_id: uuid,
  root_trace_id: root.root_trace_id,
  session_id: opaque,
  turn: seq,
  step: seq,
  traceparent: exact(/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-01$/u),
})
const spec = defineDomain({
  name: 'collaboration_consumption_v1',
  version: 1,
  layout: 'single',
  tables: {
    commands: domainTable<string, CollaborationConsumptionRecord>(recordSchema),
    requests: domainTable<string, z.infer<typeof requestSchema>>(requestSchema),
  },
})
function key(b: CollaborationConsumptionBinding) {
  return hash([b.namespace_id, b.delivery_id])
}
function matches(b: CollaborationConsumptionBinding, c: z.infer<typeof commandSchema>, g: z.infer<typeof grantSchema>) {
  const body = {
    namespace_id: b.namespace_id,
    root_task_id: b.root_task_id,
    root_trace_id: b.root_trace_id,
    task_revision: 1,
    execution_command_id: b.execution_command_id,
    delivery_id: b.delivery_id,
    result_digest: b.result_digest,
    message_id: b.message_id,
    session_id: b.source_locator.session_id,
    ...c,
  }
  return (
    g.command_digest === hash(body) && Object.entries(body).every(([k, value]) => k === 'namespace_id' || g[k as keyof typeof g] === value)
  )
}
type ConsumptionCommit = CollaborationConsumptionBinding & z.infer<typeof evidence> & {
  task_revision: 1
  consumption_id: string
  consumer_attempt_id: string
  consumer_step_id: string
  consumer_started_at: string
  host_journal_commit: { journal_id: string; commit_version: string; content_digest: string }
}
interface ConsumptionJournal {
  read(value: unknown): CollaborationConsumptionRecord | undefined
  records(): CollaborationConsumptionRecord[]
  prepare(value: unknown, prefix: { event_count: number; log_digest: string }, signal: AbortSignal): Promise<CollaborationConsumptionRecord>
  start(value: unknown, grant: unknown, signal: AbortSignal): Promise<{ record: CollaborationConsumptionRecord; wake: boolean }>
  consume(value: unknown, observation: CollaborationFeedbackObservation, signal: AbortSignal): Promise<CollaborationConsumptionRecord>
  request(value: unknown, step: { turn: number; step: number }, signal: AbortSignal): Promise<z.infer<typeof requestSchema>>
  close(): Promise<void>
}
/** Open a strict separate domain; uncertain writes poison its handle until reopen.
 * @param facility - Original Profile's single-writer storage facility.
 * @returns Durable one-shot journal; historical records never restore permission to wake an Agent.
 */
export async function openCollaborationConsumptionJournal(facility: Pick<DomainFacility, 'open'>): Promise<ConsumptionJournal> {
  const domain = await facility.open(spec),
    table = domain.table('commands')
  try {
    if (table.size > 4096) throw Error('collaboration_consumption_capacity')
    const ids = new Set<string>()
    for (const [k, r] of table.entries()) {
      if (k !== key(r.binding) || ids.has(r.command.command_id)) throw Error('collaboration_consumption_corrupt')
      ids.add(r.command.command_id)
      deepFreeze(r)
    }
    const consumed = new Map([...table.entries()].flatMap(([, r]) => r.state === 'consumed' ? [[r.consumption_id, r] as const] : []))
    const requests = domain.table('requests')
    if (requests.size > 16384) throw Error('collaboration_consumption_request_capacity')
    for (const [id, request] of requests.entries()) {
      const r = consumed.get(request.consumption_id)
      if (id !== request.request_id || !r || request.consumer_attempt_id !== r.grant.consumer_attempt_id
        || request.root_task_id !== r.binding.root_task_id || request.root_trace_id !== r.binding.root_trace_id
        || request.traceparent.split('-')[1] !== r.binding.root_trace_id || request.session_id !== r.binding.source_locator.session_id
        || request.turn !== r.evidence.consuming_step.turn || request.step < r.evidence.consuming_step.step)
        throw Error('collaboration_consumption_request_corrupt')
    }
  } catch (error) {
    await domain.close()
    throw error
  }
  let tail = Promise.resolve(),
    closing: Promise<void> | undefined,
    uncertain = false
  const healthy = () => {
    if (closing || uncertain) throw Error('collaboration_consumption_recovery_required')
  }
  const queue = <T>(signal: AbortSignal, action: () => Promise<T>) => {
    healthy()
    signal.throwIfAborted()
    const work = tail.then(() => {
      healthy()
      signal.throwIfAborted()
      return action()
    })
    tail = work.then(
      () => {},
      () => {},
    )
    return work
  }
  const read = (value: unknown) => {
    healthy()
    const b = bindingSchema.parse(value),
      r = table.get(key(b))
    if (r && hash(r.binding) !== hash(b)) throw Error('collaboration_consumption_conflict')
    return r
  }
  const put = async (value: unknown) => {
    const r = deepFreeze(recordSchema.parse(value))
    try {
      await table.put(key(r.binding), r)
    } catch (error) {
      uncertain = true
      throw error
    }
    return r
  }
  return {
    read,
    records() {
      healthy()
      return [...table.entries()].map(([, r]) => r)
    },
    async prepare(value: unknown, prefix: { event_count: number; log_digest: string }, signal: AbortSignal) {
      const b = deepFreeze(bindingSchema.parse(value)),
        p = z.strictObject({ event_count: seq, log_digest: digest }).parse(prefix)
      return queue(signal, async () => {
        const previous = read(b)
        if (previous) {
          if (previous.command.expected_event_count !== p.event_count || previous.command.expected_log_digest !== p.log_digest)
            throw Error('collaboration_consumption_conflict')
          return previous
        }
        if (table.size >= 4096) throw Error('collaboration_consumption_capacity')
        return put({
          schema_version: 1,
          state: 'prepared',
          binding: b,
          command: { command_id: randomUUID(), expected_event_count: p.event_count, expected_log_digest: p.log_digest },
        })
      })
    },
    async start(value: unknown, grant: unknown, signal: AbortSignal) {
      const b = deepFreeze(bindingSchema.parse(value)),
        g = deepFreeze(grantSchema.parse(grant))
      return queue(signal, async () => {
        const previous = read(b)
        if (!previous || !matches(b, previous.command, g)) throw Error('collaboration_consumption_conflict')
        if (previous.state !== 'prepared') {
          if (hash({ ...previous.grant, dispatch_granted: false }) !== hash({ ...g, dispatch_granted: false }))
            throw Error('collaboration_consumption_conflict')
          return { record: previous, wake: false }
        }
        const now = Date.now()
        if (!g.dispatch_granted || now < Date.parse(g.issued_at) || now >= Date.parse(g.expires_at))
          throw Error('collaboration_consumption_grant_expired')
        const record = await put({
          ...previous,
          state: 'started',
          grant: g,
          consumption_id: randomUUID(),
          consumer_started_at: new Date(now).toISOString(),
        })
        return { record, wake: true }
      })
    },
    async consume(value: unknown, observation: CollaborationFeedbackObservation, signal: AbortSignal) {
      const b = deepFreeze(bindingSchema.parse(value))
      const o = structuredClone(observation)
      return queue(signal, async () => {
        const previous = read(b)
        if (
          !previous ||
          previous.state === 'prepared' ||
          o.status !== 'context_applied' ||
          o.message_id !== b.message_id ||
          o.session_event_seq === undefined ||
          !o.consuming_step
        )
          throw Error('collaboration_consumption_evidence_missing')
        const found = {
          session_event_seq: o.session_event_seq,
          consuming_step: o.consuming_step,
          session_prefix: { event_count: o.event_count, log_digest: o.log_digest },
        }
        if (previous.state === 'consumed') {
          if (
            previous.evidence.session_event_seq !== found.session_event_seq ||
            hash(previous.evidence.consuming_step) !== hash(found.consuming_step)
          )
            throw Error('collaboration_consumption_conflict')
          return previous // Retain the first persisted prefix; later turns never change the signed fact.
        }
        return put({ ...previous, state: 'consumed', evidence: found })
      })
    },
    async request(value: unknown, step: { turn: number; step: number }, signal: AbortSignal) {
      const b = bindingSchema.parse(value)
      return queue(signal, async () => {
        const r = read(b)
        if (!r || r.state !== 'consumed' || r.evidence.consuming_step.turn !== step.turn)
          throw Error('collaboration_consumption_request_unbound')
        const requests = domain.table('requests')
        if (requests.size >= 16384) throw Error('collaboration_consumption_request_capacity')
        let span: string
        do {
          span = randomBytes(8).toString('hex')
        } while (span === '0'.repeat(16))
        const request = deepFreeze(
          requestSchema.parse({
            request_id: randomUUID(),
            consumption_id: r.consumption_id,
            consumer_attempt_id: r.grant.consumer_attempt_id,
            root_task_id: b.root_task_id,
            root_trace_id: b.root_trace_id,
            session_id: b.source_locator.session_id,
            ...step,
            traceparent: '00-' + b.root_trace_id + '-' + span + '-01',
          }),
        )
        try {
          await requests.put(request.request_id, request)
        } catch (error) {
          uncertain = true
          throw error
        }
        return request
      })
    },
    close() {
      closing ??= tail.then(() => domain.close())
      return closing
    },
  }
}

/** Build evidence only from a committed consumer record; the Host adds current installation authority.
 * @param record - Strict durable record recovered from the original Profile domain.
 * @returns Immutable consumption commit, or undefined before actual Session application.
 */
export function collaborationConsumptionCommit(record: CollaborationConsumptionRecord): ConsumptionCommit | undefined {
  if (record.state !== 'consumed') return undefined
  const r = recordSchema.parse(record)
  if (r.state !== 'consumed') return undefined
  return deepFreeze({
    ...r.binding,
    task_revision: 1 as const,
    consumption_id: r.consumption_id,
    consumer_attempt_id: r.grant.consumer_attempt_id,
    consumer_step_id: r.grant.consumer_step_id,
    consumer_started_at: r.consumer_started_at,
    ...r.evidence,
    host_journal_commit: { journal_id: r.consumption_id, commit_version: '1', content_digest: hash(r) },
  })
}
/** Parse a private cloud grant before the owner performs asynchronous work.
 * @param value - Complete cloud grant, with one-shot dispatch fact and fixed deadline.
 * @returns Detached immutable grant. Binding and current dispatch checks still occur at start.
 */
export function parseCollaborationConsumptionGrant(value: unknown): Readonly<z.infer<typeof grantSchema>> {
  return deepFreeze(grantSchema.parse(value))
}

/** Private consumer response. Historical facts grant no permission to wake an Agent. */
export type CollaborationConsumptionResult = Readonly<{
  kind: 'consumer'
  record: CollaborationConsumptionRecord | null
  observation: CollaborationFeedbackObservation
  commit?: ReturnType<typeof collaborationConsumptionCommit>
}>
