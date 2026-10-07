/** REQ-20261004-0008: fresh planning inputs under immutable roots, in a separate Profile-owned domain. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { callConfigEquals, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedLlmSnapshotCall, MessageId } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { collaborationJournalDigest, describeCollaborationSource } from './collaboration-source-journal.ts'
import { parseCollaborationRootSubmission } from './collaboration-root-journal.ts'
import type { CollaborationRootSubmission, CollaborationRootDescriptor } from './collaboration-root-journal.ts'

/** A new prepared planning request; distinct from root admission and server attempt identities. */
export type CollaborationPlanningRequestId = Branded<'CollaborationPlanningRequestId'>
const exact = (pattern: RegExp) => z.string().refine(value => pattern.exec(value)?.[0] === value)
const uuid = exact(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const requestId = uuid.transform(brandString<CollaborationPlanningRequestId>)
const digest = exact(/^[0-9a-f]{64}$/u)
const version = exact(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) <= 9223372036854775807n)
const text = (bytes: number) => z.string().refine(value => value.isWellFormed() && !!value.trim()
  && Buffer.byteLength(value, 'utf8') <= bytes)
const modelSchema = z.strictObject({ provider: text(256), model: text(256), configuration_generation: version,
  adapter_fingerprint: digest, reasoning_effort: text(128).optional() })
const predecessorSchema = z.strictObject({ attempt_request_id: requestId, input_manifest_digest: digest })
/** Non-executable reference to the previous local input; cloud dispatch state requires independent reconciliation. */
export type CollaborationPlanningPredecessor = Readonly<z.infer<typeof predecessorSchema>> | null
type Request = Omit<GenerateOptions, 'signal'>
const requestSchema = z.strictObject({
  traceparent: exact(/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-01$/u).optional(), provider: text(256), model: text(256),
  reasoningEffort: text(128).transform(ReasoningEffortId).optional(), maxTokens: z.number().int().min(1).max(8192),
  purpose: z.literal('collaboration-analysis'), system: text(16384), tools: z.tuple([]),
  messages: z.tuple([z.strictObject({ id: uuid.transform(brandString<MessageId>), role: z.literal('user'),
    source: z.strictObject({ kind: z.literal('user') }), content: z.tuple([z.strictObject({ type: z.literal('text'), text: text(16384) })]),
  })]),
}).transform(({ reasoningEffort, traceparent, ...r }) => ({ ...r, ...reasoningEffort === undefined ? {} : { reasoningEffort },
  ...traceparent === undefined ? {} : { traceparent } }))
const rootSchema = z.unknown().transform((value, ctx) => {
  try {
    const root = parseCollaborationRootSubmission(value)
    if (root.state !== 'admitted' || !root.source.active_mentions.length) throw Error('root not admitted')
    return root
  } catch { ctx.addIssue({ code: 'custom', message: 'collaboration_root_planning_origin_invalid' }); return z.NEVER }
})
const manifestSchema = z.strictObject({ schema_version: z.literal(1), prompt_version: z.literal('1'),
  input_version: z.literal('1'), root: rootSchema, predecessor: predecessorSchema.nullable(), attempt_request_id: requestId,
  model_policy: z.literal('original_model'), model_snapshot: modelSchema,
  request: requestSchema,
}).refine((m) => {
  const original = m.root.source.model_snapshot, model = m.model_snapshot, r = m.request
  if ((r.traceparent !== undefined && r.traceparent.split('-')[1] !== m.root.root_trace_id) ||
    m.predecessor?.attempt_request_id === m.attempt_request_id ||
    model.provider !== original.provider || model.model !== original.model || model.reasoning_effort !== original.reasoning_effort ||
    deepEqualJson(model, original) || r.provider !== model.provider || r.model !== model.model ||
    r.reasoningEffort !== model.reasoning_effort || Buffer.byteLength(JSON.stringify(r), 'utf8') + 256 > 16384) return false
  const message = r.messages[0]
  try {
    const s = m.root.source
    return deepEqualJson(JSON.parse(message.content[0].text), { source_message_id: s.source_message_id,
      source_revision: s.source_revision, original_message: s.original_message, active_mentions: s.active_mentions })
  } catch { return false }
})
/** Full immutable origin and actual model-visible input; never an executable handle or an authorization grant. */
export type CollaborationRootPlanningManifest = Readonly<z.infer<typeof manifestSchema>>
const grantSchema = z.strictObject({ attempt_request_id: requestId, namespace_id: exact(/^n2_[0-9a-f]{64}$/u),
  root_task_id: uuid, root_trace_id: exact(/^(?!0{32}$)[0-9a-f]{32}$/u), model_snapshot: modelSchema,
  plan_id: exact(/^[!-~]{1,256}$/u), expected_plan_revision: version,
  attempt_id: exact(/^[!-~]{1,256}$/u), attempt_fence: version, source_digest: digest, input_manifest_digest: digest,
  lease_expires_at: z.iso.datetime(), dispatch_granted: z.literal(true),
})
/** Current trusted coordinator's one-use grant, bound to the new model and the original root. */
export type CollaborationRootPlanningGrant = Readonly<z.infer<typeof grantSchema>>
const outputDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const outputSchema = z.strictObject({ json_text: text(32768), output_digest: digest }).refine((value) => {
  try {
    const json: unknown = JSON.parse(value.json_text)
    return json !== null && typeof json === 'object' && !Array.isArray(json) &&
      value.output_digest === outputDigest(value.json_text)
  } catch { return false }
})
const recordSchema = z.strictObject({ manifest: manifestSchema, input_manifest_digest: digest,
  dispatch: grantSchema.optional(), output: outputSchema.optional(),
}).refine(r => r.input_manifest_digest === collaborationJournalDigest(r.manifest) &&
  r.manifest.predecessor?.input_manifest_digest !== r.input_manifest_digest &&
  (!r.dispatch || matches(r.manifest, r.input_manifest_digest, r.dispatch)) && (!r.output || !!r.dispatch))
