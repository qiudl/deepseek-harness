import { DesktopRootPlanning } from './desktop-root-planning.ts'
import type { CollaborationRootPlanningJournal, CollaborationRootPlanningGrant } from '@deepseek-ai/dsh-api-session-controller'
import { parseHostCollaborationSourceTarget, parseHostRootSubmissionTarget, matchHostRootAnalysisOutput, type HostRootAnalysisOutput, parseHostRootAnalysisInput, parseHostRootSubmissionDescriptor, type HostRootSubmissionDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
/** Profile-owned two-stage analysis; executable calls stay in this worker and never survive recovery. */
import { isDeepStrictEqual } from 'node:util'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type SessionController from '@deepseek-ai/dsh-api-session-controller'
import { createCollaborationAnalysisWriter, describeCollaborationSource, parseCollaborationClarificationInput, parseCollaborationSourceInput } from '@deepseek-ai/dsh-api-session-controller'
import type {
  CollaborationAnalysisJournal,
  CollaborationAnalysisJournalRecord,
  CollaborationAnalysisDispatchGrant,
  CollaborationSourceInput,
  CollaborationSourceSnapshot,
} from '@deepseek-ai/dsh-api-session-controller'
type RootCapture = SessionController['captureCollaborationRoot']
type Capture = SessionController['captureCollaborationSource']
type Preparation = Readonly<{ kind:'recovered';descriptor:ReturnType<typeof describeCollaborationSource> }>
  | Readonly<{ kind:'prepared';descriptor:ReturnType<typeof describeCollaborationSource> }
    & Pick<CollaborationAnalysisJournalRecord,'attempt_request_id'|'input_manifest_digest'|'source_digest'>>
type SourceOutput = Readonly<{ state: 'missing'; descriptor: ReturnType<typeof describeCollaborationSource> }>
  | Readonly<{ state: 'saved'; descriptor: ReturnType<typeof describeCollaborationSource>; dispatch: CollaborationAnalysisDispatchGrant; output_digest: string; json_base64url: string }>
type Captured = Extract<Awaited<ReturnType<Capture>>, { kind: 'captured' }>
type ReplyCapture = Readonly<{ kind: 'captured' | 'recovered'; descriptor: ReturnType<typeof describeCollaborationSource> }>
type Result = Awaited<ReturnType<Extract<Awaited<ReturnType<Capture>>, { kind: 'captured' }>['analyze']>>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  void promise.catch(() => {}) // Cancellation can precede installation of the owning waiter.
  return { promise, resolve, reject }
}
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('collaboration_analysis_cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}
type Pending = {
  binding: string
  resumeBinding?: string
  controller: AbortController
  reply?: Captured
  record?: CollaborationAnalysisJournalRecord
  root?: HostRootSubmissionDescriptor
  sourceDigest?: string
  grant: ReturnType<typeof deferred<CollaborationAnalysisDispatchGrant>>
  result?: Promise<Result>
  started: boolean
  timer: ReturnType<typeof setTimeout>
}
/** Private Parent Host coordinator. The caller must keep its original Account/peer binding current. */
export class DesktopCollaborationAnalysis {
  /** Fresh-attempt owner; absent unless its durable reader and model preparer are installed. */
  readonly rootPlanning?: DesktopRootPlanning
  private readonly pending = new Set<Pending>()
  private journal?: Promise<CollaborationAnalysisJournal>
  private closing?: Promise<void>
  /**
   * @param capture - Owning Profile's bound Source capture operation.
   * @param open - Profile-local complete-input journal factory.
   * @param lifetime - Profile cancellation; it never grants Account or cloud authority.
   * @param readRoot - Current Profile membership-checked root reader for saved output recovery.
   * @param captureRoot - Original root capture and live analysis handle from the same Profile.
   * @param execution - Profile-owned concrete execution journal; no model or cloud dispatch.
   * @param feedback - Profile-owned original Session consumption with persisted evidence.
   * @param consumption - Durable one-shot consumer commands and controlled original Agent continuation.
   * @param planning - Original-model preparation and independent fresh-attempt journal factories.
   * @param readSource - Current owning Session membership reader for ordinary Source output recovery.
   */
  constructor(
    private readonly capture: Capture,
    private readonly open: () => Promise<CollaborationAnalysisJournal>,
    private readonly lifetime: AbortSignal,
    private readonly captureRoot?: RootCapture,
    private readonly readRoot?: SessionController['readCollaborationRoot'],
    planning?: { prepare: SessionController['prepareCollaborationRootPlanning']; open: () => Promise<CollaborationRootPlanningJournal> },
    private readonly execution?: SessionController['collaborationRootExecution'],
    private readonly feedback?: SessionController['collaborationRootFeedback'],
    private readonly consumption?: SessionController['collaborationRootConsumption'],
    private readonly readSource?: SessionController['readCollaborationSourceSnapshot'],
  ) {
    if (planning && readRoot) this.rootPlanning = new DesktopRootPlanning(readRoot, planning.prepare, planning.open,
      () => this.journal ??= this.open(), (root) => {
        // An immutable root always retains the same Source digest, including after admission.
        if ([...this.pending].some(p => !p.controller.signal.aborted && p.sourceDigest === root.source_digest)) throw Error('collaboration_root_planning_original_alive')
      }, lifetime)
  }
  /** Read or enqueue original Session feedback under the private parent lifetime.
   * @param operation - Exact root, execution, delivery and observed Session prefix.
   * @param signal - Parent cancellation; current cloud permission remains the parent's responsibility.
   * @returns Persisted consumption evidence; enqueue does not wake a model.
   */
  async rootFeedback(operation: unknown, signal: AbortSignal): Promise<
    Awaited<ReturnType<SessionController['collaborationRootFeedback']>> | Awaited<ReturnType<SessionController['collaborationRootConsumption']>>
  > {
    if (this.closing || !this.feedback) throw Error('collaboration_feedback_unavailable')
    const active = AbortSignal.any([signal, this.lifetime])
    active.throwIfAborted()
    const action: unknown = operation && typeof operation === 'object' ? Object.getOwnPropertyDescriptor(operation, 'action')?.value : undefined
    const consumer = action === 'consumer_read' || action === 'consumer_prepare' || action === 'consumer_start'
    const consume = this.consumption
    if (consumer && !consume) throw Error('collaboration_consumption_unavailable')
    const result = consumer && consume ? await consume(operation, active) : await this.feedback(operation, active)
    active.throwIfAborted()
    return result
  }
  /** Read or persist concrete execution metadata under the owning Profile lifetime.
   * @param operation - Exact private operation, validated by SessionController before asynchronous reads.
   * @param signal - Parent request lifetime; no executable handle survives this operation.
   * @returns Original durable record or null; absent composition rejects explicitly.
   */
  async executionJournal(operation: unknown, signal: AbortSignal): ReturnType<SessionController['collaborationRootExecution']> {
    if (this.closing || !this.execution) throw Error('collaboration_execution_journal_unavailable')
    const active = AbortSignal.any([signal, this.lifetime])
    active.throwIfAborted()
    const result = await this.execution(operation, active)
    active.throwIfAborted()
    return result
  }
  /**
   * Persist original Source and full input, then pause its one-shot call for up to 30 seconds.
   * Recovered Sources return only their descriptor. Caller cancellation before acknowledgement
   * closes the preparation; completion of the prepare request does not cancel the retained operation.
   * @param input - Parent-classified content and mentions; Profile derives model and verifies membership.
   * @param binding - Digest of the Parent's original Account/Host binding, retained for dispatch.
   * @param signal - Preparation request cancellation, detached after acknowledged preparation.
   * @returns a non-executable Source descriptor and, for a first capture, its durable attempt identity.
   */
  async prepare(input: CollaborationSourceInput, binding: string, signal: AbortSignal): Promise<Preparation> {
    return this.prepareOwned(active => this.capture(input, active), binding, signal)
  }
  /** Persist the original root before publishing its first live analysis preparation.
   * @param value - Trusted Main namespace/policy and original Source input, without proposed IDs.
   * @param binding - Original current Account/Host digest, retained by dispatch.
   * @param signal - Request cancellation; a recovered root never recreates an executable call.
   * @param resumeBinding - Parent-derived stable Account/Profile/Host-process identity for reconnect handoff.
   * @returns Original root descriptor plus first preparation or non-executable recovery.
   */
  async prepareRoot(
    value: unknown, binding: string, signal: AbortSignal, resumeBinding?: string,
  ): Promise<Preparation & { root: HostRootSubmissionDescriptor }> {
    signal.throwIfAborted()
    const input = parseHostRootAnalysisInput(value)
    const capture = this.captureRoot
    if (!capture) throw Error('collaboration_root_capture_unavailable')
    const result = await this.prepareOwned(
      active => capture({ ...input, source: input.source as CollaborationSourceInput }, active), binding, signal, resumeBinding,
    )
    /* v8 ignore next -- A successful RootCapture always supplies submission; prepareOwned builds its descriptor before returning. */
    if (!result.root) throw Error('collaboration_root_capture_unavailable')
    return Object.freeze({ ...result,root:result.root })
  }
  /** Read an existing root without capture, preparation or journal writes.
   * @param value - Original source and namespace/policy selected by Main.
   * @param signal - Cancellation combined with current Profile lifetime.
   * @param allowPending - Permit pending records only for the separate reconciliation operation.
   * @returns Original recovered root; missing or changed input rejects. Pending records otherwise reject.
   */
  async recoverRoot(
    value: unknown, signal: AbortSignal, allowPending = false,
  ): Promise<Preparation & { root: HostRootSubmissionDescriptor }> {
    const input = parseHostRootAnalysisInput(value), active = AbortSignal.any([signal,this.lifetime])
    const assertOpen = () => {active.throwIfAborted(); if(this.closing)throw Error('collaboration_analysis_closed')}
    assertOpen()
    if (!this.readRoot || !input.source || typeof input.source !== 'object' || Array.isArray(input.source)) throw Error('collaboration_root_unavailable')
    const source = input.source as Record<string,unknown>
    const coordinates = Object.fromEntries(['workspace_id','session_id','source_message_id','source_revision'].map(k=>[k,source[k]]))
    const entry = await this.readRoot({ namespace_id:input.namespace_id,...coordinates },active)
    assertOpen()
    const original = Object.fromEntries(['workspace_id','session_id','source_message_id','source_revision','original_message','active_mentions'].map(k=>[k,entry.source[k as keyof typeof entry.source]]))
    if((entry.state !== 'admitted' && !allowPending) || entry.continuation_policy !== input.continuation_policy || !isDeepStrictEqual(original,source)) throw Error('collaboration_root_unavailable')
    const descriptor = describeCollaborationSource(entry.source)
    const root = parseHostRootSubmissionDescriptor({ namespace_id:entry.namespace_id,command_id:entry.command_id,
      root_task_id:entry.root_task_id,root_trace_id:entry.root_trace_id,payload_digest:entry.payload_digest,source_descriptor:descriptor })
    return Object.freeze({ kind:'recovered' as const,descriptor,root })
  }
  /** Return the original live preparation only while its dispatch remains unused.
   * @param value - Original root input; the root must already have a durable admission receipt.
   * @param binding - Current connection binding becomes the sole dispatch owner after handoff.
   * @param signal - Current request cancellation; the original preparation deadline is unchanged.
   * @param resumeBinding - Parent-derived Account/Profile/Host identity must match the original preparation.
   * @returns Original prepared metadata; restart, timeout, used dispatch and changed input reject.
   */
  async resumeRoot(
    value: unknown, binding: string, signal: AbortSignal, resumeBinding?: string,
  ): Promise<Preparation & { root: HostRootSubmissionDescriptor }> {
    const recovered = await this.recoverRoot(value,signal)
    const candidates=[...this.pending].filter(p=>p.root?.root_task_id===recovered.root.root_task_id &&
      p.root.namespace_id===recovered.root.namespace_id)
    const p=candidates[0]
    const journal=await wait((this.journal ??= this.open()),signal)
    const current=await this.recoverRoot(value,signal)
    signal.throwIfAborted()
    this.lifetime.throwIfAborted()
    if(!isDeepStrictEqual(current.root,recovered.root)) throw Error('collaboration_analysis_preparation_unavailable')
    if(this.closing || candidates.length!==1 || !p?.record || !p.result || p.started || p.controller.signal.aborted ||
      (!resumeBinding || p.resumeBinding!==resumeBinding) || !isDeepStrictEqual(p.root,recovered.root)) throw Error('collaboration_analysis_preparation_unavailable')
    const record=p.record
    const stored=[...journal.records()].find(r=>r.attempt_request_id===record.attempt_request_id)
    if(!stored || stored.dispatch || stored.source_digest!==recovered.descriptor.snapshot_digest ||
      stored.input_manifest_digest!==p.record.input_manifest_digest) throw Error('collaboration_analysis_preparation_unavailable')
    p.binding=binding
    return Object.freeze({ ...recovered,kind:'prepared' as const,attempt_request_id:stored.attempt_request_id,
      input_manifest_digest:stored.input_manifest_digest,source_digest:stored.source_digest })
  }
  private async prepareOwned(
    captureOriginal: (signal: AbortSignal) => ReturnType<Capture> | ReturnType<RootCapture>,
    binding: string, signal: AbortSignal, resumeBinding?: string,
  ): Promise<Preparation & { root?: HostRootSubmissionDescriptor }> {
    signal.throwIfAborted()
    const p = this.reserve(binding), controller = p.controller,
      owned = AbortSignal.any([controller.signal, this.lifetime])
    const cancel = () => { controller.abort(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    if (resumeBinding) p.resumeBinding = resumeBinding
    try {
      const capture = await captureOriginal(owned)
      p.sourceDigest = describeCollaborationSource(capture.snapshot).snapshot_digest
      const root = 'submission' in capture ? parseHostRootSubmissionDescriptor({
        namespace_id: capture.submission.namespace_id, command_id: capture.submission.command_id,
        root_task_id: capture.submission.root_task_id, root_trace_id: capture.submission.root_trace_id,
        payload_digest: capture.submission.payload_digest, source_descriptor: describeCollaborationSource(capture.snapshot),
      }) : undefined
      if (root) p.root=root
      owned.throwIfAborted()
      if (capture.kind === 'recovered') {
        return Object.freeze({ kind: 'recovered' as const, descriptor: describeCollaborationSource(capture.snapshot), ...(root ? { root } : {}) })
      }
      return await this.begin(p, capture.snapshot, (writer, active) => capture.analyze(writer, active), signal)
    } catch (error) {
      controller.abort(error)
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!p.result) {
        clearTimeout(p.timer)
        this.pending.delete(p)
        controller.abort(Error('collaboration_analysis_preparation_finished'))
      }
    }
  }
  private reserve(binding: string): Pending {
    this.lifetime.throwIfAborted()
    if (this.closing) throw Error('collaboration_analysis_closed')
    if (this.pending.size >= 2) throw Error('collaboration_analysis_busy')
    const controller = new AbortController()
    const p: Pending = { binding, controller, grant: deferred<CollaborationAnalysisDispatchGrant>(), started: false,
      timer: setTimeout(() => {
        controller.abort(Error('collaboration_analysis_timeout'))
        if (!p.result) this.pending.delete(p)
      }, 30000) }
    p.timer.unref(); this.pending.add(p)
    return p
  }
  private async begin(p: Pending, source: CollaborationSourceSnapshot,
    run: Captured['analyze'], signal: AbortSignal): Promise<Preparation> {
    const owned = AbortSignal.any([p.controller.signal, this.lifetime]), ready = deferred<CollaborationAnalysisJournalRecord>()
    const journal = await wait((this.journal ??= this.open()), owned)
    const writer = createCollaborationAnalysisWriter(journal, async (record, active) => {
      p.record = record
      ready.resolve(record)
      return wait(p.grant.promise, active)
    })
    p.result = run(writer, owned)
      .then(async (result) => {
        const record = p.record
        if (!record) throw Error('collaboration_analysis_input_missing')
        await journal.saveOutput(record, result.jsonText, owned)
        owned.throwIfAborted()
        return result
      })
      .finally(() => {
        p.controller.abort(Error('collaboration_analysis_finished'))
        clearTimeout(p.timer)
        this.pending.delete(p)
      })
    void p.result.catch((error: unknown) => {
      ready.reject(error)
    })
    const record = await wait(ready.promise, owned)
    owned.throwIfAborted()
    signal.throwIfAborted()
    return Object.freeze({
      kind: 'prepared' as const,
      ...(p.root ? { root: p.root } : {}),
      descriptor: describeCollaborationSource(source),
      attempt_request_id: record.attempt_request_id,
      input_manifest_digest: record.input_manifest_digest,
      source_digest: record.source_digest,
    })
  }
  /**
   * Commit a reply Source without analyzing or assigning it; retain only its live prepared call.
   * @param value - Same-chat raw reply with no active mentions; Profile derives the current model.
   * @param binding - Current original Account/Host binding digest.
   * @param signal - Capture request cancellation, detached after acknowledgement.
   * @returns passive reply descriptor; recovery never supplies a new executable call.
   */
  async captureReply(value: CollaborationSourceInput, binding: string, signal: AbortSignal): Promise<ReplyCapture> {
    signal.throwIfAborted(); this.lifetime.throwIfAborted()
    if (this.closing) throw Error('collaboration_analysis_closed')
    const input = parseCollaborationSourceInput(value)
    if (input.active_mentions.length) throw Error('collaboration_clarification_new_mention')
    const existing = [...this.pending].find(p => p.reply && p.binding === binding
      && p.reply.snapshot.workspace_id === input.workspace_id && p.reply.snapshot.session_id === input.session_id
      && p.reply.snapshot.source_message_id === input.source_message_id && p.reply.snapshot.source_revision === input.source_revision)
    if (existing) {
      const captured = await this.capture(input, AbortSignal.any([signal, this.lifetime, existing.controller.signal]))
      if (captured.kind !== 'recovered') throw Error('collaboration_analysis_preparation_unavailable')
      signal.throwIfAborted(); this.lifetime.throwIfAborted(); existing.controller.signal.throwIfAborted()
      return Object.freeze({ kind: 'recovered', descriptor: describeCollaborationSource(captured.snapshot) })
    }
    const p = this.reserve(binding), cancel = () => { p.controller.abort(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const captured = await this.capture(input, AbortSignal.any([p.controller.signal, this.lifetime]))
      p.controller.signal.throwIfAborted(); this.lifetime.throwIfAborted(); signal.throwIfAborted()
      if (captured.kind === 'captured') p.reply = captured
      return Object.freeze({ kind: captured.kind, descriptor: describeCollaborationSource(captured.snapshot) })
    } catch (error) { p.controller.abort(error); throw error }
    finally {
      signal.removeEventListener('abort', cancel)
      if (!p.reply) { clearTimeout(p.timer); this.pending.delete(p); p.controller.abort() }
    }
  }
  /**
   * Commit a complete clarification input using this worker's retained reply call, then wait for a new grant.
   * @param value - Trusted coordinator's queued original/reply snapshots and selected pending identities.
   * @param binding - Same current Account/Host binding used at reply capture.
   * @param signal - Preparation cancellation; detached only after the full input acknowledgement.
   * @returns original Source descriptor and durable new attempt identity, without task admission.
   */
  async prepareClarification(value: unknown, binding: string, signal: AbortSignal): Promise<Preparation> {
    signal.throwIfAborted(); this.lifetime.throwIfAborted()
    const input = parseCollaborationClarificationInput(value)
    const p = [...this.pending].find(item => item.reply && item.binding === binding
      && describeCollaborationSource(item.reply.snapshot).snapshot_digest === input.reply_snapshot_digest)
    if (this.closing || !p?.reply || p.controller.signal.aborted) throw Error('collaboration_analysis_preparation_unavailable')
    const captured = p.reply
    delete p.reply // Reserve this capability synchronously before the first asynchronous write.
    const cancel = () => { p.controller.abort(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.begin(p, input.original_snapshot, (writer, active) => captured.analyzeClarification(input, writer, active), signal)
    } catch (error) { p.controller.abort(error); throw error }
    finally {
      signal.removeEventListener('abort', cancel)
      if (!p.result) { clearTimeout(p.timer); this.pending.delete(p); p.controller.abort() }
    }
  }
  /** Read an ordinary Source's original saved output without capture or model preparation.
   * @param value - Exact original Source coordinates; no content, model or attempt overrides.
   * @param signal - Parent cancellation combined with the owning Profile lifetime.
   * @returns Saved original bytes and consumed grant, or missing; neither permits a new dispatch.
   */
  async readSourceOutput(value: unknown, signal: AbortSignal): Promise<SourceOutput> {
    const active = AbortSignal.any([signal, this.lifetime]), target = parseHostCollaborationSourceTarget(value)
    const ensureOpen = () => { active.throwIfAborted(); if (this.closing) throw Error('collaboration_analysis_closed') }
    ensureOpen()
    const reader = this.readSource
    if (!reader) throw Error('collaboration_source_output_unavailable')
    const source = await reader(target, active)
    ensureOpen()
    const descriptor = describeCollaborationSource(source)
    const journal = await wait((this.journal ??= this.open()), active)
    ensureOpen()
    const originals = new Map([...journal.records()].filter((record) => {
      const manifest = JSON.parse(record.manifest_json) as { prompt_version: string }
      return record.source_digest === descriptor.snapshot_digest && (manifest.prompt_version === '1' || manifest.prompt_version === '3')
    }).map(record => [record.input_manifest_digest, record]))
    const outputs = [...journal.outputs()].filter(output => originals.has(output.input_manifest_digest))
    if (outputs.length > 1) throw Error('collaboration_analysis_output_ambiguous')
    const output = outputs[0]
    let result: SourceOutput = Object.freeze({ state: 'missing', descriptor })
    if (output) {
      const record = originals.get(output.input_manifest_digest)
      /* v8 ignore next -- Journal opening/saveOutput validate every output against its immutable consumed input. */
      if (!record?.dispatch) throw Error('collaboration_analysis_output_invalid')
      result = Object.freeze({ state: 'saved', descriptor, dispatch: record.dispatch,
        output_digest: output.output_digest, json_base64url: Buffer.from(output.json_text, 'utf8').toString('base64url') })
    }
    const current = await reader(target, active)
    ensureOpen()
    if (!isDeepStrictEqual(describeCollaborationSource(current), descriptor)) throw Error('collaboration_analysis_output_invalid')
    return result
  }
  /** Read only the original saved output after current root membership is verified.
   * @param value - Original root and Source lookup; no model or attempt overrides.
   * @param signal - Parent request cancellation combined with Profile lifetime.
   * @returns Saved output and consumed grant, or missing; never recreates a model call.
   */
  async readRootOutput(value: unknown, signal: AbortSignal): Promise<HostRootAnalysisOutput> {
    const active = AbortSignal.any([signal,this.lifetime]), target = parseHostRootSubmissionTarget(value)
    active.throwIfAborted()
    if (this.closing || !this.readRoot) throw Error('collaboration_analysis_closed')
    const ensureOpen = () => { active.throwIfAborted(); if (this.closing) throw Error('collaboration_analysis_closed') }
    const entry = await this.readRoot(target,active)
    if (entry.state !== 'admitted') throw Error('collaboration_root_not_admitted')
    const root = parseHostRootSubmissionDescriptor({ namespace_id:entry.namespace_id,command_id:entry.command_id,
      root_task_id:entry.root_task_id,root_trace_id:entry.root_trace_id,payload_digest:entry.payload_digest,
      source_descriptor:describeCollaborationSource(entry.source) })
    const journal = await wait((this.journal ??= this.open()), active)
    const outputs = [...journal.outputs()].filter(output => output.source_digest === entry.source_digest)
    if (outputs.length > 1) throw Error('collaboration_analysis_output_ambiguous')
    const output = outputs[0]
    let result: HostRootAnalysisOutput = { state:'missing',root }
    if (output) {
      const records = [...journal.records()].filter(record => record.input_manifest_digest === output.input_manifest_digest)
      const record = records[0]
      /* v8 ignore next -- Journal opening/saveOutput validate the unique consumed input; both iterators are immutable. */
      if (records.length !== 1 || !record?.dispatch || record.attempt_request_id !== output.attempt_request_id ||
        record.source_digest !== entry.source_digest) throw Error('collaboration_analysis_output_invalid')
      result = matchHostRootAnalysisOutput({ state:'saved',root,dispatch:record.dispatch,output_digest:output.output_digest,
        json_base64url:Buffer.from(output.json_text,'utf8').toString('base64url') },target)
    }
    const current = await this.readRoot(target,active)
    active.throwIfAborted()
    ensureOpen()
    if (current.root_task_id !== entry.root_task_id || current.root_trace_id !== entry.root_trace_id ||
      current.payload_digest !== entry.payload_digest || current.state !== 'admitted') throw Error('collaboration_analysis_output_invalid')
    return result
  }
  /**
   * Continue only the matching live preparation. Grant validation and its durable write finish
   * before any model request. Concurrent/repeated dispatch never starts another model call.
   * @param attemptId - Original durable attempt identity returned by prepare.
   * @param binding - Parent's same current Account/Host binding digest.
   * @param grant - Current cloud receipt; possession alone grants no authority.
   * @param signal - Dispatch request cancellation, retained through model completion.
   * @returns untrusted JSON from the original zero-tool model, without task admission.
   */
  async dispatch(
    attemptId: string,
    binding: string,
    grant: CollaborationAnalysisDispatchGrant,
    signal: AbortSignal,
  ): Promise<Result> {
    signal.throwIfAborted()
    this.lifetime.throwIfAborted()
    const p = [...this.pending].find(value => value.record?.attempt_request_id === attemptId)
    if (this.closing || !p || !p.result || p.started || p.binding !== binding || p.controller.signal.aborted)
      throw Error('collaboration_analysis_preparation_unavailable')
    p.started = true
    const cancel = () => {
      p.controller.abort(signal.reason)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      p.grant.resolve(grant)
      return await wait(p.result, signal)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  /**
   * Cancel live preparations and close the owned journals after accepted writes drain.
   * @returns completion of cancellation and journal closure.
   */
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      for (const p of this.pending) {
        p.controller.abort(Error('collaboration_analysis_closed'))
        clearTimeout(p.timer)
      }
      await this.rootPlanning?.close()
      await (await this.journal)?.close()
    })
    return this.closing
  }
}
/**
 * Execute a private Parent command; neither browser cookies nor Source-read tokens authorize it.
 * @param req - Exact prepare/dispatch command, limited to 1 MiB.
 * @param res - Noncacheable JSON; refusals exclude Source content, keys and exception details.
 * @param token - Profile-worker analysis capability owned only by its Parent Host.
 * @param owner - Profile-local two-stage coordinator.
 */
export async function handleDesktopCollaborationAnalysisRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  owner: DesktopCollaborationAnalysis,
): Promise<void> {
  const actual = Buffer.from(
      req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '',
    ),
    expected = Buffer.from(token)
  if (
    req.method !== 'POST' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    res.writeHead(403, { 'cache-control': 'no-store' }).end()
    return
  }
  const controller = new AbortController(),
    closed = () => {
      if (!res.writableEnded) controller.abort()
    },
    aborted = () => {
      controller.abort()
    },
    timer = setTimeout(() => {
      controller.abort()
      req.destroy()
    }, 35000)
  req.once('aborted', aborted)
  res.once('close', closed)
  const send = (status: number, value: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res
        .writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify(value))
  }
  try {
    let row: Record<string, unknown>
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req as AsyncIterable<unknown>) {
        controller.signal.throwIfAborted()
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 1024 * 1024) throw Error('invalid')
        chunks.push(Buffer.from(chunk))
      }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('invalid')
      row = parsed as Record<string, unknown>
      const keys = (row.action === 'root_execution_journal' || row.action === 'root_feedback') ? ['action', 'operation', 'binding_key'] :
        (row.action === 'prepare_root_attempt' || row.action === 'read_root_attempt') ? ['action', 'target', 'binding_key']
          : row.action === 'inspect_root_attempt' ? ['action', 'target', 'attempt_request_id', 'binding_key']
            : row.action === 'dispatch_root_attempt' ? ['action', 'attempt_request_id', 'grant', 'binding_key']
              : (row.action === 'prepare' || row.action === 'capture_reply' || row.action === 'prepare_clarification' || row.action === 'prepare_root' || row.action === 'recover_root' || row.action === 'reconcile_root' || row.action === 'resume_root')
                ? ['action', 'binding_key', 'input', ...((row.action === 'resume_root' || (row.action === 'prepare_root' && Object.hasOwn(row,'resume_binding_key'))) ? ['resume_binding_key'] : [])]
                : (row.action === 'read_root_output' || row.action === 'read_source_output') ? ['action','binding_key','target']
                  : row.action === 'dispatch'
                    ? ['action', 'attempt_request_id', 'binding_key', 'grant']
                    : []
      if (
        !keys.length ||
        Object.keys(row).length !== keys.length ||
        keys.some(key => !Object.hasOwn(row, key)) ||
        (Object.hasOwn(row,'resume_binding_key') && (typeof row.resume_binding_key!=='string' || !/^[a-f0-9]{64}$/u.test(row.resume_binding_key))) ||
        typeof row.binding_key !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.binding_key) ||
        (['dispatch', 'dispatch_root_attempt', 'inspect_root_attempt'].includes(row.action as string) &&
          (typeof row.attempt_request_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(row.attempt_request_id)))
      )
        throw Error('invalid')
    } catch {
      send(400, { error: 'invalid_input' })
      return
    }
    try {
      const planning = () => {
        if (!owner.rootPlanning) throw Error('collaboration_root_planning_unavailable')
        return owner.rootPlanning
      }
      const value = row.action === 'capture_reply' ? await owner.captureReply(row.input as CollaborationSourceInput, row.binding_key, controller.signal)
        : row.action === 'prepare_clarification' ? await owner.prepareClarification(row.input, row.binding_key, controller.signal)
          : row.action === 'root_feedback' ? await owner.rootFeedback(row.operation, controller.signal) : row.action === 'root_execution_journal' ? await owner.executionJournal(row.operation, controller.signal) :
            row.action === 'read_root_attempt' ? await planning().readEvidence(row.target, controller.signal)
              : row.action === 'prepare_root_attempt' ? await planning().prepare(row.target, row.binding_key, controller.signal)
                : row.action === 'inspect_root_attempt' ? await planning().inspect(row.target, row.attempt_request_id as string,
                  row.binding_key, controller.signal)
                  : row.action === 'dispatch_root_attempt' ? await planning().dispatch(row.attempt_request_id as string,
                    row.binding_key, row.grant as CollaborationRootPlanningGrant, controller.signal)
                    : row.action === 'resume_root' ? await owner.resumeRoot(row.input,row.binding_key,controller.signal,row.resume_binding_key as string)
                      : row.action === 'read_source_output' ? await owner.readSourceOutput(row.target, controller.signal)
                        : row.action === 'read_root_output' ? await owner.readRootOutput(row.target, controller.signal)
                          : (row.action === 'recover_root' || row.action === 'reconcile_root') ? await owner.recoverRoot(row.input,controller.signal,row.action === 'reconcile_root')
                            : row.action === 'prepare_root'
                              ? await owner.prepareRoot(row.input, row.binding_key, controller.signal,
                                row.resume_binding_key as string | undefined)
                              : row.action === 'prepare'
                                ? await owner.prepare(row.input as CollaborationSourceInput, row.binding_key, controller.signal)
                                : await owner.dispatch(
                                  row.attempt_request_id as string,
                                  row.binding_key,
                                  row.grant as CollaborationAnalysisDispatchGrant,
                                  controller.signal,
                                )
      controller.signal.throwIfAborted()
      send(200, { value })
    } catch {
      send(422, { error: 'unavailable' })
    }
  } finally {
    clearTimeout(timer)
    req.off('aborted', aborted)
    res.off('close', closed)
  }
}
