/** REQ-20260930-0004: Profile-local Source persistence, separate from Session events. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const text = (bytes: number) => z.string().refine(value => value.trim().length > 0
  && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= bytes)
const id = text(256).refine(value => /^[!-~]+$/.test(value) && !/[/\\]/.test(value) && value !== '.' && value !== '..')
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const version = (positive = true) => z.string().refine(value => value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value)
  && BigInt(value) <= 9223372036854775807n && (!positive || value !== '0'))
const mention = z.strictObject({
  mention_id: id,
  source_span: z.strictObject({ source_message_id: id, source_revision: version(),
    start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  display_snapshot: z.strictObject({ agent_name: text(512), project_name: text(512).nullable() }),
  binding: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('resolved'), target: z.strictObject({ project_id: id, agent_id: id }), capability_snapshot: digest }),
    z.strictObject({ kind: z.literal('ambiguous'), candidate_handles: z.array(id).min(2).max(50).refine(values => new Set(values).size === values.length) }),
    z.strictObject({ kind: z.literal('unavailable'), reason_code: text(128) }),
  ]),
})
const fields = {
  workspace_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  session_id: id, source_message_id: id, source_revision: version(), original_message: text(32 * 1024),
  active_mentions: z.array(mention).max(10),
  model_snapshot: z.strictObject({ provider: text(256), model: text(256), configuration_generation: version(false),
    adapter_fingerprint: digest, reasoning_effort: text(128).optional() }),
}
const rawBodySchema = z.strictObject(fields)
const bodySchema = rawBodySchema.refine(validBody)
const { model_snapshot: _model, ...inputFields } = fields
const inputSchema = z.strictObject(inputFields).refine(validInput)
const rawSnapshotSchema = z.strictObject({ ...fields,
  host_journal_commit: z.strictObject({ journal_id: id, commit_version: version(), content_digest: digest }),
})
const snapshotSchema = rawSnapshotSchema.refine(value => validBody(value)
  && value.host_journal_commit.content_digest === hash(canonicalJson(bodyOf(value))))

/** Frozen Host input; the coordinator supplies actual prepared metadata and classified mentions. */
export type CollaborationSourceBody = DeepReadonly<z.infer<typeof rawBodySchema>>
/** Queued user content and resolved mentions; the Profile supplies model and journal metadata. */
export type CollaborationSourceInput = Omit<CollaborationSourceBody, 'model_snapshot'>
/** Source envelope with the journal entry's immutable first-commit identity. This is not an authorization proof. */
export type CollaborationSourceSnapshot = DeepReadonly<z.infer<typeof rawSnapshotSchema>>
type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
/** Immutable original Source identity for Host journal reads. */
export type CollaborationSourceCoordinates = Pick<CollaborationSourceBody, 'workspace_id' | 'session_id' | 'source_message_id' | 'source_revision'>