/** One atomic input/dispatch/output record. Historical lease expiry does not erase consumed dispatch evidence. */
export type CollaborationRootPlanningRecord = Readonly<z.infer<typeof recordSchema>>
const spec = defineDomain({ name: 'collaboration_root_planning_v1', version: 1, layout: 'single',
  tables: { attempts: domainTable<string, CollaborationRootPlanningRecord>(recordSchema) },
})
function matches(m: CollaborationRootPlanningManifest, inputDigest: string, g: CollaborationRootPlanningGrant): boolean {
  return g.attempt_request_id === m.attempt_request_id && g.input_manifest_digest === inputDigest &&
    g.namespace_id === m.root.namespace_id && g.root_task_id === m.root.root_task_id && g.root_trace_id === m.root.root_trace_id &&
    g.source_digest === m.root.source_digest && deepEqualJson(g.model_snapshot, m.model_snapshot)
}
function cloneJson(value: unknown): unknown {
  const seen = new Set<object>()
  const check = (v: unknown): void => {
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.isWellFormed())) return
    if (!v || typeof v !== 'object' || seen.has(v) || Object.getOwnPropertySymbols(v).length ||
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)) throw Error('collaboration_root_planning_invalid')
    seen.add(v)
    const fields = Object.getOwnPropertyDescriptors(v)
    if (Array.isArray(v) && (Object.keys(fields).length !== v.length + 1 ||
      Array.from({ length: v.length }, (_, i) => !Object.hasOwn(fields, String(i))).some(Boolean))) throw Error('collaboration_root_planning_invalid')
    for (const [key, field] of Object.entries(fields)) {
      if (Array.isArray(v) && key === 'length') continue
      if (!field.enumerable || !('value' in field)) throw Error('collaboration_root_planning_invalid')
      check(field.value)
    }
    seen.delete(v)
  }
  check(value)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > 1024 * 1024) throw Error('collaboration_root_planning_input_budget')
  return JSON.parse(json)
}
/**
 * Bind a fresh prepared call to the original admitted Source and a complete signal-free request.
 * The owning Host must validate current membership and durably prepare the result before signing.
 * @param root - Original admitted root, including its unchanged Source and receipt.
 * @param predecessor - Previous input reference or null; this supplies no claim about cloud dispatch state.
 * @param prepared - Current runtime's captured one-shot model call, using the original model and reasoning setting.
 * @param request - Complete analysis input matching the captured configuration, with no tools or sampling overrides.
 * @returns a detached frozen manifest with a new request identity; does not persist or call the model.
 */
