/** Profile-owned immutable reference selections and bytes, separate from Source and Session formats. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest, describeCollaborationSource, parseCollaborationSourceSnapshot } from './collaboration-source-journal.ts'
import type { CollaborationSourceSnapshot } from './collaboration-source-journal.ts'

const referenceBytes = 1024 * 1024
const id = z.string().regex(/^[!-~]{1,256}$/u).refine(value => !/[/\\]/u.test(value) && value !== '.' && value !== '..')
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const version = z.string().refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n)
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const coordinates = {
  workspace_id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
  session_id: id, source_message_id: id,
}
const requestSchema = z.strictObject({
  source: z.strictObject({ ...coordinates, revision: version, message_digest: digest }),
  reference_request_id: id, source_kind: z.enum(['message', 'file']), source_locator: id, source_version: version,
  range: z.strictObject({ start: offset, end: offset, unit: z.enum(['utf16', 'byte']) }),
  mime_type: z.string().max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[\x20-\x7e]+)?$/u),
  content_digest: digest, byte_length: z.number().int().min(0).max(referenceBytes),
  recipient_mention_ids: z.array(id).min(1).max(10).refine(values => new Set(values).size === values.length),
  source_evidence_spans: z.array(z.strictObject({ source_message_id: id,
    source_revision: version, start: offset, end: offset })).min(1).max(64),
}).refine((value) => {
  const extent = value.range.end - value.range.start
  return extent >= 0 && (value.range.unit === 'byte' ? extent === value.byte_length
    : extent <= value.byte_length && value.byte_length <= extent * 3)
    && Buffer.byteLength(JSON.stringify(value)) <= referenceBytes
})
/** Retained reservation metadata excludes renewable Host proofs and contains no content or filesystem path. */
export type CollaborationReferenceRequest = Readonly<z.infer<typeof requestSchema>>
/** Owning Profile reader verifies locator access and version; the iterator verifies its complete source on completion. */
export interface CollaborationReferenceContentSource {
  readonly source_kind: 'message' | 'file'
  readonly source_locator: string
  readonly source_version: string
  readonly mime_type: string
  readonly chunks: AsyncIterable<Uint8Array>
}
function isTextual(request: CollaborationReferenceRequest): boolean {
  return request.source_kind === 'message' || /^(?:text\/|application\/(?:json|[^;]+\+json)(?:;|$))/iu.test(request.mime_type)
}
const recordSchema = z.strictObject({ schema_version: z.literal(1),
  descriptor: z.strictObject({ ...coordinates, source_revision: version, snapshot_digest: digest }),
  request: requestSchema, reference_request_digest: digest, content_base64: z.string().max(4 * Math.ceil(referenceBytes / 3)),
}).refine((value) => {
  try {
    const s = value.request.source, d = value.descriptor
    if (d.workspace_id !== s.workspace_id || d.session_id !== s.session_id || d.source_message_id !== s.source_message_id
      || d.source_revision !== s.revision || collaborationJournalDigest(value.request) !== value.reference_request_digest
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.content_base64)) return false
    const bytes = Buffer.from(value.content_base64, 'base64')
    if (bytes.toString('base64') !== value.content_base64 || bytes.length !== value.request.byte_length
      || createHash('sha256').update(bytes).digest('hex') !== value.request.content_digest) return false
    const text = value.request.range.unit === 'utf16' || isTextual(value.request)
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : undefined
    return value.request.range.unit === 'byte' || text?.length === value.request.range.end - value.request.range.start
  } catch { return false } // Corrupt stored content is refused; its original domain file is retained.
})
/** One durable Source-bound selection; its presence alone grants neither Account nor recipient-task access. */
export type CollaborationReferenceRecord = Readonly<z.infer<typeof recordSchema>>
const spec = defineDomain({ name: 'collaboration_reference_v2', version: 1,
  tables: { references: domainTable<string, CollaborationReferenceRecord>(recordSchema) },
})
function keyOf(record: CollaborationReferenceRecord): string {
  const d = record.descriptor
  return collaborationJournalDigest([d.workspace_id, d.session_id, d.source_message_id,
    d.source_revision, record.request.reference_request_id])
}
function splits(text: string, at: number): boolean {
  return at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff
    && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff
}

