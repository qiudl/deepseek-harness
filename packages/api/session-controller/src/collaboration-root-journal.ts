import type { SessionId } from '@deepseek-ai/dsh-session'
/** REQ-20261004-0008: Profile-owned root submissions; independent of released Session and Source formats. */
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { collaborationJournalDigest, describeCollaborationSource, parseCollaborationSourceSnapshot, parseCollaborationSourceInput, parseCollaborationSourceCoordinates } from './collaboration-source-journal.ts'

/** Logical root identity, distinct from Session or leaf task identities. */
export type CollaborationRootTaskId = Branded<'CollaborationRootTaskId'>
/** Stable user-visible trace identity across transport attempts. */
export type CollaborationRootTraceId = Branded<'CollaborationRootTraceId'>
/** Immutable root-admission command identity. */
export type CollaborationRootCommandId = Branded<'CollaborationRootCommandId'>
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const rootId = uuid.transform(brandString<CollaborationRootTaskId>)
const commandId = uuid.transform(brandString<CollaborationRootCommandId>)
const traceId = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/).transform(brandString<CollaborationRootTraceId>)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const ref = z.string().regex(/^[!-~]{1,256}$/)
const source = z.unknown().transform((value, ctx) => {
  try { return parseCollaborationSourceSnapshot(value) } catch {
    ctx.addIssue({ code: 'custom', message: 'collaboration_root_source_invalid' }); return z.NEVER
  }
})
const inputSchema = z.strictObject({ namespace_id: z.string().regex(/^n2_[0-9a-f]{64}$/), source,
  objective_ref: ref, task_grant_ref: ref, continuation_policy: z.enum(['display_only', 'follow_authorized_plan']) })
const receiptSchema = z.strictObject({ root_task_id: rootId, root_trace_id: traceId, admission_id: commandId,
  task_revision: z.literal(1), state_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['active', 'waiting_input', 'waiting_host', 'reconciling', 'succeeded', 'failed', 'cancelled']) })
const common = { ...inputSchema.shape, schema_version: z.literal(1), root_task_id: rootId, root_trace_id: traceId,
  command_id: commandId, source_digest: digest, payload_digest: digest }
const recordSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...common, state: z.literal('pending') }),
  z.strictObject({ ...common, state: z.literal('admitted'), receipt: receiptSchema }),
]).refine(value => value.source_digest === describeCollaborationSource(value.source).snapshot_digest
  && value.payload_digest === collaborationJournalDigest(business(value))
  && (value.state === 'pending' || receiptMatches(value, value.receipt)))
const captureSchema = inputSchema.extend({ objective_ref: ref.optional(), task_grant_ref: ref.optional(),
  source: z.unknown().transform((value, ctx) => {
    try { return parseCollaborationSourceInput(value) } catch {
      ctx.addIssue({ code: 'custom', message: 'collaboration_root_source_invalid' }); return z.NEVER
    }
  }) }).refine(value => (value.objective_ref === undefined) === (value.task_grant_ref === undefined))
/** Original user input plus policy supplied by the authenticated Host; no model or root overrides. */
export type CollaborationRootCaptureInput = Readonly<z.infer<typeof captureSchema>>
/**
 * Validate private Host input before model preparation or Source persistence.
 * @param value - Exact source coordinates/content and root policy; authority is checked by the caller.
 * @returns Detached frozen input with no caller-selected root or model metadata.
 */
export function parseCollaborationRootCaptureInput(value: unknown): CollaborationRootCaptureInput {
  const result = captureSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_root_journal_invalid')
  return freeze(result.data)
}
/** Validated original source and intended root policy; caller supplies current namespace/grant authority. */
export type CollaborationRootInput = Readonly<z.infer<typeof inputSchema>>
/** Immutable aggregate. A pending entry is the submission outbox, not evidence of cloud admission. */
export type CollaborationRootSubmission = Readonly<z.infer<typeof recordSchema>>
/** Original cloud admission receipt; transport authentication remains the caller's responsibility. */
export type CollaborationRootAdmission = Readonly<z.infer<typeof receiptSchema>>
const spec = defineDomain({ name: 'collaboration_root_submission_v1', version: 1, layout: 'single',
  tables: { submissions: domainTable<string, CollaborationRootSubmission>(recordSchema) } })