export function createCollaborationRootPlanningManifest(root: CollaborationRootSubmission,
  predecessor: { readonly attempt_request_id: string; readonly input_manifest_digest: string } | null,
  prepared: PreparedLlmSnapshotCall, request: Request): CollaborationRootPlanningManifest {
  if (!callConfigEquals(prepared.config, request)) throw Error('collaboration_root_planning_model_changed')
  return deepFreeze(manifestSchema.parse(cloneJson({ schema_version: 1, prompt_version: '1', input_version: '1',
    root, predecessor, attempt_request_id: randomUUID(), model_policy: 'original_model', model_snapshot: prepared.snapshot, request })))
}
const rootKey = (m: CollaborationRootPlanningManifest) => `${m.root.namespace_id}/${m.root.root_task_id}`
function tips(records: CollaborationRootPlanningRecord[]): Map<string, CollaborationRootPlanningRecord> {
  const byId = new Map(records.map(r => [r.manifest.attempt_request_id, r]))
  const groups = new Map<string, CollaborationRootPlanningRecord[]>(), parents = new Set<string>()
  for (const r of records) {
    const key = rootKey(r.manifest), group = groups.get(key) ?? []
    group.push(r); groups.set(key, group)
    const p = r.manifest.predecessor, parent = p && byId.get(p.attempt_request_id)
    if (parent) {
      if (parents.has(p.attempt_request_id) || parent.dispatch || p.input_manifest_digest !== parent.input_manifest_digest ||
        !deepEqualJson(r.manifest.root, parent.manifest.root)) throw Error('collaboration_root_planning_history_invalid')
      parents.add(p.attempt_request_id)
    }
  }
  const result = new Map<string, CollaborationRootPlanningRecord>()
  for (const [key, group] of groups) {
    const leaves = group.filter(r => !parents.has(r.manifest.attempt_request_id))
    const leaf = leaves[0]
    if (leaves.length !== 1 || !leaf) throw Error('collaboration_root_planning_history_invalid')
    const visited = new Set<string>()
    let cursor: CollaborationRootPlanningRecord | undefined = leaves[0]
    while (cursor) {
      const id = cursor.manifest.attempt_request_id
      /* v8 ignore next -- Every predecessor digest was validated above; a hash-consistent cycle requires a SHA-256 fixed point. */
      if (visited.has(id)) throw Error('collaboration_root_planning_history_invalid')
      visited.add(id)
      cursor = cursor.manifest.predecessor ? byId.get(cursor.manifest.predecessor.attempt_request_id) : undefined
    }
    /* v8 ignore next -- One leaf and no reused parent imply one chain unless a disconnected hash-consistent cycle exists. */
    if (visited.size !== group.length) throw Error('collaboration_root_planning_history_invalid')
    result.set(key, leaf)
  }
  return result
}
/** Bounded durable metadata; the private owner checks membership and live preparation separately. */
export type CollaborationRootPlanningDescriptor = Pick<CollaborationRootPlanningManifest,
  'input_version' | 'predecessor' | 'attempt_request_id' | 'model_policy' | 'model_snapshot'>
  & Readonly<{ root: CollaborationRootDescriptor; input_manifest_digest: string }>