/**
 * Parse retained selection metadata without a renewable Source proof or an authority grant.
 * @param value - Original metadata from the private coordinator boundary.
 * @returns detached request; the Profile still verifies Source, user intent and actual content access.
 */
export function parseCollaborationReferenceRequest(value: unknown): CollaborationReferenceRequest {
  return deepFreeze(requestSchema.parse(value))
}

/**
 * Freeze an already authorized user selection after independent Profile content reads finish.
 * @param value - Exact retained request; neither caller digests nor parsed metadata establish sharing intent.
 * @param snapshot - Current original Source from the owning Profile journal.
 * @param read - Profile-owned locator/version reader; complete iteration must verify its source integrity.
 * @param signal - Current operation cancellation, checked before and after independent reads.
 * @returns frozen exact content and computed request digest, without an Account or recipient-task grant.
 */
export async function captureCollaborationReferenceContent(value: unknown, snapshot: CollaborationSourceSnapshot,
  read: (request: CollaborationReferenceRequest, signal: AbortSignal) => Promise<CollaborationReferenceContentSource>,
  signal: AbortSignal): Promise<CollaborationReferenceRecord> {
  signal.throwIfAborted()
  const request = deepFreeze(requestSchema.parse(value)), source = parseCollaborationSourceSnapshot(snapshot)
  if (request.source.workspace_id !== source.workspace_id || request.source.session_id !== source.session_id
    || request.source.source_message_id !== source.source_message_id || request.source.revision !== source.source_revision
    || request.source.message_digest !== createHash('sha256').update(source.original_message).digest('hex')
    || request.recipient_mention_ids.some(mentionId => !source.active_mentions.some(m => m.mention_id === mentionId && m.binding.kind === 'resolved'))
    || request.source_evidence_spans.some(span => span.source_message_id !== source.source_message_id
      || span.source_revision !== source.source_revision || span.start >= span.end || span.end > source.original_message.length
      || splits(source.original_message, span.start) || splits(source.original_message, span.end))) throw Error('collaboration_reference_source_changed')
  const content = await read(request, signal)
  signal.throwIfAborted()
  if (content.source_kind !== request.source_kind || content.source_locator !== request.source_locator
    || content.source_version !== request.source_version || content.mime_type !== request.mime_type) throw Error('collaboration_reference_source_changed')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), parts: Buffer[] = []
  let position = 0, bytes = 0
  const retain = (part: Uint8Array) => {
    bytes += part.byteLength
    if (bytes > referenceBytes || bytes > request.byte_length) throw Error('collaboration_reference_content_changed')
    parts.push(Buffer.from(part))
  }
  const textPart = (text: string) => {
    const start = request.range.start - position, end = request.range.end - position
    if (splits(text, start) || splits(text, end)) throw Error('collaboration_reference_range_invalid')
    retain(Buffer.from(text.slice(Math.max(0, start), Math.max(0, end))))
    position += text.length
  }
  // Read to completion even after the selected range, so the owning file provider verifies its full source digest.
  for await (const chunk of content.chunks) {
    signal.throwIfAborted()
    if (request.range.unit === 'utf16') textPart(decoder.decode(chunk, { stream: true }))
    else {
      retain(chunk.subarray(Math.max(0, request.range.start - position), Math.max(0, request.range.end - position)))
      position += chunk.byteLength
    }
  }
  signal.throwIfAborted()
  if (request.range.unit === 'utf16') textPart(decoder.decode())
  if (position < request.range.end) throw Error('collaboration_reference_range_invalid')
  const selected = Buffer.concat(parts)
  if (isTextual(request))
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected)
  return deepFreeze(recordSchema.parse({ schema_version: 1, descriptor: describeCollaborationSource(source), request,
    reference_request_digest: collaborationJournalDigest(request), content_base64: selected.toString('base64') }))
}

