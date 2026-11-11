/** Actual Agent inbox consumption for the original Source-authorized paired step. */
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseHostTaskReadyAdmissionDirective, parseHostTaskTargetStepBody, hostTaskStepPayloadDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { PairedTaskTargetJournal, PairedTaskTargetAdmission } from './paired-task-target-journal.ts'
import { pairedTaskTargetInputProjection, pairedTaskTargetMessageDigest, type PairedTaskTargetInputState } from './paired-task-target-projection.ts'
import type { PairedTaskStepCapability, PairedTaskStepLease } from './paired-task-target-consumer-host.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Original logical step metadata; permission remains in the private worker capability. */
    'slark-task-target-step': {
      readonly kind: 'slark-task-target-step'
      readonly commandId: string
      readonly admissionId: string
      readonly invocationId: string
      readonly executionKey: string
      readonly stepPayloadDigest: string
    }
  }
}
interface ActiveInput {
  readonly lease: PairedTaskStepLease
  readonly journal: PairedTaskTargetJournal
  readonly controller: AbortController
  message: UserMessage | undefined
  expectedDigest: string | undefined
  current(): void
  read(): PairedTaskTargetInputState
  accept(record: PairedTaskTargetAdmission): void
}
/** Two observations of one original owned interval: durable input admission and eventual cleanup. */
export interface PairedTaskTargetRun {
  readonly accepted: Promise<PairedTaskTargetAdmission>
  readonly completion: Promise<PairedTaskTargetAdmission>
}
const idle = (agent: Agent) => agent.status === 'idle' && !agent.inbox.nextStep.length && !agent.inbox.nextTurn.length
/** Profile-owned consumer with one tracked interval for each actual waking input. */
export class PairedTaskTargetConsumer {
  private readonly active = new Map<string, ActiveInput>()
  private readonly operations = new Set<Promise<PairedTaskTargetAdmission>>()
  private closing = false
  private setup?: Promise<ProjectionHandle<PairedTaskTargetInputState>>
  private readonly listeners: (() => void)[] = []

  private initialize() {
    return this.setup ??= (async () => {
      const handle = await this.ctx.sessionProjections.register(pairedTaskTargetInputProjection)
      if (this.closing) { await handle.dispose(); throw Error('paired_target_consumer_closed') }
      this.listeners.push(this.ctx.on('agent/pre-inbox', ({ agent, message, target }) => {
        const active = this.active.get(agent.id)
        if (active) {
          active.current()
          if (message !== active.message || target !== 'next-step') throw Error('paired_target_input_conflict')
        } else if (message.source.kind === 'slark-task-target-step') throw Error('paired_target_private_capability_required')
      }))
      this.listeners.push(this.ctx.on('llm/stream', (options, next) => {
        const active = options.sessionId === undefined ? undefined : this.active.get(options.sessionId)
        if (active) return this.checkpoint(active, options, next)
        const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
        if (session && handle.stateOf(session).inputs > 0) throw Error('paired_target_private_capability_required')
        return next()
      }))
      return handle
    })()
  }

  private assertOpen(): void {
    if (this.closing) throw Error('paired_target_consumer_closed')
  }

  private async* checkpoint(active: ActiveInput, options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    active.current()
    if (!this.ctx.get('sessionPersistence') || !await this.ctx.sessions.flush(active.lease.session))
      throw Error('paired_target_input_not_durable')
    active.current(); options.signal?.throwIfAborted()
    const state = active.read(), message = active.message
    if (!message || state.inputs !== 1 || state.foreignInput || state.turn === null || state.step === null
      || state.messageId !== message.id || state.messageDigest !== active.expectedDigest)
      throw Error('paired_target_input_not_claimed')
    const retained = active.journal.admission(active.lease.admission.itemId)
    if (retained?.state === 'start_intent') await active.journal.recordClaim(retained.itemId,
      { messageId: message.id, turn: state.turn, step: state.step }, active.lease.signal)
    else if (retained?.state !== 'claimed' || retained.turn !== state.turn || retained.messageId !== message.id
      || retained.step === null || retained.step > state.step) throw Error('paired_target_claim_changed')
    active.current(); options.signal?.throwIfAborted()
    const claimed = active.journal.admission(active.lease.admission.itemId)
    if (!claimed || claimed.state !== 'claimed') throw Error('paired_target_input_not_claimed')
    active.accept(claimed)
    yield* next()
  }