/** Single Profile owner; failed write acknowledgements require close/reopen, never automatic replay. */
export interface CollaborationRootPlanningJournal {
  /**
   * Commit complete input; same identity and bytes return the historical record. Only an unused local tip can be superseded.
   * @param manifest - New captured input or exact transmission retry.
   * @param signal - Cancellation before the accepted write; accepted writes drain even after cancellation.
   * @returns durable immutable record, without issuing any dispatch authority.
   */
  prepare(manifest: CollaborationRootPlanningManifest, signal: AbortSignal): Promise<CollaborationRootPlanningRecord>
  /**
   * Persist matching unused dispatch on the current local tip before a provider call.
   * @param record - Original durable input from this journal.
   * @param grant - Grant authenticated and authorized by the current Host coordinator.
   * @param signal - Current operation cancellation.
   * @returns consumed grant record; repeats, expired grants and superseded inputs reject.
   */
  dispatch(record: CollaborationRootPlanningRecord, grant: CollaborationRootPlanningGrant,
    signal: AbortSignal): Promise<CollaborationRootPlanningRecord>
  /**
   * Commit untrusted output once against its original consumed dispatch.
   * @param record - Original input, including its exact digest.
   * @param jsonText - Bounded model JSON object; different repeated output rejects.
   * @param signal - Cancellation before acceptance.
   * @returns immutable record including the saved output; this does not admit tasks.
   */
  saveOutput(record: CollaborationRootPlanningRecord, jsonText: string, signal: AbortSignal): Promise<CollaborationRootPlanningRecord>
  /** Read metadata only after accepted writes finish; current unused local input is required.
   * @param attemptId - Exact previously prepared attempt identity.
   * @param signal - Cancellation while awaiting preceding journal operations.
   * @returns bounded descriptor; the Profile owner still validates membership and a live prepared handle.
   */
  inspectAttempt(attemptId: CollaborationPlanningRequestId, signal: AbortSignal): Promise<CollaborationRootPlanningDescriptor>
  /** Read the current chain tip after accepted writes settle; no liveness or dispatch authority is implied.
   * @param namespace - Original namespace.
   * @param rootId - Original root task identity.
   * @param signal - Cancellation while queued.
   * @returns Immutable latest record, or null; poisoned or closed journals reject.
   */
  readLatest(namespace: string, rootId: string, signal: AbortSignal): Promise<CollaborationRootPlanningRecord | null>
  /** @returns frozen durable records for reconciliation, never executable handles. */
  records(): IterableIterator<CollaborationRootPlanningRecord>
  /** @returns completion after accepted writes drain and the independent domain closes. */
  close(): Promise<void>
}
/**
 * Open the independent fresh-attempt domain; predecessor Source, root and analysis files are never opened or rewritten.
 * Local absence of dispatch is not proof of cloud absence. The caller must reconcile before obtaining another grant.
 * @param facility - Profile-owned storage facility, with sole writer ownership.
 * @returns a journal refusing corrupt, foreign-version, forked or hash-mismatched records without deleting them.
 */