function validBody(value: CollaborationSourceBody): boolean {
  if (Object.hasOwn(value.model_snapshot, 'reasoning_effort') && value.model_snapshot.reasoning_effort === undefined) return false
  return validInput(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024 * 1024
}
function validInput(value: CollaborationSourceInput): boolean {
  const seen = new Set<string>()
  const ordered = [...value.active_mentions].sort((a, b) => a.source_span.start - b.source_span.start)
  let previousEnd = 0
  for (const item of ordered) {
    const span = item.source_span
    const splits = (at: number) => at > 0 && at < value.original_message.length
      && value.original_message.charCodeAt(at - 1) >= 0xd800 && value.original_message.charCodeAt(at - 1) <= 0xdbff
      && value.original_message.charCodeAt(at) >= 0xdc00 && value.original_message.charCodeAt(at) <= 0xdfff
    if (seen.has(item.mention_id) || span.source_message_id !== value.source_message_id || span.source_revision !== value.source_revision
      || span.end - span.start < 2 || span.end > value.original_message.length || value.original_message[span.start] !== '@'
      || splits(span.start) || splits(span.end) || previousEnd > span.start
      || (item.binding.kind === 'resolved' && item.display_snapshot.project_name === null)) return false
    seen.add(item.mention_id)
    previousEnd = span.end
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1024 * 1024
}
/**
 * Detach queued input before Profile/model work. Reject caller-supplied model and commit fields.
 * @param value - Source input at the queued Host boundary.
 * @returns deeply frozen coordinates, text and classified mentions, without granting authority.
 */
export function parseCollaborationSourceInput(value: unknown): CollaborationSourceInput {
  const result = inputSchema.safeParse(value)
  if (!result.success) throw new Error('collaboration_source_journal_invalid')
  return freeze(result.data)
}
function bodyOf(value: CollaborationSourceSnapshot): CollaborationSourceBody {
  const { host_journal_commit: _commit, ...body } = value
  return body
}
function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
// The schema admits only strings, safe integers, arrays and plain JSON objects.
// Sorted UTF-16 keys and JSON number/string serialization implement RFC 8785 for this vocabulary.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function keyOf(value: CollaborationSourceCoordinates): string {
  return hash(JSON.stringify([value.workspace_id, value.session_id, value.source_message_id, value.source_revision]))
}
const coordinatesSchema = z.strictObject({
  workspace_id: fields.workspace_id, session_id: id, source_message_id: id, source_revision: version(),
})
/**
 * Validate a queued Host-only read target without accepting model or journal metadata.
 * @param value - Exact Source coordinates.
 * @returns Detached frozen coordinates.
 */
export function parseCollaborationSourceCoordinates(value: unknown): CollaborationSourceCoordinates {
  const result = coordinatesSchema.safeParse(value)
  if (!result.success) throw new Error('collaboration_source_journal_invalid')
  return freeze(result.data)
}
/**
 * Describe a committed journal entry; the complete digest includes its first-commit identity.
 * @param snapshot - Validated immutable record returned by this Profile's journal.
 * @returns Frozen coordinates and RFC 8785 SHA-256 of the full snapshot, not just its body.
 */
export function describeCollaborationSource(snapshot: CollaborationSourceSnapshot):
CollaborationSourceCoordinates & { readonly snapshot_digest: string } {
  return Object.freeze({ workspace_id: snapshot.workspace_id, session_id: snapshot.session_id,
    source_message_id: snapshot.source_message_id, source_revision: snapshot.source_revision,
    snapshot_digest: hash(canonicalJson(snapshot)) })
}
// Authoritative data uses single layout: the JSON per-record backend intentionally
// treats malformed or foreign-version files as disposable cache misses.
const spec = defineDomain({ name: 'collaboration_source_v2', version: 1,
  tables: { sources: domainTable<string, CollaborationSourceSnapshot>(snapshotSchema) },
})

/** Own one journal through a Profile's storageDomain handle; callers close it on Profile shutdown. */
export interface CollaborationSourceJournal {
  /**
   * Persist a detached Source before planning; duplicates return the original commit.
   * Cancellation before the write rejects; an accepted durable write returns its receipt even if cancelled meanwhile.
   * @param body - Frozen source identity, text, classified mentions and actual prepared model metadata.
   * @param signal - Cancellation while queued, checked immediately before the write.
   * @returns the immutable persisted snapshot; different content under the same identity rejects.
   */
  capture(body: CollaborationSourceBody, signal: AbortSignal): Promise<CollaborationSourceSnapshot>
  /**
   * Read by original identity without dispatch, receipt renewal or model activation.
   * @param identity - Source coordinates within the owning Profile.
   * @returns the original frozen snapshot, or undefined.
   */
  read(identity: CollaborationSourceCoordinates): CollaborationSourceSnapshot | undefined
  /** @returns a read-only snapshot iterator for recovery; enumeration never executes a task. */
  sources(): IterableIterator<CollaborationSourceSnapshot>
  /** @returns resolution after accepted writes drain and the domain closes. */
  close(): Promise<void>
}

/**
 * Open the independent domain and reject corrupt data without discarding it. This internal
 * primitive does not authenticate Account/workspace ownership, classify active @ mentions,
 * prepare an executable model call, issue cloud Source proof or send a task. The Profile
 * coordinator must establish those facts before capture; no ordinary user/message is appended.
 * @param facility - The current Profile's configured storageDomain form.
 * @returns the journal handle; the owning Profile must close it during disposal.
 */
export async function openCollaborationSourceJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationSourceJournal> {
  const domain = await facility.open(spec)
  const table = domain.table('sources')
  try {
    for (const [key, value] of table.entries()) {
      if (key !== keyOf(value)) throw new Error('collaboration_source_journal_invalid')
      freeze(value)
    }
  } catch (error) {
    await domain.close()
    throw error
  }
  let chain: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  let recoveryRequired = false
  const assertHealthy = () => { if (recoveryRequired) throw new Error('collaboration_source_journal_recovery_required') }
  const assertOpen = () => {
    if (closing !== undefined) throw new Error('collaboration_source_journal_closed')
    assertHealthy()
  }
  return {
    capture(body, signal) {
      // Capture before joining the asynchronous write queue.
      let captured: CollaborationSourceBody
      try {
        assertOpen()
        signal.throwIfAborted()
        captured = freeze(bodySchema.parse(body))
      } catch (error) {
        if (error instanceof z.ZodError) return Promise.reject(new Error('collaboration_source_journal_invalid'))
        return Promise.reject(error instanceof Error ? error : new Error('collaboration_source_journal_invalid', { cause: error }))
      }
      const operation = chain.then(async () => {
        assertHealthy()
        signal.throwIfAborted()
        const key = keyOf(captured)
        const existing = table.get(key)
        if (existing !== undefined) {
          if (canonicalJson(bodyOf(existing)) !== canonicalJson(captured)) throw new Error('collaboration_source_payload_conflict')
          return existing
        }
        // These entries are all un-routed Sources. The planner's approved pending
        // budget applies until the route/outbox owner supplies a durable retirement.
        if (table.size >= 128) throw new Error('collaboration_source_journal_capacity_reached')
        const snapshot = freeze(snapshotSchema.parse({ ...captured, host_journal_commit: {
          journal_id: randomUUID(), commit_version: '1', content_digest: hash(canonicalJson(captured)),
        } }))
        try {
          await table.put(key, snapshot)
        } catch (error) {
          // A failed acknowledgement may follow a published file. Reopen and
          // reconcile the original identity before accepting any further work.
          recoveryRequired = true
          throw error
        }
        return snapshot
      })
      chain = operation.then(() => {}, () => {})
      return operation
    },
    read(identity) {
      assertOpen()
      const captured = coordinatesSchema.parse({ workspace_id: identity.workspace_id, session_id: identity.session_id,
        source_message_id: identity.source_message_id, source_revision: identity.source_revision })
      return table.get(keyOf(captured))
    },
    sources() {
      assertOpen()
      return [...table.entries()].map(([, value]) => value).values()
    },
    close() {
      closing ??= chain.then(() => domain.close())
      return closing
    },
  }
}
