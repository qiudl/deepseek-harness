/** First durable terminal-reply headers for runtime entry; never reconstructs a header from history. */
import { z } from 'zod'
import { defineDomain, domainTable, type DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest as hash } from './collaboration-source-journal.ts'
import { openCollaborationDeliveryJournal, type CollaborationDeliveryJournal, type CollaborationDeliveryRecord } from './collaboration-delivery-journal.ts'

const exact = (pattern: RegExp) => z.string().refine(value => pattern.exec(value)?.[0] === value)
const opaque = exact(/^[!-~]{1,256}$/u).refine(value => !/[/\\]/u.test(value) && value !== '.' && value !== '..')
const digest = exact(/^[a-f0-9]{64}$/u)
const version = exact(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) <= 9223372036854775807n)
const schema = z.strictObject({
  schema_version: z.literal(1), purpose: z.literal('original-feedback-runtime-entry'),
  namespace_id: exact(/^n2_[a-f0-9]{64}$/u), delivery_id: opaque, invocation_id: opaque,
  plan_id: opaque, task_id: opaque, task_revision: version,
  source_locator: z.strictObject({ workspace_id: z.uuid(), session_id: opaque, source_message_id: opaque, source_revision: version }),
  source_snapshot_digest: digest, result_digest: digest,
  execution_state: z.enum(['succeeded', 'failed', 'revoked', 'cancelled', 'indeterminate']),
  invocation_state_version: version, delivery_state_version: version,
  target: z.strictObject({ project_id: opaque, agent_id: opaque }),
  host_journal_commit: z.strictObject({ journal_id: z.uuid(), commit_version: z.literal('1'), content_digest: digest }),
})
/** Strict metadata only; the original reply digest binds its content without retaining that content. */
export type RuntimeEntryFeedbackMetadata = Readonly<z.infer<typeof schema>>
/** Metadata delivered only by the original journal's first successful durable put. */
export type RuntimeEntryFeedbackCommit = Pick<CollaborationDeliveryRecord,
  'namespace_id' | 'delivery_id' | 'invocation_id' | 'plan_id' | 'task_id' | 'task_revision' |
  'source_locator' | 'source_snapshot_digest' | 'result_digest' | 'execution_state' |
  'invocation_state_version' | 'target' | 'host_journal_commit'> & { readonly delivery_state_version: string }
const spec = defineDomain({ name: 'runtime_entry_feedback_metadata_v1', version: 1, layout: 'single',
  tables: { headers: domainTable<string, RuntimeEntryFeedbackMetadata>(schema) } })
const key = (namespace: string, delivery: string) => hash([namespace, delivery])
/** Validate independently retained metadata without opening the Source or terminal reply domains.
 * @param value - One strict metadata header.
 * @returns Detached frozen header; no source or consumption authority is created.
 */
export function parseRuntimeEntryFeedbackMetadata(value: unknown): RuntimeEntryFeedbackMetadata {
  return deepFreeze(schema.parse(value))
}
/** Profile-owned metadata reader and its sole first-commit writer attachment. */
export interface RuntimeEntryFeedbackMetadataJournal {
  /** @param namespace - Authenticated original account namespace.
   * @param delivery - Exact original terminal delivery identity.
   * @returns First durable header, or undefined for old replies and capacity gaps; uncertain writes reject Native reads. */
  read(namespace: string, delivery: string): RuntimeEntryFeedbackMetadata | undefined
  /** Open the ordinary reply writer with the private first-durable-commit projection attached.
   * @returns Original reply journal even after projection failure; duplicates and restored replies never fill metadata gaps. */
  openDeliveryJournal(): Promise<CollaborationDeliveryJournal>
  /** Drain the attached reply writer before closing the header domain.
   * @returns Completion after accepted writes drain. */
  close(): Promise<void>
}
/** Open only the new header domain; attaching the reply writer is explicit and never backfills history.
 * @param facility - Actual owning Profile storage provider.
 * @returns Metadata reader with a closed first-commit projection; no arbitrary seed operation exists.
 */
export async function openRuntimeEntryFeedbackMetadata(facility: Pick<DomainFacility, 'open'>): Promise<RuntimeEntryFeedbackMetadataJournal> {
  const domain = await facility.open(spec), table = domain.table('headers')
  try {
    if (table.size > 4096) throw Error('runtime_entry_feedback_metadata_capacity')
    for (const [k, header] of table.entries()) {
      if (k !== key(header.namespace_id, header.delivery_id)) throw Error('runtime_entry_feedback_metadata_corrupt')
      deepFreeze(header)
    }
  } catch (error) { await domain.close(); throw error }
  let delivery: Promise<CollaborationDeliveryJournal> | undefined, closing: Promise<void> | undefined, uncertain = false
  const active = () => {
    if (closing) throw Error('runtime_entry_feedback_metadata_closed')
    if (uncertain) throw Error('runtime_entry_feedback_metadata_recovery_required')
  }
  const observe = async (commit: RuntimeEntryFeedbackCommit) => {
    if (uncertain) return
    const header = parseRuntimeEntryFeedbackMetadata({ schema_version: 1, purpose: 'original-feedback-runtime-entry', ...commit })
    const k = key(header.namespace_id, header.delivery_id), previous = table.get(k)
    if (previous) {
      if (hash(previous) !== hash(header)) throw Error('runtime_entry_feedback_metadata_conflict')
      return
    }
    if (table.size >= 4096) return
    try { await table.put(k, header) } catch (error) { uncertain = true; throw error }
  }
  return {
    read(namespace, id) { active(); return table.get(key(namespace, id)) },
    openDeliveryJournal() {
      if (closing) throw Error('runtime_entry_feedback_metadata_closed')
      return delivery ??= openCollaborationDeliveryJournal(facility, observe)
    },
    close() {
      closing ??= (async () => { try { await (await delivery)?.close() } finally { await domain.close() } })()
      return closing
    },
  }
}
