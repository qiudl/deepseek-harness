/** Profile-local committed collaboration replies, separate from ordinary model-visible Session events. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { collaborationJournalDigest, describeCollaborationSource } from './collaboration-source-journal.ts'
import type { CollaborationSourceCoordinates, CollaborationSourceSnapshot } from './collaboration-source-journal.ts'

const text = (bytes: number) =>
  z.string().refine(value => value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= bytes)
const id = text(256).refine(
  value => /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..',
)
const version = z.string().refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const locator = z.strictObject({
  workspace_id: z.uuid(),
  session_id: id,
  source_message_id: id,
  source_revision: version,
})
const fields = {
  delivery_id: id,
  invocation_id: id,
  plan_id: id,
  task_id: id,
  task_revision: version,
  source_locator: locator,
  source_snapshot_digest: digest,
  execution_state: z.enum(['succeeded', 'failed', 'revoked', 'cancelled', 'indeterminate']),
  invocation_state_version: version,
  result_digest: digest,
  target: z.strictObject({ project_id: id, agent_id: id }),
  target_display_snapshot: z.strictObject({
    agent_name: text(512).refine(value => value.trim().length > 0),
    project_name: text(512).refine(value => value.trim().length > 0),
  }),
  answer: text(128 * 1024).optional(),
  failure_code: text(128)
    .refine(value => value.trim().length > 0)
    .optional(),
}
const rawBodySchema = z.strictObject({ namespace_id: id, ...fields })
const bodySchema = rawBodySchema.refine(validResult)
const inputSchema = z
  .strictObject({
    namespace_id: id,
    projection: z.strictObject({
      ...fields,
      delivery_state: z.enum(['pending', 'delivered', 'failed']),
      delivery_state_version: version,
    }),
  })
  .refine(value => validResult({ namespace_id: value.namespace_id, ...value.projection }))
const rawRecordSchema = z.strictObject({
  namespace_id: id,
  ...fields,
  host_journal_commit: z.strictObject({ journal_id: z.uuid(), commit_version: z.literal('1'), content_digest: digest }),
})
const recordSchema = rawRecordSchema.refine(
  value =>
    validResult(value) && value.host_journal_commit.content_digest === collaborationJournalDigest(bodyOf(value)),
)
const domainSpec = defineDomain({
  name: 'collaboration_delivery_v2',
  version: 1,
  tables: { replies: domainTable<string, CollaborationDeliveryRecord>(recordSchema) },
})
// Bound the serialized content retained in memory; capacity never evicts an original receipt.
const MAX_RETAINED_BYTES = 16 * 1024 * 1024
function retainedBytes(storedKey: string, record: CollaborationDeliveryRecord): number {
  return Buffer.byteLength(JSON.stringify([storedKey, record]), 'utf8') + 1
}
/** Complete readable cloud result; mutable delivery status is not part of the persisted reply. */
export type CollaborationDeliveryInput = z.infer<typeof inputSchema>
/** Immutable reply with its first local commit; this is a persistence receipt, not a cloud authorization. */
export type CollaborationDeliveryRecord = DeepReadonly<z.infer<typeof rawRecordSchema>>
type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
type Body = z.infer<typeof rawBodySchema>
function bodyOf(value: CollaborationDeliveryRecord): Body {
  const { host_journal_commit: _commit, ...body } = value
  return body
}
function validResult(value: Body): boolean {
  return (
    (value.execution_state === 'succeeded') === (value.answer !== undefined) &&
    (!Object.hasOwn(value, 'answer') || value.answer !== undefined) &&
    (!Object.hasOwn(value, 'failure_code') || value.failure_code !== undefined) &&
    value.result_digest ===
      collaborationJournalDigest({
        state: value.execution_state,
        answer: value.answer ?? null,
        failure_code: value.failure_code ?? null,
      }) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024 * 1024
  )
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
function key(namespace: string, delivery: string): string {
  return collaborationJournalDigest([namespace, delivery])
}
/**
 * Parse private queued delivery JSON before asynchronous Profile checks.
 * @param value - Full readable result with namespace and mutable cloud delivery version.
 * @returns Detached immutable input after exact-field, result-digest and complete-byte validation.
 */
export function parseCollaborationDeliveryInput(value: unknown): CollaborationDeliveryInput {
  const result = inputSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_delivery_journal_invalid')
  return frozen(result.data)
}
/**
 * Parse a durable reply without preparing a model or accepting a caller's local receipt.
 * @param value - Complete journal record.
 * @returns Detached immutable record with checked local content and cloud result digests.
 */
export function parseCollaborationDeliveryRecord(value: unknown): CollaborationDeliveryRecord {
  const result = recordSchema.safeParse(value)
  if (!result.success) throw Error('collaboration_delivery_journal_invalid')
  return frozen(result.data)
}
/** The owning Profile closes this handle after accepted writes drain. */
export interface CollaborationDeliveryJournal {
  /**
   * Save one original reply; duplicate cloud versions return its first commit, changed payloads reject.
   * @param value - Readable private cloud result; never a restricted projection.
   * @param source - Original verified Profile-local Source snapshot.
   * @param signal - Cancellation checked before reserving the durable write.
   * @returns Original immutable reply after storage commit; does not certify cloud delivery.
   */
  persist(
    value: unknown,
    source: CollaborationSourceSnapshot,
    signal: AbortSignal,
  ): Promise<CollaborationDeliveryRecord>
  /**
   * Read replies only for one namespace and original Source; enumeration performs no model or task work.
   * @param namespace - Current trusted coordinator's account namespace.
   * @param source - Original Source coordinates.
   * @returns Frozen matching records in first-commit storage order.
   */
  records(namespace: string, source: CollaborationSourceCoordinates): IterableIterator<CollaborationDeliveryRecord>
  /** @returns Resolution after queued accepted writes drain and the domain closes. */
  close(): Promise<void>
}
/**
 * Open the independent single-layout reply domain; invalid records or keys reject without repair.
 * Caller authenticates the namespace and current Profile membership before persist. No Session events,
 * Agent activation, cloud acknowledgment, auto-deletion or retry execution occur here.
 * @param facility - Owning Profile's configured StorageDomain provider.
 * @returns Journal retaining first commits; uncertain writes require closing and reopening for read recovery.
 */
export async function openCollaborationDeliveryJournal(
  facility: Pick<DomainFacility, 'open'>,
): Promise<CollaborationDeliveryJournal> {
  const domain = await facility.open(domainSpec),
    table = domain.table('replies')
  let bytes = 0
  try {
    if (table.size > 4096) throw Error('collaboration_delivery_journal_capacity_reached')
    for (const [storedKey, value] of table.entries()) {
      if (storedKey !== key(value.namespace_id, value.delivery_id))
        throw Error('collaboration_delivery_journal_invalid')
      bytes += retainedBytes(storedKey, value)
      if (bytes > MAX_RETAINED_BYTES) throw Error('collaboration_delivery_journal_capacity_reached')
      frozen(value)
    }
  } catch (error) {
    await domain.close()
    throw error
  }
  let chain: Promise<void> = Promise.resolve(),
    closing: Promise<void> | undefined,
    recoveryRequired = false
  const healthy = () => {
    if (recoveryRequired) throw Error('collaboration_delivery_journal_recovery_required')
  }
  const active = () => {
    if (closing) throw Error('collaboration_delivery_journal_closed')
    healthy()
  }
  return {
    persist(value, source, signal) {
      let input: CollaborationDeliveryInput
      try {
        active()
        signal.throwIfAborted()
        input = parseCollaborationDeliveryInput(value)
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : Error('collaboration_delivery_journal_invalid', { cause: error }),
        )
      }
      const operation = chain.then(async () => {
        healthy()
        signal.throwIfAborted()
        const descriptor = describeCollaborationSource(source),
          projection = input.projection
        if (
          descriptor.snapshot_digest !== projection.source_snapshot_digest ||
          Object.entries(projection.source_locator).some(
            ([field, coordinate]) => descriptor[field as keyof typeof projection.source_locator] !== coordinate,
          ) ||
          !source.active_mentions.some(
            mention =>
              mention.binding.kind === 'resolved' &&
              mention.binding.target.project_id === projection.target.project_id &&
              mention.binding.target.agent_id === projection.target.agent_id,
          )
        ) {
          throw Error('collaboration_delivery_source_mismatch')
        }
        const { delivery_state: _state, delivery_state_version: _version, ...result } = projection
        const body = bodySchema.parse({ namespace_id: input.namespace_id, ...result }),
          recordKey = key(input.namespace_id, body.delivery_id)
        const previous = table.get(recordKey)
        if (previous) {
          if (collaborationJournalDigest(bodyOf(previous)) !== collaborationJournalDigest(body))
            throw Error('collaboration_delivery_payload_conflict')
          return previous
        }
        if (table.size >= 4096) throw Error('collaboration_delivery_journal_capacity_reached')
        const record = frozen(
          recordSchema.parse({
            ...body,
            host_journal_commit: {
              journal_id: randomUUID(),
              commit_version: '1',
              content_digest: collaborationJournalDigest(body),
            },
          }),
        )
        const addedBytes = retainedBytes(recordKey, record)
        if (bytes + addedBytes > MAX_RETAINED_BYTES) throw Error('collaboration_delivery_journal_capacity_reached')
        try {
          await table.put(recordKey, record)
        } catch (error) {
          recoveryRequired = true
          throw error
        }
        bytes += addedBytes
        return record
      })
      chain = operation.then(
        () => {},
        () => {},
      )
      return operation
    },
    records(namespace, source) {
      active()
      return [...table.entries()]
        .map(([, record]) => record)
        .filter(
          record =>
            record.namespace_id === namespace &&
            Object.entries(source).every(
              ([field, coordinate]) =>
                record.source_locator[field as keyof CollaborationSourceCoordinates] === coordinate,
            ),
        )
        .values()
    },
    close() {
      closing ??= chain.then(() => domain.close())
      return closing
    },
  }
}
