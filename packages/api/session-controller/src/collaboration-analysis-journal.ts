/** REQ-20260930-0004: complete Host analysis inputs and consumed dispatch grants, separate from Session logs. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { describeCollaborationSource, parseCollaborationSourceSnapshot } from './collaboration-source-journal.ts'
import { clarificationAnalysisMessage, parseCollaborationClarificationInput } from './collaboration-clarification-input.ts'
import { parseCollaborationReferenceCatalogue } from './collaboration-reference-catalogue.ts'
import type { CollaborationAnalysisManifest } from './collaboration-analysis.ts'

const id = z.string().regex(/^[\x21-\x7e]{1,256}$/u)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const version = z.string().refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n)
const grantSchema = z.strictObject({ attempt_request_id: id, plan_id: id, expected_plan_revision: version,
  attempt_id: id, attempt_fence: version, input_manifest_digest: digest, source_digest: digest,
  lease_expires_at: z.iso.datetime(), dispatch_granted: z.literal(true),
})
/** Current coordinator receipt; possession alone does not establish Account or Host authority. */
export type CollaborationAnalysisDispatchGrant = Readonly<z.infer<typeof grantSchema>>
const rawRecordSchema = z.strictObject({ attempt_request_id: id, source_digest: digest, input_manifest_digest: digest,
  manifest_json: z.string().max(1024 * 1024).refine(value => Buffer.byteLength(value, 'utf8') <= 1024 * 1024),
  dispatch: grantSchema.optional(),
})
/** Complete non-executable input and optional consumed grant retained for reconciliation. */
export type CollaborationAnalysisJournalRecord = Omit<Readonly<z.infer<typeof rawRecordSchema>>, 'dispatch'> & {
  readonly dispatch?: CollaborationAnalysisDispatchGrant | undefined
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function valid(record: CollaborationAnalysisJournalRecord): boolean {
  try {
    const parsed: unknown = JSON.parse(record.manifest_json)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const manifest = parsed as Record<string, unknown>
    const clarification = (manifest.prompt_version === '2' || manifest.prompt_version === '4') ? parseCollaborationClarificationInput(manifest.clarification) : undefined
    const catalogue = manifest.prompt_version === '3' || manifest.prompt_version === '4'
      ? parseCollaborationReferenceCatalogue(manifest.reference_catalogue) : undefined
    const keys = ['prompt_version', 'request', 'source', ...(clarification ? ['clarification'] : []), ...(catalogue ? ['reference_catalogue'] : [])]
    if (!['1', '2', '3', '4'].includes(String(manifest.prompt_version)) || typeof manifest.prompt_version !== 'string'
      || Object.keys(manifest).sort().join(',') !== keys.sort().join(',')
      || canonical(manifest) !== record.manifest_json) return false
    const source = parseCollaborationSourceSnapshot(manifest.source)
    if (clarification && canonical(clarification.original_snapshot) !== canonical(source)) return false
    const request = manifest.request as Record<string, unknown> | null
    if (record.source_digest !== describeCollaborationSource(source).snapshot_digest
      || hash(record.manifest_json) !== record.input_manifest_digest || !source.active_mentions.length
      || request === null || typeof request !== 'object' || Array.isArray(request)
      || request.provider !== source.model_snapshot.provider || request.model !== source.model_snapshot.model
      || request.purpose !== 'collaboration-analysis' || Object.hasOwn(request, 'signal')
      || !Array.isArray(request.tools) || request.tools.length !== 0
      || typeof request.system !== 'string' || !request.system.trim()
      || !Number.isInteger(request.maxTokens) || (request.maxTokens as number) < 1 || (request.maxTokens as number) > 8192
      || Buffer.byteLength(JSON.stringify(request), 'utf8') + 256 > 16384
      || !Array.isArray(request.messages) || request.messages.length !== 1) return false
    const message = request.messages[0] as { role?: unknown; source?: { kind?: unknown }; content?: { type?: unknown; text?: unknown }[] }
    if (message.role !== 'user' || message.source?.kind !== 'user' || message.content?.length !== 1
      || message.content[0]?.type !== 'text' || typeof message.content[0].text !== 'string') return false
    const original: Record<string, unknown> = clarification
      ? JSON.parse(clarificationAnalysisMessage(clarification)) as Record<string, unknown>
      : { source_message_id: source.source_message_id, source_revision: source.source_revision,
        original_message: source.original_message, active_mentions: source.active_mentions }
    const expected = catalogue === undefined ? original : { ...original, reference_catalogue: catalogue }
    if (canonical(JSON.parse(message.content[0].text)) !== canonical(expected)) return false
    return record.dispatch === undefined || (record.dispatch.attempt_request_id === record.attempt_request_id
      && record.dispatch.input_manifest_digest === record.input_manifest_digest && record.dispatch.source_digest === record.source_digest
      && (!clarification || (record.dispatch.plan_id === clarification.plan.plan_id
        && record.dispatch.expected_plan_revision === clarification.plan.plan_revision)))
  } catch { return false } // Invalid persisted JSON is refused; its original file is retained by the domain owner.
}
const recordSchema = rawRecordSchema.refine(valid)
const spec = defineDomain({ name: 'collaboration_analysis_v2', version: 1,
  tables: { attempts: domainTable<string, CollaborationAnalysisJournalRecord>(recordSchema) },
})

const outputSchema = z
  .strictObject({
    attempt_request_id: id,
    source_digest: digest,
    input_manifest_digest: digest,
    json_text: z
      .string()
      .max(32768)
      .refine(value => value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 32768),
    output_digest: digest,
  })
  .refine((value) => {
    try {
      const parsed: unknown = JSON.parse(value.json_text)
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        hash(value.json_text) === value.output_digest
      )
    } catch {
      return false
    }
  })