export async function openCollaborationRootPlanningJournal(facility: Pick<DomainFacility, 'open'>): Promise<CollaborationRootPlanningJournal> {
  const domain = await facility.open(spec), table = domain.table('attempts')
  const all = () => [...table.entries()].map(([, value]) => value)
  try {
    for (const [key, value] of table.entries()) {
      if (key !== value.manifest.attempt_request_id) throw Error('collaboration_root_planning_history_invalid')
      deepFreeze(value)
    }
    tips(all())
  } catch (error) { await domain.close(); throw error }
  let tail = Promise.resolve(), closing: Promise<void> | undefined, recoveryRequired = false
  const healthy = () => {
    if (recoveryRequired) throw Error('collaboration_root_planning_recovery_required')
    if (closing) throw Error('collaboration_root_planning_closed')
  }
  const queue = <T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> => {
    try { healthy(); signal.throwIfAborted() } catch (error) {
      return Promise.reject(error instanceof Error ? error : Error('collaboration_root_planning_aborted', { cause: error }))
    }
    const operation = tail.then(async () => {
      if (recoveryRequired) throw Error('collaboration_root_planning_recovery_required')
      signal.throwIfAborted(); return work()
    })
    tail = operation.then(() => {}, () => {}); return operation
  }
  const put = async (record: CollaborationRootPlanningRecord) => {
    try { await table.put(record.manifest.attempt_request_id, record) }
    catch (error) { recoveryRequired = true; throw error }
    return record
  }
  const stored = (record: CollaborationRootPlanningRecord) => {
    const r = table.get(record.manifest.attempt_request_id)
    if (!r || r.input_manifest_digest !== record.input_manifest_digest || !deepEqualJson(r.manifest, record.manifest)) {
      throw Error('collaboration_root_planning_input_conflict')
    }
    return r
  }
  return {
    async prepare(input, signal) {
      const manifest = deepFreeze(manifestSchema.parse(cloneJson(input)))
      const record = deepFreeze(recordSchema.parse({ manifest, input_manifest_digest: collaborationJournalDigest(manifest) }))
      return queue(signal, async () => {
        if (table.get(manifest.attempt_request_id)) return stored(record)
        const tip = tips(all()).get(rootKey(manifest)), p = manifest.predecessor
        if (tip) {
          if (tip.dispatch) throw Error('collaboration_root_planning_dispatch_used')
          if (!p || p.attempt_request_id !== tip.manifest.attempt_request_id || p.input_manifest_digest !== tip.input_manifest_digest ||
            !deepEqualJson(manifest.root, tip.manifest.root)) throw Error('collaboration_root_planning_predecessor_conflict')
        }
        if (table.size >= 256) throw Error('collaboration_root_planning_capacity_reached')
        tips([...all(), record])
        return put(record)
      })
    },
    async dispatch(record, value, signal) {
      const grant = deepFreeze(grantSchema.parse(cloneJson(value)))
      return queue(signal, async () => {
        const r = stored(record)
        if (r.dispatch) throw Error('collaboration_root_planning_dispatch_used')
        if (tips(all()).get(rootKey(r.manifest)) !== r) throw Error('collaboration_root_planning_superseded')
        if (!matches(r.manifest, r.input_manifest_digest, grant)) throw Error('collaboration_root_planning_grant_invalid')
        if (Date.parse(grant.lease_expires_at) <= Date.now()) throw Error('collaboration_root_planning_grant_expired')
        return put(deepFreeze({ ...r, dispatch: grant }))
      })
    },
    async saveOutput(record, jsonText, signal) {
      const output = deepFreeze(outputSchema.parse({ json_text: jsonText, output_digest: outputDigest(jsonText) }))
      return queue(signal, async () => {
        const r = stored(record)
        if (!r.dispatch) throw Error('collaboration_root_planning_not_dispatched')
        if (r.output) {
          if (r.output.json_text !== jsonText) throw Error('collaboration_root_planning_output_conflict')
          return r
        }
        return put(deepFreeze({ ...r, output }))
      })
    },
    inspectAttempt(attemptId, signal) {
      return queue(signal, () => {
        const r = table.get(attemptId)
        if (!r) throw Error('collaboration_root_planning_missing')
        if (r.dispatch) throw Error('collaboration_root_planning_dispatch_used')
        const m = r.manifest
        if (tips(all()).get(rootKey(m)) !== r) throw Error('collaboration_root_planning_superseded')
        const root = m.root
        return deepFreeze({ root: { namespace_id: root.namespace_id, command_id: root.command_id,
          root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, payload_digest: root.payload_digest,
          source_descriptor: describeCollaborationSource(root.source) },
        input_version: m.input_version, model_policy: m.model_policy, model_snapshot: m.model_snapshot,
        attempt_request_id: m.attempt_request_id, input_manifest_digest: r.input_manifest_digest,
        predecessor: m.predecessor,
        })
      })
    },
    readLatest(namespace, rootId, signal) {
      return queue(signal, () => [...tips(all()).values()].find(r =>
        r.manifest.root.namespace_id === namespace && r.manifest.root.root_task_id === rootId) ?? null)
    },
    records() { healthy(); return all().values() },
    close() { closing ??= tail.then(() => domain.close()); return closing },
  }
}
/**
 * Persist a new input and its matching current grant before returning to the one-shot runner.
 * @param journal - Profile-owned journal retained until accepted writes drain.
 * @param claim - Trusted current coordinator operation, including predecessor reconciliation and Account checks.
 * @returns persist callback; unknown/failed grant or write acknowledgement never dispatches a provider.
 */
export function createCollaborationRootPlanningWriter(journal: CollaborationRootPlanningJournal,
  claim: (record: CollaborationRootPlanningRecord, signal: AbortSignal) => Promise<CollaborationRootPlanningGrant>):
(manifest: CollaborationRootPlanningManifest, signal: AbortSignal) => Promise<void> {
  return async (manifest, signal) => {
    const r = await journal.prepare(manifest, signal)
    signal.throwIfAborted()
    if (r.dispatch) throw Error('collaboration_root_planning_dispatch_used')
    if (tips([...journal.records()]).get(rootKey(r.manifest))?.manifest.attempt_request_id !== r.manifest.attempt_request_id) {
      throw Error('collaboration_root_planning_superseded')
    }
    const grant = await claim(r, signal)
    signal.throwIfAborted()
    const saved = await journal.dispatch(r, grant, signal)
    signal.throwIfAborted()
    if (!saved.dispatch || Date.parse(saved.dispatch.lease_expires_at) <= Date.now()) throw Error('collaboration_root_planning_grant_expired')
  }
}
