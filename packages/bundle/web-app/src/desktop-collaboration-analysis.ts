/** Profile-owned two-stage analysis; executable calls stay in this worker and never survive recovery. */
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
type Capture = SessionController['captureCollaborationSource']
type Preparation = Readonly<{ kind:'recovered';descriptor:ReturnType<typeof describeCollaborationSource> }>
  | Readonly<{ kind:'prepared';descriptor:ReturnType<typeof describeCollaborationSource> }
    & Pick<CollaborationAnalysisJournalRecord,'attempt_request_id'|'input_manifest_digest'|'source_digest'>>
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
  controller: AbortController
  reply?: Captured
  record?: CollaborationAnalysisJournalRecord
  grant: ReturnType<typeof deferred<CollaborationAnalysisDispatchGrant>>
  result?: Promise<Result>
  started: boolean
  timer: ReturnType<typeof setTimeout>
}
/** Private Parent Host coordinator. The caller must keep its original Account/peer binding current. */
export class DesktopCollaborationAnalysis {
  private readonly pending = new Set<Pending>()
  private journal?: Promise<CollaborationAnalysisJournal>
  private closing?: Promise<void>
  /**
   * @param capture - Owning Profile's bound Source capture operation.
   * @param open - Profile-local complete-input journal factory.
   * @param lifetime - Profile cancellation; it never grants Account or cloud authority.
   */
  constructor(
    private readonly capture: Capture,
    private readonly open: () => Promise<CollaborationAnalysisJournal>,
    private readonly lifetime: AbortSignal,
  ) {}
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
    signal.throwIfAborted()
    const p = this.reserve(binding), controller = p.controller,
      owned = AbortSignal.any([controller.signal, this.lifetime])
    const cancel = () => { controller.abort(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const capture = await this.capture(input, owned)
      owned.throwIfAborted()
      if (capture.kind === 'recovered') {
        return Object.freeze({ kind: 'recovered' as const, descriptor: describeCollaborationSource(capture.snapshot) })
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
      const keys =
        (row.action === 'prepare' || row.action === 'capture_reply' || row.action === 'prepare_clarification')
          ? ['action', 'binding_key', 'input']
          : row.action === 'dispatch'
            ? ['action', 'attempt_request_id', 'binding_key', 'grant']
            : []
      if (
        !keys.length ||
        Object.keys(row).length !== keys.length ||
        keys.some(key => !Object.hasOwn(row, key)) ||
        typeof row.binding_key !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.binding_key) ||
        (row.action === 'dispatch' &&
          (typeof row.attempt_request_id !== 'string' || !/^[a-f0-9-]{36}$/u.test(row.attempt_request_id)))
      )
        throw Error('invalid')
    } catch {
      send(400, { error: 'invalid_input' })
      return
    }
    try {
      const value =
        row.action === 'prepare'
          ? await owner.prepare(row.input as CollaborationSourceInput, row.binding_key, controller.signal)
          : row.action === 'capture_reply'
            ? await owner.captureReply(row.input as CollaborationSourceInput, row.binding_key, controller.signal)
            : row.action === 'prepare_clarification'
              ? await owner.prepareClarification(row.input, row.binding_key, controller.signal)
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