type AnalysisOutput = Readonly<z.infer<typeof outputSchema>>
const outputSpec = defineDomain({
  name: 'collaboration_analysis_output_v2',
  version: 1,
  tables: { results: domainTable<string, AnalysisOutput>(outputSchema) },
})
/** Profile-owned input journal; records never contain an executable call or restore one. */
export interface CollaborationAnalysisJournal {
  /**
   * Commit the signal-free full request, keeping the original request ID for exact repeats.
   * @param manifest - Original Source and complete captured model-visible request.
   * @param signal - Queue cancellation checked before the accepted write.
   * @returns the committed frozen input record; no dispatch grant is created.
   */
  prepare(manifest: CollaborationAnalysisManifest, signal: AbortSignal): Promise<CollaborationAnalysisJournalRecord>
  /**
   * Persist one current, matching grant before the model may be dispatched.
   * @param record - Committed record from this journal.
   * @param grant - Receipt from the trusted current coordinator operation.
   * @param signal - Current Profile/analysis cancellation.
   * @returns the record after the grant write commits; repeats reject instead of sending again.
   */
  dispatch(record: CollaborationAnalysisJournalRecord, grant: CollaborationAnalysisDispatchGrant,
    signal: AbortSignal): Promise<CollaborationAnalysisJournalRecord & { readonly dispatch: CollaborationAnalysisDispatchGrant }>
  /**
   * Save untrusted model JSON against its original consumed dispatch. No task is authorized.
   * Failed acknowledgement requires reopen; accepted output can never be replaced by different text.
   * @param record - Original persisted input and attempt identity.
   * @param jsonText - Complete original model JSON, bounded to 32 KiB.
   * @param signal - Current Profile/operation cancellation.
   * @returns the committed frozen output, also accessible for read-only recovery.
   */
  saveOutput(record:CollaborationAnalysisJournalRecord,jsonText:string,signal:AbortSignal):Promise<AnalysisOutput>
  /** @returns frozen original outputs; recovery never constructs executable model calls. */
  outputs():IterableIterator<AnalysisOutput>
  /** @returns a frozen record iterator for read-only recovery and reconciliation. */
  records(): IterableIterator<CollaborationAnalysisJournalRecord>
  /** @returns resolution after accepted writes drain and the domain closes. */
  close(): Promise<void>
}

/**
 * Open an independent single-layout authoritative domain. Corruption or an unknown version
 * rejects without discarding files; a lost write acknowledgement requires reopen/reconciliation.
 * @param facility - The owning Profile's storageDomain facility.
 * @returns its journal handle; the Profile must close it after accepted writes drain.
 */