  /** @param ctx - Actual owning Controller context.
   * @param open - Profile-owned journal factory, called only for an explicit private consumption attempt.
   * @param lifetime - Controller-owned cancellation, retained until owned consumers drain.
   */
  constructor(private readonly ctx: Context, private readonly open: () => Promise<PairedTaskTargetJournal>,
    private readonly lifetime: AbortSignal) {}

  /** Install read-only input denial before any cold Agent can wake; this opens no writer journal.
   * @returns Completion after the owning projection and model checkpoint are registered.
   */
  async activate(): Promise<void> { await this.initialize() }

  /** Admit only a private factory capability and wake its original loaded Agent once.
   * @param capability - Original object retained by the actual current worker factory.
   * @param signal - Current authenticated parent request cancellation.
   * @returns The actual retained admission after this owned interval settles; failures remain unconfirmed.
   */
  start(capability: PairedTaskStepCapability, signal: AbortSignal): Promise<PairedTaskTargetAdmission> {
    return this.begin(capability, signal).completion
  }

  /** Begin one private interval and expose its durable input claim separately from eventual cleanup.
   * @param capability - Original one-use object retained by the authenticated worker factory.
   * @param signal - Short request cancellation, effective until the original input claim commits.
   * @returns The first durable claim and the same owned interval's completion; neither promises tool quiescence.
   */
  begin(capability: PairedTaskStepCapability, signal: AbortSignal): PairedTaskTargetRun {
    const accepted = Promise.withResolvers<PairedTaskTargetAdmission>()
    void accepted.promise.catch(() => {}) // Callers awaiting only completion still own the same failure.
    const operation = this.consume(capability, signal, (record) =>{  accepted.resolve(record) })
    this.operations.add(operation)
    void operation.then(() => {
      this.operations.delete(operation)
      accepted.reject(Error('paired_target_input_not_claimed'))
    }, (error: unknown) => {
      this.operations.delete(operation); accepted.reject(error)
    })
    return Object.freeze({ accepted: accepted.promise, completion: operation })
  }