/** Profile domain handle; current Source/Account/access checks remain the coordinator's responsibility. */
export interface CollaborationReferenceJournal {
  /**
   * Persist one independently captured selection before the Host may attest it.
   * @param record - Exact Source/request/content record after verified extraction and user intent checks.
   * @param signal - Queue cancellation checked before the accepted durable write.
   * @returns original immutable record for exact repeats; changed selections under the same identity refuse.
   */
  capture(record: CollaborationReferenceRecord, signal: AbortSignal): Promise<CollaborationReferenceRecord>
  /**
   * Read a committed selection against the original current Source.
   * @param source - Current journal snapshot, revalidated by the Profile coordinator.
   * @param requestDigest - Full immutable reservation digest; a Source digest supplies no selection.
   * @returns original record or undefined; changed Source content never yields another generation's grant.
   */
  read(source: CollaborationSourceSnapshot, requestDigest: string): CollaborationReferenceRecord | undefined
  /** @returns completion after accepted writes drain and the domain closes. */
  close(): Promise<void>
}
/**
 * Open an independent Profile-local reference domain, retaining corrupt files for diagnosis.
 * @param facility - Current Profile storage handle; this primitive does not authenticate its caller.
 * @returns domain owner whose capture requires independently authorized and extracted selections.
 */
export async function openCollaborationReferenceJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationReferenceJournal> {
  const domain = await facility.open(spec), table = domain.table('references')
  try {
    for (const [key, value] of table.entries()) {
      if (key !== keyOf(value)) throw Error('collaboration_reference_journal_invalid')
      deepFreeze(value)
    }
  } catch (error) { await domain.close(); throw error }
  let chain: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined, recoveryRequired = false
  const healthy = () => { if (recoveryRequired) throw Error('collaboration_reference_journal_recovery_required') }
  const open = () => { if (closing) throw Error('collaboration_reference_journal_closed'); healthy() }
  return {
    capture(record, signal) {
      let captured: CollaborationReferenceRecord
      try { open(); signal.throwIfAborted(); captured = deepFreeze(recordSchema.parse(record)) }
      catch (error) { return Promise.reject(error instanceof Error ? error : Error('collaboration_reference_journal_invalid', { cause: error })) }
      const operation = chain.then(async () => {
        healthy(); signal.throwIfAborted()
        const key = keyOf(captured), previous = table.get(key)
        if (previous) {
          if (collaborationJournalDigest(previous) !== collaborationJournalDigest(captured)) throw Error('collaboration_reference_payload_conflict')
          return previous
        }
        const siblings = [...table.entries()].map(([, value]) => value).filter(value =>
          collaborationJournalDigest(value.descriptor) === collaborationJournalDigest(captured.descriptor))
        if (table.size >= 128 * 8 || siblings.length >= 8
          || siblings.reduce((total, value) => total + value.request.byte_length, captured.request.byte_length) > referenceBytes)
          throw Error('collaboration_reference_capacity_reached')
        try { await table.put(key, captured) } catch (error) { recoveryRequired = true; throw error }
        return captured
      })
      chain = operation.then(() => {}, () => {})
      return operation
    },
    read(source, requestDigest) {
      open()
      const descriptor = describeCollaborationSource(parseCollaborationSourceSnapshot(source))
      digest.parse(requestDigest)
      return [...table.entries()].map(([, value]) => value).find(value => value.reference_request_digest === requestDigest
        && collaborationJournalDigest(value.descriptor) === collaborationJournalDigest(descriptor))
    },
    close() { closing ??= chain.then(() => domain.close()); return closing },
  }
}