export async function openCollaborationAnalysisJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationAnalysisJournal> {
  const domain = await facility.open(spec), table = domain.table('attempts')
  try {
    for (const [key, record] of table.entries()) {
      if (key !== record.input_manifest_digest) throw Error('collaboration_analysis_journal_invalid')
      deepFreeze(record)
    }
  } catch (error) { await domain.close(); throw error }
  let outputDomain: Awaited<ReturnType<typeof facility.open<typeof outputSpec>>>
  try {
    outputDomain = await facility.open(outputSpec)
  } catch (error) {
    await domain.close()
    throw error
  }
  const closeDomains = async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => domain.close()),
      Promise.resolve().then(() => outputDomain.close()),
    ])
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'collaboration_analysis_journal_close_failed')
  }
  const outputs = outputDomain.table('results')
  try {
    for (const [key, value] of outputs.entries()) {
      const original = table.get(key)
      if (
        !original?.dispatch ||
        key !== value.input_manifest_digest ||
        original.attempt_request_id !== value.attempt_request_id ||
        original.source_digest !== value.source_digest
      )
        throw Error('collaboration_analysis_output_invalid')
      deepFreeze(value)
    }
  } catch (error) {
    await closeDomains()
    throw error
  }

  let tail = Promise.resolve(), closing: Promise<void> | undefined, recoveryRequired = false
  const healthy = () => { if (recoveryRequired) throw Error('collaboration_analysis_journal_recovery_required') }
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('collaboration_analysis_journal_closed'))
    const operation = tail.then(async () => { healthy(); return work() })
    tail = operation.then(() => {}, () => {})
    return operation
  }
  const put = async <T extends CollaborationAnalysisJournalRecord>(record: T): Promise<T> => {
    try { await table.put(record.input_manifest_digest, record) }
    catch (error) { recoveryRequired = true; throw error }
    return record
  }
  return {
    prepare(manifest, signal) {
      let record: CollaborationAnalysisJournalRecord
      try {
        signal.throwIfAborted()
        // JSON normalization preserves the provider-visible vocabulary and omits unset optional fields.
        const normalized: unknown = JSON.parse(JSON.stringify(manifest))
        const manifest_json = canonical(normalized)
        record = deepFreeze(recordSchema.parse({ attempt_request_id: randomUUID(), manifest_json,
          input_manifest_digest: hash(manifest_json), source_digest: describeCollaborationSource(manifest.source).snapshot_digest }))
      } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('collaboration_analysis_journal_invalid', { cause: error })) }
      return enqueue(async () => {
        signal.throwIfAborted()
        const previous = table.get(record.input_manifest_digest)
        if (previous) return previous
        if (table.size >= 256) throw Error('collaboration_analysis_journal_capacity_reached')
        return put(record)
      })
    },
    dispatch(record, value, signal) {
      // Detach at the queued/wire receipt, before it can be mutated by a transport owner.
      let grant: CollaborationAnalysisDispatchGrant
      try { grant = deepFreeze(grantSchema.parse(value)) }
      catch (error) { return Promise.reject(error instanceof Error ? error : new Error('collaboration_analysis_grant_invalid', { cause: error })) }
      return enqueue(async () => {
        signal.throwIfAborted()
        const stored = table.get(record.input_manifest_digest)
        if (!stored || stored.manifest_json !== record.manifest_json || stored.attempt_request_id !== record.attempt_request_id
          || grant.attempt_request_id !== stored.attempt_request_id || grant.source_digest !== stored.source_digest
          || grant.input_manifest_digest !== stored.input_manifest_digest) throw Error('collaboration_analysis_grant_invalid')
        if (stored.dispatch !== undefined) throw Error('collaboration_analysis_dispatch_used')
        if (Date.parse(grant.lease_expires_at) <= Date.now()) throw Error('collaboration_analysis_grant_expired')
        const dispatched = { ...stored, dispatch: grant }
        if (!recordSchema.safeParse(dispatched).success) throw Error('collaboration_analysis_grant_invalid')
        return put(deepFreeze(dispatched))
      })
    },
    saveOutput(record, jsonText, signal) {
      let value: AnalysisOutput
      try {
        value = deepFreeze(
          outputSchema.parse({
            attempt_request_id: record.attempt_request_id,
            input_manifest_digest: record.input_manifest_digest,
            source_digest: record.source_digest,
            json_text: jsonText,
            output_digest: hash(jsonText),
          }),
        )
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error('collaboration_analysis_output_invalid', { cause: error }),
        )
      }
      return enqueue(async () => {
        signal.throwIfAborted()
        const original = table.get(value.input_manifest_digest)
        if (
          !original?.dispatch ||
          original.attempt_request_id !== value.attempt_request_id ||
          original.source_digest !== value.source_digest ||
          original.manifest_json !== record.manifest_json
        )
          throw Error('collaboration_analysis_output_invalid')
        const previous = outputs.get(value.input_manifest_digest)
        if (previous) {
          if (previous.json_text !== value.json_text) throw Error('collaboration_analysis_output_conflict')
          return previous
        }
        try {
          await outputs.put(value.input_manifest_digest, value)
        } catch (error) {
          recoveryRequired = true
          throw error
        }
        signal.throwIfAborted()
        return value
      })
    },
    outputs() {
      if (closing) throw Error('collaboration_analysis_journal_closed')
      healthy()
      return [...outputs.entries()].map(([, value]) => value).values()
    },

    records() {
      if (closing) throw Error('collaboration_analysis_journal_closed')
      healthy()
      return [...table.entries()].map(([, record]) => record).values()
    },
    close() { closing ??= tail.then(closeDomains); return closing },
  }
}

/**
 * Build the Host-owned persist callback accepted by Source analysis. This grants no authority:
 * claim must hold current Account/Computer/Host ownership through the original coordinator request.
 * @param journal - Current Profile's journal, retained until accepted writes have drained.
 * @param claim - Trusted coordinator operation returning a matching, unused dispatch grant.
 * @returns a writer that commits the complete input and grant before resolving; recovery never resends.
 */
export function createCollaborationAnalysisWriter(journal: CollaborationAnalysisJournal,
  claim: (record: CollaborationAnalysisJournalRecord, signal: AbortSignal) => Promise<CollaborationAnalysisDispatchGrant>):
(manifest: CollaborationAnalysisManifest, signal: AbortSignal) => Promise<void> {
  return async (manifest, signal) => {
    const record = await journal.prepare(manifest, signal)
    signal.throwIfAborted()
    if (record.dispatch !== undefined) throw Error('collaboration_analysis_dispatch_used')
    const grant = await claim(record, signal)
    signal.throwIfAborted()
    const saved = await journal.dispatch(record, grant, signal)
    signal.throwIfAborted()
    if (Date.parse(saved.dispatch.lease_expires_at) <= Date.now()) throw Error('collaboration_analysis_grant_expired')
  }
}