  private async consume(capability: PairedTaskStepCapability, signal: AbortSignal,
    accept: (record: PairedTaskTargetAdmission) => void): Promise<PairedTaskTargetAdmission> {
    if (this.closing) throw Error('paired_target_consumer_closed')
    const host = this.ctx.get('pairedTaskTargetConsumerHost')
    if (!host) throw Error('paired_target_provider_unavailable')
    const handle = await this.initialize()
    const journal = await this.open()
    this.assertOpen()
    const lease = host.take(capability, signal), { agent, session } = lease
    let reserved = false, woke = false, locallyDrained = false
    let stopUnary = () => {}
    try {
      const body = parseHostTaskTargetStepBody(JSON.stringify(lease.body))
      const proposal = parseHostTaskReadyAdmissionDirective(lease.proposal), admission = journal.admission(lease.admission.itemId)
      if (!admission || admission.state !== 'source_consumed' || admission.readyJson !== JSON.stringify(proposal)
      || hostTaskStepPayloadDigest(JSON.stringify(body)) !== proposal.stepPayloadDigest)
        throw Error('paired_target_not_consumed')
      const controller = new AbortController(), owned = AbortSignal.any([this.lifetime, lease.signal, controller.signal])
      const unaryAbort = () => { controller.abort(signal.reason) }
      signal.addEventListener('abort', unaryAbort, { once: true })
      stopUnary = () => { signal.removeEventListener('abort', unaryAbort) }
      if (signal.aborted) unaryAbort()
      const current = () => {
        owned.throwIfAborted(); lease.assertCurrent()
        if (this.closing || this.ctx.get('pairedTaskTargetConsumerHost') !== host || this.ctx.agents.get(agent.id) !== agent
        || this.ctx.sessions.get(agent.id) !== session || agent.session !== session || agent.id !== proposal.target.sessionId)
          throw Error('paired_target_consumer_changed')
      }
      current()
      if (this.active.has(agent.id) || !idle(agent))
        throw Error('paired_target_consumer_busy')
      const active: ActiveInput = { lease, journal, controller, current, read: handle.readerFor(session),
        message: undefined, expectedDigest: undefined,
        accept(record) { current(); stopUnary(); accept(record) } }
      this.active.set(agent.id, active); reserved = true
      const cancel = () =>{  agent.cancel({ kind: 'parent' }, { keepInbox: true }) }
      owned.addEventListener('abort', cancel, { once: true })
      try {
        const snapshot = await this.ctx.agentLoop.readOriginalInvocationEntrySession(agent)
        current()
        if (!snapshot || snapshot.session !== session || !snapshot.isCurrent()
        || snapshot.logOffset !== proposal.target.prefixEventCount || snapshot.prefixLogDigest !== proposal.target.prefixLogDigest)
          throw Error('paired_target_session_changed')
        await lease.prepare(owned); current()
        const start = await journal.startIntent(admission.itemId, owned)
        current()
        if (!start.first) return start.record
        await lease.starting(owned); current()
        if (!idle(agent) || !snapshot.isCurrent())
          throw Error('paired_target_session_changed')
        const message: UserMessage = Object.freeze({ id: brandString<UserMessage['id']>('paired-step:' + admission.admissionId), role: 'user',
          content: Object.freeze([Object.freeze({ type: 'text' as const, text: body.text })]),
          source: Object.freeze({ kind: 'slark-task-target-step', commandId: proposal.target.commandId,
            admissionId: admission.admissionId, invocationId: proposal.originalStep.invocationId,
            executionKey: proposal.originalStep.executionKey, stepPayloadDigest: proposal.stepPayloadDigest }) })
        active.message = message
        active.expectedDigest = pairedTaskTargetMessageDigest(message)
        woke = true
        agent.send(message, 'next-step', true)
        await agent.whenIdle()
        if (!await this.ctx.sessions.flush(session)) throw Error('paired_target_terminal_not_durable')
        current()
        if (journal.admission(admission.itemId)?.state !== 'claimed') throw Error('paired_target_input_not_claimed')
        await lease.settling(owned)
        return journal.admission(admission.itemId) ?? start.record
      } finally {
        if (woke && !idle(agent)) { cancel(); await agent.whenIdle() }
        if (active.message) {
          agent.inbox.remove(active.message.id)
          if ([...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.id === active.message?.id)
            || !await this.ctx.sessions.flush(session)) throw Error('paired_target_cleanup_unconfirmed')
        }
        locallyDrained = true
        owned.removeEventListener('abort', cancel)
      }
    } finally {
      stopUnary()
      await lease.finished()
      if (reserved && locallyDrained) this.active.delete(agent.id)
    }
  }

  /** Abort original owned inputs and await their actual cleanup before the journal can close.
   * @returns Completion only after all accepted consumer intervals finish.
   */
  async close(): Promise<void> {
    this.closing = true
    for (const { lease, controller } of this.active.values()) {
      controller.abort(Error('paired_target_consumer_closed')); lease.agent.cancel({ kind: 'parent' }, { keepInbox: true })
    }
    await Promise.allSettled([...this.operations])
    if (this.active.size) throw Error('paired_target_cleanup_unconfirmed')
    for (const dispose of this.listeners.splice(0)) dispose()
    if (this.setup) {
      const initialized = await this.setup.then(handle => handle, () => undefined)
      await initialized?.dispose()
    }
  }
}
