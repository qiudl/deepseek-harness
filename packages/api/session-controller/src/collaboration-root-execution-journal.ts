/** REQ-20261004-0008: immutable concrete execution commands, independent of released Source/Session formats. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest } from './collaboration-source-journal.ts'
import { parseCollaborationRootSubmission, parseCollaborationRootTarget } from './collaboration-root-journal.ts'
import type { CollaborationRootSubmission } from './collaboration-root-journal.ts'

/** Identity of one durable concrete execution confirmation, distinct from root admission. */
export type CollaborationExecutionCommandId = Branded<'CollaborationExecutionCommandId'>
const exact = (pattern: RegExp) => z.string().refine(value => pattern.exec(value)?.[0] === value)
const uuid = exact(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const commandId = uuid.transform(brandString<CollaborationExecutionCommandId>)
const digest = exact(/^[0-9a-f]{64}$/u)
const opaque = exact(/^[!-~]{1,256}$/u).refine(value => !/[/\\]/u.test(value) && value !== '.' && value !== '..')
const version = exact(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) <= 9223372036854775807n)
const scopeVersion = exact(/^(0|[1-9][0-9]{0,18})$/u).refine(value => BigInt(value) <= 9223372036854775807n)
const rootSchema = z.strictObject({ namespace_id: exact(/^n2_[0-9a-f]{64}$/u), root_task_id: uuid,
  root_trace_id: exact(/^(?!0{32}$)[0-9a-f]{32}$/u), command_id: uuid, source_digest: digest, payload_digest: digest })
const selectionSchema = z.strictObject({ plan_id: opaque, expected_plan_revision: version, candidate_digest: digest,
  task_id: opaque, task_revision: version, task_digest: digest, expected_scope_version: scopeVersion })
/** Exact frozen task selected by authenticated Main. This metadata alone grants no execution authority. */
export type CollaborationExecutionSelection = Readonly<z.infer<typeof selectionSchema>>
const receiptSchema = z.strictObject({ execution_command_id: commandId, root_task_id: uuid,
  root_trace_id: rootSchema.shape.root_trace_id, root_revision: z.literal('1'), plan_id: opaque,
  task_id: opaque, task_revision: version, invocation_id: opaque, admission: z.literal('recorded'),
  max_invocations: z.literal(1), max_runtime_ms: z.number().int().min(1).max(1200000),
  expires_at: z.iso.datetime().refine(value => new Date(value).toISOString() === value) })
/** Immutable historical cloud receipt; expiry is retained, never refreshed during recovery. */
export type CollaborationExecutionReceipt = Readonly<z.infer<typeof receiptSchema>>
const common = { schema_version: z.literal(1), root: rootSchema, selection: selectionSchema,
  execution_command_id: commandId, command_digest: digest }
const recordSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...common, state: z.literal('prepared') }),
  z.strictObject({ ...common, state: z.literal('admitted'), receipt: receiptSchema }),
]).refine(value => value.command_digest === collaborationJournalDigest(commandOf(value)) &&
  (value.state === 'prepared' || receiptMatches(value, value.receipt)))
/** Durable submission and optional original receipt. No credentials or process-local executable handles. */
export type CollaborationExecutionRecord = Readonly<z.infer<typeof recordSchema>>
const spec = defineDomain({ name: 'collaboration_root_execution_v1', version: 1, layout: 'single',
  tables: { commands: domainTable<string, CollaborationExecutionRecord>(recordSchema) } })