function keyOf(value: CollaborationRootInput): string {
  const s = value.source
  return collaborationJournalDigest([value.namespace_id, s.workspace_id, s.session_id, s.source_message_id, s.source_revision])
}
function business(value: CollaborationRootInput & {
  root_task_id: string
  root_trace_id: string
  command_id: string
  source_digest: string
}) {
  return { schema_version: 1, namespace_id: value.namespace_id, root_task_id: value.root_task_id,
    root_trace_id: value.root_trace_id, command_id: value.command_id, source_digest: value.source_digest,
    source_locator: { workspace_id: value.source.workspace_id, session_id: value.source.session_id,
      source_message_id: value.source.source_message_id, source_revision: value.source.source_revision },
    objective_ref: value.objective_ref, task_grant_ref: value.task_grant_ref, continuation_policy: value.continuation_policy }
}
function receiptMatches(entry: { root_task_id: string; root_trace_id: string; command_id: string }, ack: CollaborationRootAdmission) {
  return ack.root_task_id === entry.root_task_id && ack.root_trace_id === entry.root_trace_id && ack.admission_id === entry.command_id
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
/**
 * Parse the persisted/transport aggregate and verify its complete source and business digests.
 * @param value - Untrusted JSON, with neither executable calls nor proof nonces.
 * @returns Detached frozen root submission; validation alone grants no authority.
 */
export function parseCollaborationRootSubmission(value: unknown): CollaborationRootSubmission {
  const result = recordSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_root_journal_invalid')
  return freeze(result.data)
}
/**
 * Detach a cloud root receipt before queueing its durable write; authentication belongs to the parent Host caller.
 * @param value - Exact original root admission receipt, never an execution or delivery receipt.
 * @returns Validated receipt with no reference to caller-owned data.
 */
export function parseCollaborationRootAdmission(value: unknown): CollaborationRootAdmission {
  const result = receiptSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_root_receipt_invalid')
  return freeze(result.data)
}
/** Single Profile writer. Failed write acknowledgments require close/reopen before any further observation. */
export interface CollaborationRootJournal {
  /**
   * Commit source, generated root and pending outbox as one record; duplicates return the original.
   * @param input - Original source and business policy; callers cannot choose root/command identifiers.
   * @param signal - Cancellation before write; an accepted durable write completes even after cancellation.
   * @returns Committed immutable aggregate. Changed payload under the same source rejects.
   */
  capture(input: CollaborationRootInput, signal: AbortSignal): Promise<CollaborationRootSubmission>
  /**
   * Record an authenticated cloud response without discarding the root or original command.
   * @param command - Original admission command.
   * @param receipt - Cloud response already authenticated and authorized by the caller.
   * @param signal - Cancellation before write.
   * @returns Durable admitted entry. Mismatched or conflicting receipts reject.
   */
  accept(command: CollaborationRootCommandId, receipt: unknown, signal: AbortSignal): Promise<CollaborationRootSubmission>
  /** @returns Frozen pending entries for authorized replay; admitted entries remain retained. */
  pending(): IterableIterator<CollaborationRootSubmission>
  /**
   * Observe an original root by command; no network or model activity.
   * @param command - Original admission command.
   * @returns Stored aggregate, or undefined when absent.
   */
  read(command: CollaborationRootCommandId): CollaborationRootSubmission | undefined
  /**
   * Find an existing root by namespace and original Source coordinates without capturing anything.
   * @param target - Current caller-authorized namespace and Source lookup.
   * @returns Original aggregate, or undefined; never writes or invents identifiers.
   */
  find(target: Omit<CollaborationRootTarget, 'command_id'>): CollaborationRootSubmission | undefined
  /** Identify Sessions whose persisted roots require a durability checkpoint before model dispatch.
   * @param sessionId - Current Session identity; message-source attribution is not consulted.
   * @returns Whether at least one pending or admitted root belongs to this Session.
   */
  hasSession(sessionId: SessionId): boolean
  /** @returns Completion after all accepted writes drain and storage closes. */
  close(): Promise<void>
}
/**
 * Open the independent root journal with strict, non-destructive recovery. The Profile owns the sole writer.
 * @param facility - Profile storage facility; single-file layout rejects corrupt/foreign data instead of treating it as a cache miss.
 * @returns Journal retaining source, root and receipts together. No legacy files are migrated or edited.
 */
export async function openCollaborationRootJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationRootJournal> {
  const domain = await facility.open(spec), table = domain.table('submissions')
  const commands = new Map<CollaborationRootCommandId, string>(), roots = new Set<string>(), traces = new Set<string>()
  try {
    for (const [key, entry] of table.entries()) {
      if (key !== keyOf(entry) || commands.has(entry.command_id) || roots.has(entry.root_task_id) || traces.has(entry.root_trace_id)) {
        throw Error('collaboration_root_journal_invalid')
      }
      freeze(entry); commands.set(entry.command_id, key); roots.add(entry.root_task_id); traces.add(entry.root_trace_id)
    }
  } catch (error) { await domain.close(); throw error }
  let chain = Promise.resolve(), closing: Promise<void> | undefined, recoveryRequired = false
  const healthy = () => { if (recoveryRequired) throw Error('collaboration_root_journal_recovery_required') }
  const readable = () => { if (closing) throw Error('collaboration_root_journal_closed'); healthy() }
  const queue = <T>(signal: AbortSignal, action: () => Promise<T>) => {
    readable(); signal.throwIfAborted()
    const operation = chain.then(async () => { healthy(); signal.throwIfAborted(); return action() })
    chain = operation.then(() => {}, () => {}); return operation
  }
  const put = async (key: string, entry: CollaborationRootSubmission) => {
    try { await table.put(key, entry) } catch (error) { recoveryRequired = true; throw error }
    commands.set(entry.command_id, key); roots.add(entry.root_task_id); traces.add(entry.root_trace_id)
    return entry
  }
  return {
    async capture(value, signal) {
      const parsed = inputSchema.safeParse(value)
      if (!parsed.success) throw Error('collaboration_root_journal_invalid')
      const input = freeze(parsed.data)
      return queue(signal, async () => {
        const key = keyOf(input), previous = table.get(key)
        if (previous) {
          const expected = { ...previous, ...input, source_digest: describeCollaborationSource(input.source).snapshot_digest }
          if (collaborationJournalDigest(business(expected)) !== previous.payload_digest) throw Error('collaboration_root_payload_conflict')
          return previous
        }
        if ([...table.entries()].filter(([, entry]) => entry.state === 'pending').length >= 128) throw Error('collaboration_root_journal_capacity_reached')
        let root: CollaborationRootTaskId, trace: CollaborationRootTraceId, command: CollaborationRootCommandId
        do { root = brandString<CollaborationRootTaskId>(randomUUID()) } while (roots.has(root))
        do { trace = brandString<CollaborationRootTraceId>(randomBytes(16).toString('hex')) } while (trace === '0'.repeat(32) || traces.has(trace))
        do { command = brandString<CollaborationRootCommandId>(randomUUID()) } while (commands.has(command))
        const entry = { ...input, schema_version: 1, state: 'pending', root_task_id: root, root_trace_id: trace,
          command_id: command, source_digest: describeCollaborationSource(input.source).snapshot_digest }
        return put(key, parseCollaborationRootSubmission({ ...entry, payload_digest: collaborationJournalDigest(business(entry)) }))
      })
    },
    async accept(command, value, signal) {
      const result = receiptSchema.safeParse(value)
      if (!result.success) throw Error('collaboration_root_receipt_invalid')
      const receipt = freeze(result.data)
      return queue(signal, async () => {
        const key = commands.get(command), entry = key === undefined ? undefined : table.get(key)
        if (key === undefined || !entry || !receiptMatches(entry, receipt)) throw Error('collaboration_root_receipt_invalid')
        if (entry.state === 'admitted') {
          if (collaborationJournalDigest(entry.receipt) !== collaborationJournalDigest(receipt)) throw Error('collaboration_root_receipt_conflict')
          return entry
        }
        return put(key, freeze({ ...entry, state: 'admitted', receipt }))
      })
    },
    hasSession(sessionId) { readable(); return [...table.entries()].some(([, entry]) => entry.source.session_id === sessionId) },
    pending() { readable(); return [...table.entries()].map(([, entry]) => entry).filter(entry => entry.state === 'pending').values() },
    read(command) { readable(); const key = commands.get(command); return key === undefined ? undefined : table.get(key) },
    find(target) {
      readable()
      return table.get(collaborationJournalDigest([target.namespace_id,target.workspace_id,target.session_id,
        target.source_message_id,target.source_revision]))
    },
    close() { closing ??= chain.then(() => domain.close()); return closing },
  }
}

const targetSchema = z.strictObject({ namespace_id: inputSchema.shape.namespace_id, command_id: commandId,
  workspace_id: uuid, session_id: ref, source_message_id: ref, source_revision: z.string() })
  .transform(value => ({ ...value, ...parseCollaborationSourceCoordinates({ workspace_id: value.workspace_id,
    session_id: value.session_id, source_message_id: value.source_message_id, source_revision: value.source_revision }) }))
/** Private root lookup containing original coordinates but no proposed root values. */
export type CollaborationRootTarget = Readonly<z.infer<typeof targetSchema>>
/** Root/source binding available for signing after Profile membership checks; no message content. */
export type CollaborationRootDescriptor = Pick<CollaborationRootSubmission,
  'namespace_id' | 'command_id' | 'root_task_id' | 'root_trace_id' | 'payload_digest'>
  & { readonly source_descriptor: ReturnType<typeof describeCollaborationSource> }
/**
 * Validate the private Host read target before queueing work.
 * @param value - Exact command, namespace and original Source coordinates.
 * @returns Detached target; namespace authorization remains with the caller.
 */
export function parseCollaborationRootTarget(value: unknown): CollaborationRootTarget {
  const result = targetSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_root_journal_invalid')
  return freeze(result.data)
}

/** Parse a read-only Source lookup; command identity is recovered from the committed journal.
 * @param value - Exact namespace and original coordinates without proposed root or command IDs.
 * @returns Detached lookup; malformed or additional fields reject.
 */
export function parseCollaborationRootLookup(value: unknown): Omit<CollaborationRootTarget, 'command_id'> {
  const schema = z.strictObject({ namespace_id:inputSchema.shape.namespace_id,workspace_id:uuid,
    session_id:ref,source_message_id:ref,source_revision:z.string() })
  const result = schema.safeParse(value)
  if (!result.success) throw Error('collaboration_root_journal_invalid')
  const { namespace_id,...coordinates } = result.data
  return freeze({ namespace_id,...parseCollaborationSourceCoordinates(coordinates) })
}
