import type { HostRootPlanningEvidence } from '@deepseek-ai/dsh-host-control-protocol'
import { matchHostRootPlanningEvidence } from '@deepseek-ai/dsh-host-control-protocol'
/** Private Profile owner for newly prepared attempts under an immutable admitted root. */
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseHostRootSubmissionTarget, parseHostRootPlanningAttemptDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRootPlanningAttemptDescriptor, HostRootSubmissionTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { createCollaborationRootPlanningWriter } from '@deepseek-ai/dsh-api-session-controller'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationRootPlanningJournal, CollaborationAnalysisJournal, CollaborationRootPlanningRecord,
  CollaborationPlanningPredecessor, CollaborationPlanningRequestId, CollaborationRootPlanningGrant,
  CollaborationRootSubmission } from '@deepseek-ai/dsh-api-session-controller'
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {}) // Disposal can precede a consumer attaching its waiter.
  return { promise, resolve, reject }
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () =>{  reject(signal.reason instanceof Error ? signal.reason : Error('collaboration_root_planning_cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() =>{  signal.removeEventListener('abort', abort) })
  })
}
type Pending = {
  binding: string
  target: HostRootSubmissionTarget
  root: CollaborationRootSubmission
  controller: AbortController
  ready: ReturnType<typeof deferred<HostRootPlanningAttemptDescriptor>>
  grant: ReturnType<typeof deferred<CollaborationRootPlanningGrant>>
  record?: CollaborationRootPlanningRecord
  result?: Promise<{ jsonText: string }>
  setup?: Promise<void>
  started: boolean
  timer: ReturnType<typeof setTimeout>
}
/** Supplies metadata only for this Profile's live, persisted, unused attempt and original Account connection. */
export class DesktopRootPlanning {
  private readonly pending = new Map<string, Pending>()
  private journal?: Promise<CollaborationRootPlanningJournal>
  private closing?: Promise<void>
  /**
   * @param read - Profile membership-checked original-root reader.
   * @param prepareModel - Original-model preparer retaining operation cancellation.
   * @param open - Independent fresh-attempt journal factory.
   * @param legacy - Shared original-analysis journal owner.
   * @param assertNoOriginalPreparation - Refuses overlapping original live preparations for this Source.
   * @param lifetime - Profile disposal signal, retained through all pending operations.
   */
  constructor(
    private readonly read: SessionController['readCollaborationRoot'],
    private readonly prepareModel: SessionController['prepareCollaborationRootPlanning'],
    private readonly open: () => Promise<CollaborationRootPlanningJournal>,
    private readonly legacy: () => Promise<CollaborationAnalysisJournal>,
    private readonly assertNoOriginalPreparation: (root: CollaborationRootSubmission) => void,
    private readonly lifetime: AbortSignal,
  ) {}
  private assertOpen() {
    if (this.closing) throw Error('collaboration_root_planning_closed')
  }
  private async current(p: Pending, signal: AbortSignal) {
    signal.throwIfAborted(); this.lifetime.throwIfAborted(); p.controller.signal.throwIfAborted()
    this.assertOpen()
    const root = await this.read(p.target, signal)
    if (root.state !== 'admitted' || !isDeepStrictEqual(root, p.root)) throw Error('collaboration_root_planning_root_changed')
    this.assertNoOriginalPreparation(root)
    signal.throwIfAborted(); this.lifetime.throwIfAborted(); p.controller.signal.throwIfAborted()
    this.assertOpen()
  }
  /** Prepare once per live root; retries on the same connection retain the original deadline and identity.
   * @param value - Original root lookup, without model or predecessor overrides.
   * @param binding - Current parent-derived Account/Profile/Host/connection digest.
   * @param signal - Request cancellation; detached only after the durable preparation acknowledgement.
   * @returns Bounded metadata from the new input journal; no provider is called yet.
   */
  async prepare(value: unknown, binding: string, signal: AbortSignal): Promise<HostRootPlanningAttemptDescriptor> {
    const target = parseHostRootSubmissionTarget(value), active = AbortSignal.any([signal, this.lifetime])
    active.throwIfAborted()
    this.assertOpen()
    const root = await this.read(target, active)
    active.throwIfAborted()
    this.assertOpen()
    if (root.state !== 'admitted') throw Error('collaboration_root_not_admitted')
    this.assertNoOriginalPreparation(root)
    const key = JSON.stringify([root.namespace_id, root.command_id]), previous = this.pending.get(key)
    if (previous) {
      if (previous.binding !== binding || previous.started || !isDeepStrictEqual(previous.target, target))
        throw Error('collaboration_root_planning_owner_changed')
      const descriptor = await wait(previous.ready.promise, active)
      return this.inspect(target, descriptor.attempt_request_id, binding, active)
    }
    if (this.pending.size >= 2) throw Error('collaboration_root_planning_busy')
    const controller = new AbortController(), owned = AbortSignal.any([controller.signal, this.lifetime])
    const p: Pending = { binding, target, root, controller, ready: deferred(), grant: deferred(), started: false,
      timer: setTimeout(() =>{  controller.abort(Error('collaboration_root_planning_timeout')) }, 30000) }
    p.timer.unref(); this.pending.set(key, p)
    const cancel = () =>{  controller.abort(active.reason) }
    active.addEventListener('abort', cancel, { once: true })
    p.setup = (async () => {
      const journal = await wait(this.journal ??= this.open(), owned)
      const old = await wait(this.legacy(), owned)
      await this.current(p, owned)
      const historical = [...old.records()].filter(r => r.source_digest === root.source_digest)
      if (historical.length > 1 || historical.some(r => r.dispatch)) throw Error('collaboration_root_planning_dispatch_uncertain')
      const records = [...journal.records()].filter(r => r.manifest.root.namespace_id === root.namespace_id
        && r.manifest.root.root_task_id === root.root_task_id)
      const parents = new Set(records.map(r => r.manifest.predecessor?.attempt_request_id))
      const tips = records.filter(r => !parents.has(r.manifest.attempt_request_id)), tip = tips[0]
      /* v8 ignore next -- Journal opening and every prepare validate a single unbranched chain per root. */
      if (tips.length > 1) throw Error('collaboration_root_planning_ambiguous')
      if (tip) await journal.inspectAttempt(tip.manifest.attempt_request_id, owned)
      const prior = tip ? { attempt_request_id: tip.manifest.attempt_request_id, input_manifest_digest: tip.input_manifest_digest }
        : historical[0] ? { attempt_request_id: brandString<CollaborationPlanningRequestId>(historical[0].attempt_request_id),
          input_manifest_digest: historical[0].input_manifest_digest } : null
      const predecessor: CollaborationPlanningPredecessor = prior
      const capture = await this.prepareModel(target, predecessor, owned)
      if (!isDeepStrictEqual(capture.root, root)) throw Error('collaboration_root_planning_root_changed')
      await this.current(p, owned)
      const writer = createCollaborationRootPlanningWriter(journal, async (record, running) => {
        p.record = record
        const descriptor = await this.inspect(target, record.manifest.attempt_request_id, binding, running)
        p.ready.resolve(descriptor)
        return wait(p.grant.promise, running)
      })
      p.result = capture.analyze(writer, owned).then(async (result) => {
        /* v8 ignore next -- The owned runner awaits the writer (which installs p.record) before returning model output. */
        if (!p.record) throw Error('collaboration_root_planning_missing')
        await journal.saveOutput(p.record, result.jsonText, owned)
        return result
      }).catch(async (error: unknown) => {
        if (p.record) await journal.recordFailure(p.record, error)
        throw error
      })
      await p.result
    })().catch((error: unknown) => { p.ready.reject(error); throw error }).finally(() => {
      controller.abort(Error('collaboration_root_planning_finished'))
      clearTimeout(p.timer); this.pending.delete(key)
    })
    void p.setup.catch(() => {}) // The ready/dispatch waiters carry errors; disposal also awaits setup settlement.
    try { return await wait(p.ready.promise, active) }
    catch (error) { controller.abort(error); throw error }
    finally { active.removeEventListener('abort', cancel) }
  }
  /** Read current durable metadata only while the same preparation and connection remain live.
   * @param value - Original root lookup.
   * @param attemptId - Exact fresh attempt identity.
   * @param binding - Current parent-derived ownership digest.
   * @param signal - Request cancellation.
   * @returns Metadata after membership, journal and lifecycle checks on both sides of asynchronous reads.
   */
  async inspect(value: unknown, attemptId: string, binding: string, signal: AbortSignal): Promise<HostRootPlanningAttemptDescriptor> {
    const target = parseHostRootSubmissionTarget(value), p = this.pending.get(JSON.stringify([target.namespace_id, target.command_id]))
    const check = () => {
      signal.throwIfAborted(); this.lifetime.throwIfAborted()
      if (this.closing || !p?.record || !p.result || p.started || p.binding !== binding || p.controller.signal.aborted
        || p.record.manifest.attempt_request_id !== attemptId || !isDeepStrictEqual(p.target, target))
        throw Error('collaboration_root_planning_preparation_unavailable')
    }
    check()
    /* v8 ignore next -- check() above rejects a missing record synchronously, with no intervening await. */
    if (!p?.record) throw Error('collaboration_root_planning_missing')
    const active = AbortSignal.any([signal, this.lifetime, p.controller.signal])
    await this.current(p, active)
    const journal = await wait(this.journal ??= this.open(), active)
    const descriptor = parseHostRootPlanningAttemptDescriptor(await journal.inspectAttempt(p.record.manifest.attempt_request_id, active))
    await this.current(p, active); check()
    /* v8 ignore next -- The journal looks up this same immutable, hash-validated record by its attempt ID. */
    if (descriptor.input_manifest_digest !== p.record.input_manifest_digest) throw Error('collaboration_root_planning_input_changed')
    return descriptor
  }
  /** Read durable latest input and saved output without preparing or invoking a model.
   * @param value - Original root lookup authorized by the parent Host.
   * @param signal - Cancellation retained across storage and membership checks.
   * @returns Verified original-root evidence; lease expiry does not hide a consumed dispatch.
   */
  async readEvidence(value: unknown, signal: AbortSignal): Promise<HostRootPlanningEvidence> {
    const target = parseHostRootSubmissionTarget(value), active = AbortSignal.any([signal, this.lifetime])
    active.throwIfAborted(); this.assertOpen()
    const root = await this.read(target, active)
    if (root.state !== 'admitted') throw Error('collaboration_root_not_admitted')
    const journal = await wait(this.journal ??= this.open(), active)
    const record = await journal.readLatest(root.namespace_id, root.root_task_id, active)
    const descriptor = { namespace_id: root.namespace_id, command_id: root.command_id, root_task_id: root.root_task_id,
      root_trace_id: root.root_trace_id, payload_digest: root.payload_digest, source_descriptor: {
        workspace_id: root.source.workspace_id, session_id: root.source.session_id, source_message_id: root.source.source_message_id,
        source_revision: root.source.source_revision, snapshot_digest: root.source_digest,
      } }
    if (record && !isDeepStrictEqual(record.manifest.root, root)) throw Error('collaboration_root_planning_root_changed')
    const m = record?.manifest
    const evidence = matchHostRootPlanningEvidence({ root: descriptor, attempt: record && m ? {
      preparation: { root: descriptor, input_version: m.input_version, predecessor: m.predecessor, attempt_request_id: m.attempt_request_id,
        input_manifest_digest: record.input_manifest_digest, model_policy: m.model_policy, model_snapshot: m.model_snapshot },
      dispatch: record.dispatch ?? null,
      output: record.output ? { json_base64url: Buffer.from(record.output.json_text, 'utf8').toString('base64url'), output_digest: record.output.output_digest } : null,
    } : null }, target)
    if (!isDeepStrictEqual(await this.read(target, active), root)) throw Error('collaboration_root_planning_root_changed')
    active.throwIfAborted(); this.assertOpen()
    return evidence
  }
  /** Consume a matching current grant once; the input writer commits it before the provider call.
   * @param attemptId - Fresh attempt identity returned by prepare.
   * @param binding - Original connection binding.
   * @param grant - Parent-authenticated cloud grant, strictly validated by the journal.
   * @param signal - Dispatch cancellation retained through model completion.
   * @returns Original bounded output after its durable commit.
   */
  async dispatch(attemptId: string, binding: string, grant: CollaborationRootPlanningGrant,
    signal: AbortSignal): Promise<{ jsonText: string }> {
    const p = [...this.pending.values()].find(entry => entry.record?.manifest.attempt_request_id === attemptId)
    if (!p?.result) throw Error('collaboration_root_planning_preparation_unavailable')
    await this.inspect(p.target, attemptId, binding, signal)
    if (p.started) throw Error('collaboration_root_planning_dispatch_used')
    p.started = true
    p.timer.refresh()
    const abort = () =>{  p.controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try { signal.throwIfAborted(); p.grant.resolve(grant); return await wait(p.result, signal) }
    finally { signal.removeEventListener('abort', abort) }
  }
  /** Cancel preparations and await their settlement before closing the journal.
   * @returns Completion after pending operations settle and accepted writes drain.
   */
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const entries = [...this.pending.values()]
      for (const p of entries) p.controller.abort(Error('collaboration_root_planning_closed'))
      await Promise.allSettled(entries.map(p => Promise.resolve(p.setup)))
      await (await this.journal)?.close()
    })
    return this.closing
  }
}