type Binding = { root: z.infer<typeof rootSchema>; selection: CollaborationExecutionSelection }
function keyOf(value: Binding): string {
  return collaborationJournalDigest([value.root.namespace_id, value.root.root_task_id,
    value.selection.plan_id, value.selection.task_id, value.selection.task_revision])
}
function commandOf(value: Binding & { execution_command_id: string }) {
  return { schema_version: 1, root: value.root, selection: value.selection, execution_command_id: value.execution_command_id }
}
function receiptMatches(value: Binding & { execution_command_id: string }, receipt: CollaborationExecutionReceipt): boolean {
  return receipt.execution_command_id === value.execution_command_id && receipt.root_task_id === value.root.root_task_id &&
    receipt.root_trace_id === value.root.root_trace_id && receipt.plan_id === value.selection.plan_id &&
    receipt.task_id === value.selection.task_id && receipt.task_revision === value.selection.task_revision
}
function binding(rootValue: CollaborationRootSubmission, selected: unknown): Binding {
  const root = parseCollaborationRootSubmission(rootValue)
  if (root.state !== 'admitted') throw Error('collaboration_execution_root_not_admitted')
  return deepFreeze({ root: rootSchema.parse({ namespace_id: root.namespace_id, root_task_id: root.root_task_id,
    root_trace_id: root.root_trace_id, command_id: root.command_id, source_digest: root.source_digest,
    payload_digest: root.payload_digest }), selection: parseCollaborationExecutionSelection(selected) })
}
/** Validate the private confirmation before queueing a write.
 * @param value - Frozen task references; no caller-selected execution identifier is accepted.
 * @returns Detached immutable selection. Current cloud authority remains the parent's responsibility.
 */
export function parseCollaborationExecutionSelection(value: unknown): CollaborationExecutionSelection {
  const result = selectionSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_execution_selection_invalid')
  return deepFreeze(result.data)
}
/** Validate an authenticated cloud response before queueing its commit.
 * @param value - Original cloud execution receipt, not a root or planning receipt.
 * @returns Detached historical receipt; parsing does not authorize execution.
 */
export function parseCollaborationExecutionReceipt(value: unknown): CollaborationExecutionReceipt {
  const result = receiptSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_execution_receipt_invalid')
  return deepFreeze(result.data)
}
/** Validate a stored command and its historical receipt before correlating a returned result.
 * @param value - Complete execution journal record.
 * @returns Detached immutable record with matching command digest and receipt identities.
 */
export function parseCollaborationExecutionRecord(value: unknown): CollaborationExecutionRecord {
  const result = recordSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_execution_record_invalid')
  return deepFreeze(result.data)
}
const targetSchema = z.unknown().transform((value, ctx) => {
  try { return parseCollaborationRootTarget(value) } catch {
    ctx.addIssue({ code: 'custom', message: 'collaboration_execution_target_invalid' }); return z.NEVER
  }
})
const operationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), target: targetSchema, selection: selectionSchema }),
  z.strictObject({ action: z.literal('prepare'), target: targetSchema, selection: selectionSchema }),
  z.strictObject({ action: z.literal('accept'), target: targetSchema, selection: selectionSchema, receipt: receiptSchema }),
])
/** Private Profile operation; Main must authenticate cloud responses and execution intent. */
export type CollaborationExecutionOperation = Readonly<z.infer<typeof operationSchema>>
/** Capture a private execution-journal operation before any asynchronous membership check.
 * @param value - Exact action, original root target, frozen selection and optional receipt.
 * @returns Detached operation; rejects supplied root/trace or execution command overrides.
 */
export function parseCollaborationExecutionOperation(value: unknown): CollaborationExecutionOperation {
  const result = operationSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_execution_operation_invalid')
  return deepFreeze(result.data)
}
/** Profile-owned sole writer; no network, task dispatch or blind replay occurs here. */
export interface CollaborationRootExecutionJournal {
  /** Commit exact confirmation before any cloud request; duplicates retain the first command.
   * @param root - Original admitted root read under current Profile membership.
   * @param selection - Frozen task confirmed by authenticated Main.
   * @param signal - Cancellation before write; accepted writes drain.
   * @returns Committed command. Recovery must query cloud status before deciding whether to resubmit it.
   */
  prepare(root: CollaborationRootSubmission, selection: unknown, signal: AbortSignal): Promise<CollaborationExecutionRecord>
  /** Read an exact original confirmation without creating a command.
   * @param root - Original admitted root under current membership.
   * @param selection - Original frozen task binding.
   * @returns Stored record or undefined; changed bindings reject.
   */
  read(root: CollaborationRootSubmission, selection: unknown): CollaborationExecutionRecord | undefined
  /** Persist one authenticated cloud receipt after Main verifies current authority.
   * @param root - Original admitted root under current membership.
   * @param selection - Original frozen task binding.
   * @param receipt - Cloud receipt; conflicting or unrelated receipts reject.
   * @param signal - Cancellation before write.
   * @returns Historical admitted record; does not grant or renew execution.
   */
  accept(root: CollaborationRootSubmission, selection: unknown, receipt: unknown, signal: AbortSignal)
  : Promise<CollaborationExecutionRecord>
  /** @returns Completion after accepted writes drain and storage closes. */
  close(): Promise<void>
}
/** Open a separate strict domain without modifying released Source, root or Session data.
 * @param facility - Profile storage facility owning the single writer.
 * @returns Journal; any uncertain write poisons the handle until close/reopen.
 */
export async function openCollaborationRootExecutionJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationRootExecutionJournal> {
  const domain = await facility.open(spec), table = domain.table('commands'), ids = new Set<string>()
  try {
    if (table.size > 4096) throw Error('collaboration_execution_capacity_reached')
    for (const [key, entry] of table.entries()) {
      if (key !== keyOf(entry) || ids.has(entry.execution_command_id)) throw Error('collaboration_execution_journal_invalid')
      ids.add(entry.execution_command_id); deepFreeze(entry)
    }
  } catch (error) { await domain.close(); throw error }
  let chain = Promise.resolve(), closing: Promise<void> | undefined, uncertain = false
  const healthy = () => { if (uncertain) throw Error('collaboration_execution_recovery_required') }
  const active = () => { if (closing) throw Error('collaboration_execution_closed'); healthy() }
  const queue = <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    active(); signal.throwIfAborted()
    const operation = chain.then(async () => { healthy(); signal.throwIfAborted(); return action() })
    chain = operation.then(() => {}, () => {}); return operation
  }
  const find = (input: Binding) => {
    const previous = table.get(keyOf(input))
    if (previous && (collaborationJournalDigest(previous.root) !== collaborationJournalDigest(input.root) ||
      collaborationJournalDigest(previous.selection) !== collaborationJournalDigest(input.selection))) {
      throw Error('collaboration_execution_payload_conflict')
    }
    return previous
  }
  const put = async (entry: CollaborationExecutionRecord) => {
    try { await table.put(keyOf(entry), entry) } catch (error) { uncertain = true; throw error }
    ids.add(entry.execution_command_id); return entry
  }
  return {
    async prepare(root, selection, signal) {
      const input = binding(root, selection)
      return queue(signal, async () => {
        const previous = find(input)
        if (previous) return previous
        if (table.size >= 4096) throw Error('collaboration_execution_capacity_reached')
        let execution_command_id: CollaborationExecutionCommandId
        do { execution_command_id = brandString<CollaborationExecutionCommandId>(randomUUID()) } while (ids.has(execution_command_id))
        const body = { ...input, execution_command_id }
        return put(deepFreeze(recordSchema.parse({ ...body, schema_version: 1, state: 'prepared',
          command_digest: collaborationJournalDigest(commandOf(body)) })))
      })
    },
    read(root, selection) { active(); return find(binding(root, selection)) },
    async accept(root, selection, value, signal) {
      const input = binding(root, selection), receipt = parseCollaborationExecutionReceipt(value)
      return queue(signal, async () => {
        const previous = find(input)
        if (!previous || !receiptMatches(previous, receipt)) throw Error('collaboration_execution_receipt_invalid')
        if (previous.state === 'admitted') {
          if (collaborationJournalDigest(previous.receipt) !== collaborationJournalDigest(receipt)) throw Error('collaboration_execution_receipt_conflict')
          return previous
        }
        return put(deepFreeze({ ...previous, state: 'admitted', receipt }))
      })
    },
    close() { closing ??= chain.then(() => domain.close()); return closing },
  }
}
