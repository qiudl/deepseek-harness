/** Root and paired-step restrictions on the existing native pipeline; these methods grant no execution permission. */
import type { CollaborationTaskDurableCut, CollaborationTaskExecutions } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolExecutor, ToolDefinition, ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import type { CollaborationTaskAssociation, CollaborationTaskClosedFloor, CollaborationTaskCoordinationJournal,
  CollaborationTaskNativeCall } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination-journal'
import { encodeCollaborationJournalJson } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-source-journal'
import { parseHostTaskReadyAdmissionDirective, parseHostTaskTargetStepBody, hostTaskStepPayloadDigest, parseHostTaskCoordinationInput,
  type HostTaskReadyAdmissionDirective, type HostTaskTargetStepBody, hostTaskCoordinationFloorDigest, type HostTaskCoordinationScope } from '@deepseek-ai/dsh-host-control-protocol'
import type { Session } from '@deepseek-ai/dsh-session'
import { PairedTaskTargetFiles } from './desktop-task-target-files.ts'

// oxlint-disable-next-line typescript/unbound-method -- Captured for identity comparison; invocation retains the actual instance receiver.
const FILES_ASSERT = PairedTaskTargetFiles.prototype.assertCurrent
// oxlint-disable-next-line typescript/unbound-method -- Captured for identity comparison; invocation retains the actual instance receiver.
const FILES_CAPTURE = PairedTaskTargetFiles.prototype.captureCurrent
// oxlint-disable-next-line typescript/unbound-method -- The retained implementation is called with its actual branded producer.
const FILES_CLOSE = PairedTaskTargetFiles.prototype.close
const digest = (purpose: string, value: unknown) => createHash('sha256').update(purpose + '\0')
  .update(encodeCollaborationJournalJson(value)).digest('hex')
type PairedCall = { callId: string
  name: string
  turn: number
  step: number
  argumentsDigest: string
  entered: boolean
  returned: boolean
  callDigest?: string
  resultDigest?: string }
type PairedBinding = {
  agent: Agent
  session: Session
  proposal: HostTaskReadyAdmissionDirective
  messageDigest: string
  files: PairedTaskTargetFiles
  definitions: readonly ToolDefinition[]
  executor: Readonly<ToolExecutor>
  signal: AbortSignal
  stop: AbortController
  current(): void
  readCurrent(): boolean
  operations: Set<Promise<ToolBatchResult>>
  calls: Map<string, PairedCall>
  toolSets: Set<object>
  phase: 'bound' | 'prepared' | 'started' | 'finished'
  unknown: boolean
  terminal?: { recordDigest: string
    isCurrent(): boolean }
}
type PairedNativeLease = Readonly<{
  prepare(signal: AbortSignal): Promise<void>
  starting(signal: AbortSignal): Promise<void>
  settling(signal: AbortSignal): Promise<void>
  finished(): Promise<void>
}>
const runtimeContext = (source: { readonly kind: string }) => source.kind === 'runtime-context'

/** Native adapter retaining original cancellation through awaited policy and a final synchronous body check. */
export class DesktopTaskCoordinationNative {
  private guardInstalled = false
  private readonly agents = new Set<Agent>()
  private readonly closed = new Set<string>()
  private readonly active = new Map<string, Set<AbortController>>()
  private readonly live = new Map<string, CollaborationTaskNativeCall>()
  private readonly durableCalls = new Map<string, { callSeq: number
    callDigest: string
    resultSeq: number
    resultDigest: string
    abortedBeforeDispatch: boolean }>()
  private readonly terminals = new Map<string, CollaborationTaskDurableCut>()
  private readonly decorations = new WeakMap<object, { current(): boolean; execute(input: ToolBatchInput): Promise<ToolBatchResult> }>()
  private readonly prepared = new WeakMap<object, string | null>()
  private readonly observing = new Map<string, () => boolean>()
  private readonly paired = new WeakMap<Agent, PairedBinding>()
  private readonly pairedLive = new Set<PairedBinding>()
  private readonly pairedFacts = new Map<string, { read(): { state: 'in_flight' | 'terminal_receipted' | 'unknown'
    recordDigest: string
    isCurrent(): boolean } }>()
  private readonly bindings = new WeakMap<object, { association: CollaborationTaskAssociation
    signal: AbortSignal
    provider: CollaborationTaskExecutions
    executor: Readonly<ToolExecutor>
    current(): boolean }>()

  constructor(private readonly ctx: Context, private readonly journal: CollaborationTaskCoordinationJournal) {
    ctx.on('task-coordination/consumer-prepare', ({ commandId, agent, signal }) => {
      signal.throwIfAborted()
      const association = journal.association(commandId)
      if (!association) { this.prepared.set(agent, null); return }
      this.assertOpen(association)
      if (!ctx.get('collaborationTaskExecutions')) throw Error('task_coordination_consumer_unavailable')
      this.decorate(ctx.tools.inspectExecutor(agent))
      this.prepared.set(agent, commandId)
      return true
    })
    ctx.on('task-coordination/consumer-start', ({ commandId, agent, signal }) => {
      const association = journal.association(commandId)
      const retained = this.bindings.get(agent)
      if (retained && (retained.association.commandId !== commandId || retained.signal !== signal))
        throw Error('task_coordination_consumer_conflict')
      // A late association cannot retroactively make an unobserved lifecycle complete.
      if (!association || this.prepared.get(agent) !== commandId) return
      signal.throwIfAborted(); this.assertOpen(association)
      const provider = ctx.get('collaborationTaskExecutions')
      if (!provider) throw Error('task_coordination_consumer_unavailable')
      const executor = ctx.tools.inspectExecutor(agent), decoration = this.decorations.get(executor)
      if (!decoration?.current()) throw Error('task_coordination_executor_changed')
      const current = () => this.ctx.fiber.state === FiberState.ACTIVE && decoration.current()
        && ctx.tools.inspectExecutor(agent) === executor
      this.agents.add(agent)
      this.bindings.set(agent, { association, signal, provider, executor, current })
      this.observing.set(commandId, () => current() && ctx.get('collaborationTaskExecutions') === provider)
      return true
    })
    ctx.on('task-coordination/consumer-settling', async ({ commandId, agent, signal }) => {
      const binding = this.bindings.get(agent)
      if (!binding || binding.association.commandId !== commandId) return
      if (binding.signal !== signal || !binding.current() || ctx.get('collaborationTaskExecutions') !== binding.provider) {
        this.observing.delete(commandId)
        throw Error('task_coordination_executor_changed')
      }
      const durable = await binding.provider.captureDurable?.(commandId, agent)
      if (!durable || !durable.isCurrent() || durable.state.end === null
        || !['completed', 'aborted', 'blocked', 'error', 'max-tokens'].includes(durable.state.end.kind)
        || !binding.current() || ctx.get('collaborationTaskExecutions') !== binding.provider)
        throw Error('task_coordination_terminal_not_durable')
      if (this.calls(commandId).some(call => call.state !== 'settled' || !this.durableCalls.has(call.itemId)))
        throw Error('task_coordination_result_not_durable')
      this.terminals.set(commandId, durable)
    })
    ctx.on('task-coordination/consumer-finished', ({ commandId, agent, signal }) => {
      const binding = this.bindings.get(agent)
      if (binding?.association.commandId === commandId && binding.signal === signal) {
        this.bindings.delete(agent); this.agents.delete(agent)
      }
      this.prepared.delete(agent)
    })
  }

  private decorate(executor: Readonly<ToolExecutor>): void {
    const existing = this.decorations.get(executor)
    if (existing) {
      if (!existing.current()) throw Error('task_coordination_executor_changed')
      return
    }
    // Only the actual known native implementation supports this final-body restriction.
    if (!(executor instanceof NativeToolExecutor) || Object.getPrototypeOf(executor) !== NativeToolExecutor.prototype
      || !Object.isExtensible(executor))
      throw Error('task_coordination_executor_unsupported')
    const descriptor = Object.getOwnPropertyDescriptor(executor, 'execute')
    if (descriptor && (!descriptor.configurable || !('value' in descriptor))) throw Error('task_coordination_executor_unsupported')
    if (executor.execute !== NativeToolExecutor.prototype.execute) throw Error('task_coordination_executor_unsupported')
    if (!this.guardInstalled) {
      this.ctx.tools.guard((exec) => {
        const paired = exec.agent && this.paired.get(exec.agent)
        if (paired) {
          try {
            paired.current()
            const definition = paired.definitions.find(tool => tool.name === exec.name)
            if (paired.phase === 'started' && exec.parent === undefined && exec.toolSet && paired.toolSets.has(exec.toolSet)
              && paired.calls.has(exec.callId)
              && definition && this.ctx.tools.get(exec.name, exec.agent) === definition) return undefined
          } catch { /* Unknown provider/current ownership is never a dispatch capability. */ }
          return 'paired_target_native_denied'
        }
        const binding = exec.agent && this.bindings.get(exec.agent)
        if (!binding) return undefined
        try {
          if (binding.current() && this.ctx.get('collaborationTaskExecutions') === binding.provider) return undefined
        } catch { /* An unloaded selection is a denial, never an ancestor fallback. */ }
        return 'task_coordination_executor_changed'
      })
      this.guardInstalled = true
    }
    const original = executor.execute.bind(executor)
    const execute = (input: ToolBatchInput) => this.execute(input, original)
    const current = () => Object.getOwnPropertyDescriptor(executor, 'execute')?.value === execute
    Object.defineProperty(executor, 'execute', { value: execute, writable: true, configurable: true })
    this.decorations.set(executor, { current, execute: original })
    this.ctx.effect(() => async () => {
      const agents = [...new Set([...this.agents, ...[...this.pairedLive].map(binding => binding.agent)])]
      for (const agent of agents) agent.cancel({ kind: 'parent' }, { keepInbox: true })
      for (const controllers of this.active.values()) for (const controller of controllers)
        controller.abort(Error('task_coordination_executor_disposed'))
      for (const binding of this.pairedLive) binding.stop.abort(Error('paired_target_native_disposed'))
      await Promise.allSettled([...this.pairedLive].flatMap(binding => [...binding.operations]))
      await Promise.all(agents.map(agent => agent.whenIdle()))
      if (current()) {
        if (descriptor) Object.defineProperty(executor, 'execute', descriptor)
        else Reflect.deleteProperty(executor, 'execute')
      }
    }, 'task-coordination: original native execution restriction')
  }

  /** Read whether the original lifecycle retained its exact selected observer through settlement.
   * @param commandId - Original admitted local command.
   * @returns False for unobserved or replaced selections; never grants execution permission.
   */
  observes(commandId: string): boolean {
    try { return this.observing.get(commandId)?.() ?? false } catch { return false }
  }

  /** Read exact persisted event references captured by the original execution-token owner.
   * @param itemId - Actual invocation item allocated by this observer.
   * @returns Original call/result references, or null when no durable pair was witnessed.
   */
  evidence(itemId: string): Readonly<{ callSeq: number
    callDigest: string
    resultSeq: number
    resultDigest: string
    abortedBeforeDispatch: boolean }> | null {
    return this.durableCalls.get(itemId) ?? null
  }

  /** Read actual terminal ownership without treating an empty inventory as proof.
   * @param commandIds - Full original local command set independently read from its journal.
   * @returns True only for same-worker terminal prefixes whose actual calls were all cancelled before dispatch.
   */
  quiescent(commandIds: readonly string[]): boolean {
    const calls = this.calls(commandIds)
    return commandIds.length > 0 && calls.length > 0 && commandIds.every(commandId => this.observes(commandId)
      && this.terminals.get(commandId)?.isCurrent() === true && calls.some(call => call.commandId === commandId))
      && calls.every(call => !call.bodyEntered && call.state === 'settled'
        && this.durableCalls.get(call.itemId)?.abortedBeforeDispatch === true)
  }

  /** Close the live latch before queueing durability; a failed write leaves this process denied.
   * @param value - Exact transfer metadata validated by the private authenticated handler.
   * @param signal - Original control request cancellation.
   * @returns Original permanent floor after persistence, without asserting quiescence.
   */
  closeFloor(value: CollaborationTaskClosedFloor, signal: AbortSignal): Promise<CollaborationTaskClosedFloor> {
    this.latchFloor(value)
    return this.journal.closeFloor(value, signal)
  }

  /** Close the Root synchronously before the stop handler's first asynchronous local recheck.
   * @param value - Authenticated original stop metadata; this operation creates no Ack or execution permission.
   */
  latchFloor(value: CollaborationTaskClosedFloor): void {
    this.journal.latchFloor(value)
    this.closed.add(value.floorDigest)
    for (const controller of this.active.get(value.floorDigest) ?? []) controller.abort(Error('task_coordination_closed'))
    for (const binding of this.pairedLive)
      if (binding.proposal.floorDigest === value.floorDigest &&
        this.#pairedFloorBlocks(value, binding.proposal))
        binding.stop.abort(Error('paired_target_native_closed'))
  }

  #pairedFloorBlocks(floor: CollaborationTaskClosedFloor, proposal: HostTaskReadyAdmissionDirective): boolean {
    const closed = BigInt(floor.acceptedCoordinationEpoch), admitted = BigInt(proposal.newCoordinationEpoch)
    if (closed !== admitted) return closed > admitted
    try {
      const retained = this.journal.request(floor.transferRequestId)
      if (!retained || !isDeepStrictEqual(retained, floor)) return true
      const original = parseHostTaskCoordinationInput(JSON.parse(retained.authorizationJson)), d = original.directive, scope = d.scope
      return original.command.operation !== 'fence' || original.command.transferRequestId !== proposal.transfer.requestId
        || original.command.payloadDigest !== proposal.transfer.payloadDigest || floor.transferRequestId !== proposal.transfer.requestId
        || floor.payloadDigest !== proposal.transfer.payloadDigest || floor.floorDigest !== proposal.floorDigest
        || floor.scopeDigest !== proposal.scopeDigest || d.floorDigest !== floor.floorDigest || d.scopeDigest !== floor.scopeDigest
        || d.issuer !== proposal.issuer || !isDeepStrictEqual(scope, proposal.scope) || !isDeepStrictEqual(d.peer, proposal.peer)
        || d.accountBindingId !== proposal.accountBindingId || d.accountBindingVersion !== proposal.accountBindingVersion
        || scope.acceptedCoordinationEpoch !== proposal.newCoordinationEpoch
        || floor.acceptedCoordinationEpoch !== scope.acceptedCoordinationEpoch
        || floor.authorityEnvironmentId !== scope.authorityEnvironmentId || floor.environmentKey !== scope.environmentKey
        || floor.ownerUserId !== scope.ownerUserId || floor.accountIssuer !== scope.accountIssuer
        || floor.accountSubject !== scope.accountSubject || floor.hostProfileId !== scope.hostProfileId
        || floor.workerId !== proposal.target.workerId
    } catch { return true }
  }

  /** Refuse old-epoch physical preparation after its actual floor has been latched.
   * @param scope - Original authenticated preparation scope.
   * @returns Nothing; this denial check grants no preparation or execution authority.
   */
  assertPairedPreparationOpen(scope: HostTaskCoordinationScope): void {
    const key = hostTaskCoordinationFloorDigest(scope), floor = this.journal.latchedFloor(key)
    if (this.journal.blocked(key) && !floor || floor && BigInt(floor.acceptedCoordinationEpoch) > BigInt(scope.expectedCoordinationEpoch))
      throw Error('paired_target_native_closed')
  }

  /** Refuse a new admission or claim outside the original protected accepted-epoch exception.
   * @param proposal - Original Source proposal already verified by the owning private factory.
   * @returns Nothing; the Source receipt and one-use lease are still required independently.
   */
  assertPairedAdmissionCurrent(proposal: HostTaskReadyAdmissionDirective): void {
    this.#assertPairedAdmissionCurrent(proposal)
  }

  #assertPairedAdmissionCurrent(proposal: HostTaskReadyAdmissionDirective): void {
    const floor = this.journal.latchedFloor(proposal.floorDigest)
    const candidates = floor ? this.journal.canonicalCandidates(floor.canonicalDigest, proposal.scope) : []
    if (this.journal.blocked(proposal.floorDigest) && !floor || floor && (this.#pairedFloorBlocks(floor, proposal)
      || candidates.some(candidate => candidate.floorDigest === proposal.floorDigest && this.#pairedFloorBlocks(candidate, proposal))))
      throw Error('paired_target_native_closed')
  }

  /** Read the actual durable floor closing a projection's old preparation epoch.
   * @param scope - Original retained projection scope, never a selected Session or new execution grant.
   * @returns Its original durable stop metadata, or undefined when durability or provenance is unknown.
   */
  readPairedClosedProjection(scope: HostTaskCoordinationScope): CollaborationTaskClosedFloor | undefined {
    try {
      const key = hostTaskCoordinationFloorDigest(scope), floor = this.journal.latchedFloor(key)
      if (!floor || BigInt(floor.acceptedCoordinationEpoch) <= BigInt(scope.expectedCoordinationEpoch)
        || !isDeepStrictEqual(this.journal.request(floor.transferRequestId), floor)) return undefined
      const original = parseHostTaskCoordinationInput(JSON.parse(floor.authorizationJson)), d = original.directive
      if (original.command.operation !== 'fence' || original.command.transferRequestId !== floor.transferRequestId
        || original.command.payloadDigest !== floor.payloadDigest || d.floorDigest !== key || d.scopeDigest !== floor.scopeDigest
        || d.scope.acceptedCoordinationEpoch !== floor.acceptedCoordinationEpoch
        || d.scope.authorityEnvironmentId !== floor.authorityEnvironmentId || d.scope.environmentKey !== floor.environmentKey
        || d.scope.ownerUserId !== floor.ownerUserId || d.scope.accountIssuer !== floor.accountIssuer
        || d.scope.accountSubject !== floor.accountSubject || d.scope.hostProfileId !== floor.hostProfileId) return undefined
      return floor
    } catch { return undefined }
  }

  /** Restrict one actual paired consumer to its original file producer; this does not admit or sign a Source step.
   * The matching durable floor closes its expected epoch; the private factory's same-transfer admission can use its accepted epoch.
   * @param input - Private factory's original Agent/Session, Source body, actual producer and owned long lifetime.
   * @returns Consumer lifecycle hooks; completion requires actual persisted input, calls, results and turn end.
   */
  bindPaired(input: { agent: Agent
    session: Session
    proposal: HostTaskReadyAdmissionDirective
    body: HostTaskTargetStepBody
    files: PairedTaskTargetFiles
    signal: AbortSignal
    current(this: void): void }): PairedNativeLease {
    const { agent, session, files, signal, current: ownerCurrent } = input
    const proposal = parseHostTaskReadyAdmissionDirective(input.proposal), body = input.body
    parseHostTaskTargetStepBody(JSON.stringify(body))
    if (hostTaskStepPayloadDigest(JSON.stringify(body)) !== proposal.stepPayloadDigest ||
      proposal.newSourceGrant.epoch !== proposal.newCoordinationEpoch || proposal.target.sessionId !== agent.id ||
      agent.session !== session || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== session ||
      this.bindings.has(agent) || this.paired.has(agent) || this.pairedFacts.has(proposal.newSourceGrant.admissionId) ||
      this.pairedFacts.size >= 10000) throw Error('paired_target_native_conflict')
    if (!(files instanceof PairedTaskTargetFiles) || Object.getPrototypeOf(files) !== PairedTaskTargetFiles.prototype ||
      files.assertCurrent !== FILES_ASSERT || files.captureCurrent !== FILES_CAPTURE || files.close !== FILES_CLOSE)
      throw Error('paired_target_native_provider_unsupported')
    const permissions = body.permissions, definitions = files.definitions
    if (!Object.isFrozen(definitions) || definitions.some(tool => !Object.isFrozen(tool)))
      throw Error('paired_target_native_provider_unsupported')
    files.assertCurrent(agent, permissions)
    const providerCurrent = files.captureCurrent(), executor = this.ctx.tools.inspectExecutor(agent)
    this.decorate(executor)
    const decoration = this.decorations.get(executor)
    if (!decoration) throw Error('paired_target_native_executor_changed')
    const stop = new AbortController(), owned = AbortSignal.any([signal, stop.signal])
    const readCurrent = () => this.ctx.fiber.state === FiberState.ACTIVE && this.ctx.agents.get(agent.id) === agent
      && this.ctx.sessions.get(agent.id) === session && agent.session === session && decoration.current()
      && this.ctx.tools.inspectExecutor(agent) === executor && providerCurrent()
      && files.assertCurrent === FILES_ASSERT && files.captureCurrent === FILES_CAPTURE && files.definitions === definitions
      && files.close === FILES_CLOSE
    const current = () => {
      owned.throwIfAborted(); ownerCurrent()
      this.#assertPairedAdmissionCurrent(proposal)
      if (!readCurrent()) throw Error('paired_target_native_changed')
      files.assertCurrent(agent, permissions)
      owned.throwIfAborted()
    }
    current()
    const message = { id: 'paired-step:' + proposal.newSourceGrant.admissionId, role: 'user',
      content: [{ type: 'text', text: body.text }], source: { kind: 'slark-task-target-step', commandId: proposal.target.commandId,
        admissionId: proposal.newSourceGrant.admissionId, invocationId: proposal.originalStep.invocationId,
        executionKey: proposal.originalStep.executionKey, stepPayloadDigest: proposal.stepPayloadDigest } }
    const binding: PairedBinding = { agent, session, proposal, messageDigest: digest('dsh.paired-native.input/v1', message), files,
      definitions, executor, signal: owned, stop, current, readCurrent, operations: new Set(), calls: new Map(),
      toolSets: new Set(), phase: 'bound', unknown: false }
    this.paired.set(agent, binding); this.pairedLive.add(binding)
    this.pairedFacts.set(proposal.newSourceGrant.admissionId, { read: () => {
      const terminal = binding.terminal, healthy = () => {
        try { return binding.readCurrent() && !binding.unknown && (binding.phase !== 'finished' || !!terminal)
          && (!terminal || terminal.isCurrent()) } catch { return false }
      }
      return Object.freeze({ state: !healthy() || binding.phase === 'finished' && !terminal ? 'unknown'
        : terminal ? 'terminal_receipted' : 'in_flight',
      recordDigest: terminal?.recordDigest ?? digest('dsh.paired-native.live/v1', [proposal.newSourceGrant.admissionId,
        binding.phase, [...binding.calls.values()]]), isCurrent: healthy })
    } })
    let closing: Promise<void> | undefined
    return Object.freeze({
      prepare: async (requestSignal: AbortSignal) => {
        requestSignal.throwIfAborted(); current()
        if (binding.phase !== 'bound') throw Error('paired_target_native_lifecycle')
        const snapshot = await this.ctx.agentLoop.readOriginalInvocationEntrySession(agent)
        requestSignal.throwIfAborted(); current()
        if (!snapshot?.isCurrent() || snapshot.session !== session || snapshot.logOffset !== proposal.target.prefixEventCount ||
          snapshot.prefixLogDigest !== proposal.target.prefixLogDigest) throw Error('paired_target_native_prefix_changed')
        binding.phase = 'prepared'
      },
      starting: async (requestSignal: AbortSignal) => {
        await Promise.resolve()
        requestSignal.throwIfAborted(); current()
        if (binding.phase !== 'prepared') throw Error('paired_target_native_lifecycle')
        binding.phase = 'started'
      },
      settling: async (requestSignal: AbortSignal) => {
        requestSignal.throwIfAborted(); current()
        if (binding.phase !== 'started' || binding.operations.size) throw Error('paired_target_native_not_settled')
        binding.terminal = await this.capturePaired(binding, true)
      },
      finished: () => {
        if (closing) return closing
        closing = (async () => {
          // Publish the single cleanup Promise before synchronous abort listeners can reenter finished().
          await Promise.resolve()
          await Promise.allSettled([...binding.operations])
          // Cleanup observes persisted historical facts even after cancellation, never a renewed execution permission.
          if (binding.phase === 'started' && !binding.terminal) {
            try { binding.terminal = await this.capturePaired(binding, true) } catch { binding.unknown = true }
          }
          await FILES_CLOSE.call(files)
          binding.phase = 'finished'; binding.calls.clear()
          this.paired.delete(agent); this.pairedLive.delete(binding)
        })()
        stop.abort(Error('paired_target_native_finished'))
        return closing
      },
    })
  }

  /** Read this writer's actual paired IO and persisted terminal evidence without authorizing another call.
   * @param admissionId - Original Source admission retained by this actual binding.
   * @returns Bounded body-free historical evidence, or null for an unobserved admission.
   */
  pairedEvidence(admissionId: string): Readonly<{ state: 'in_flight' | 'terminal_receipted' | 'unknown'
    recordDigest: string
    isCurrent(): boolean }> | null {
    return this.pairedFacts.get(admissionId)?.read() ?? null
  }

  private async capturePaired(binding: PairedBinding, terminal: boolean): Promise<{ recordDigest: string
    isCurrent(): boolean }> {
    const { agent, session, proposal } = binding, persistence = this.ctx.get('sessionPersistence')
    if (!persistence || !binding.readCurrent() || !await this.ctx.sessions.flush(session)) throw Error('paired_target_native_not_durable')
    const witness = await this.ctx.agentLoop.readOriginalInvocationEntrySession(agent)
    if (!witness?.isCurrent() || !witness.prefixLogDigest || witness.logOffset <= proposal.target.prefixEventCount ||
      witness.logOffset - proposal.target.prefixEventCount > 100000) throw Error('paired_target_native_not_durable')
    const current = () => binding.readCurrent() && this.ctx.get('sessionPersistence')?.identity === persistence.identity && witness.isCurrent()
    const handle = await persistence.open(agent.id, 'read')
    let turn: number | undefined, inputSeen = false, ended = false, endDigest: string | undefined, count = 0
    const seen = new Map<string, { call: string; result?: string }>()
    try {
      if (proposal.target.prefixEventCount < handle.inheritedEventCount) throw Error('paired_target_native_inherited')
      for (let offset = proposal.target.prefixEventCount; offset < witness.logOffset;) {
        const page = await handle.read(offset, Math.min(64, witness.logOffset - offset))
        if (!page.events.length) throw Error('paired_target_native_missing_events')
        for (const event of page.events) {
          if (event.seq !== offset++ || ended) throw Error('paired_target_native_ambiguous_events')
          if (event.type === 'turn/start') {
            if (turn !== undefined) throw Error('paired_target_native_ambiguous_turn')
            turn = event.data.turn
          } else if (event.type === 'user/message' && !runtimeContext(event.data.source)) {
            if (inputSeen || turn === undefined || digest('dsh.paired-native.input/v1', event.data) !== binding.messageDigest)
              throw Error('paired_target_native_foreign_input')
            inputSeen = true
          } else if (event.type === 'tool/call') {
            const call = binding.calls.get(event.data.callId)
            if (!inputSeen || !call || call.turn !== turn || event.data.turn !== turn || call.step !== event.data.step ||
              call.name !== event.data.name || call.argumentsDigest !== digest('dsh.paired-native.arguments/v1', JSON.parse(event.data.arguments)) ||
              seen.has(call.callId) || ++count > 10000) throw Error('paired_target_native_untracked_call')
            seen.set(call.callId, { call: digest('dsh.task-coordination.session-event/v1', event) })
          } else if (event.type === 'tool/result') {
            const call = binding.calls.get(event.data.message.toolCallId), pair = call && seen.get(call.callId)
            if (!call || !pair || pair.result || event.data.turn !== call.turn || event.data.step !== call.step ||
              event.data.message.source.callId !== call.callId) throw Error('paired_target_native_untracked_result')
            pair.result = digest('dsh.task-coordination.session-event/v1', event)
          } else if (event.type === 'turn/end') {
            if (!inputSeen || event.data.turn !== turn || !['completed', 'aborted', 'blocked', 'error', 'max-tokens'].includes(event.data.reason.kind))
              throw Error('paired_target_native_unknown_terminal')
            ended = true; endDigest = digest('dsh.task-coordination.session-event/v1', event)
          }
        }
      }
    } finally { await handle.close() }
    if (!inputSeen || !current() || binding.unknown || terminal && (!ended || binding.operations.size ||
      seen.size !== binding.calls.size || [...binding.calls.values()].some(call => call.entered && !call.returned ||
        !seen.get(call.callId)?.result)))
      throw Error('paired_target_native_not_settled')
    for (const [id, pair] of seen) {
      const call = binding.calls.get(id)
      if (call) {
        call.callDigest = pair.call
        if (pair.result) call.resultDigest = pair.result
      }
    }
    return Object.freeze({ recordDigest: digest('dsh.paired-native.receipt/v1', [proposal.newSourceGrant.admissionId,
      witness.instanceGeneration, witness.logOffset, witness.prefixLogDigest, endDigest ?? null, [...binding.calls.values()]]),
    isCurrent: current })
  }

  private async executePaired(binding: PairedBinding, input: ToolBatchInput,
    delegate: (input: ToolBatchInput) => Promise<ToolBatchResult>): Promise<ToolBatchResult> {
    binding.current()
    const log = input.log
    if (binding.phase !== 'started' || !log || input.agent !== binding.agent || binding.calls.size + input.calls.length > 10000 ||
      input.calls.some(call => Buffer.byteLength(call.id, 'utf8') > 256 || Buffer.byteLength(call.name, 'utf8') > 256) ||
      input.calls.some(call => binding.calls.has(call.id)) || new Set(input.calls.map(call => call.id)).size !== input.calls.length)
      throw Error('paired_target_native_untracked_batch')
    for (const call of input.calls) binding.calls.set(call.id, { callId: call.id, name: call.name, turn: log.turn, step: log.step,
      argumentsDigest: digest('dsh.paired-native.arguments/v1', JSON.parse(call.arguments)), entered: false, returned: false })
    const signal = AbortSignal.any([input.signal, binding.signal])
    const toolSet = { dispose() {}, view: (scope: Parameters<Context['tools']['definitions']>[0]) => {
      if (scope !== binding.agent) throw Error('paired_target_native_foreign_scope')
      const admitted = input.toolSet?.view(scope)
      return new Map(binding.definitions.flatMap((tool) => {
        if (this.ctx.tools.get(tool.name, scope) !== tool || admitted && admitted.get(tool.name) !== tool) return []
        const wrapped: ToolDefinition = { ...tool, execute: async (args, exec) => {
          const call = binding.calls.get(exec.callId)
          if (!call || call.entered || exec.parent !== undefined || exec.agent !== binding.agent || exec.name !== tool.name ||
            digest('dsh.paired-native.arguments/v1', args) !== call.argumentsDigest)
            throw Error('paired_target_native_untracked_body')
          // The actual Native call has already been appended; flush and independently read it before the last synchronous fence.
          await this.capturePaired(binding, false)
          binding.current(); signal.throwIfAborted(); exec.signal.throwIfAborted()
          if (this.ctx.tools.get(tool.name, binding.agent) !== tool) throw Error('paired_target_native_definition_changed')
          call.entered = true
          try { return await tool.execute(args, exec) } finally { call.returned = true }
        } }
        return [[tool.name, wrapped] as const]
      }))
    } }
    binding.toolSets.add(toolSet)
    try {
      const result = await delegate({ ...input, signal, toolSet, maxParallelToolCalls: 1 })
      await this.capturePaired(binding, false)
      return result
    } catch (error) { binding.unknown = true; throw error }
    finally { binding.toolSets.delete(toolSet) }
  }

  private async execute(input: ToolBatchInput, delegate: (input: ToolBatchInput) => Promise<ToolBatchResult>): Promise<ToolBatchResult> {
    const paired = input.agent && this.paired.get(input.agent)
    if (paired) {
      const operation = this.executePaired(paired, input, delegate)
      paired.operations.add(operation)
      try { return await operation } finally { paired.operations.delete(operation) }
    }
    const agent = input.agent, log = input.log, binding = agent && this.bindings.get(agent)
    if (!binding) return delegate(input)
    if (this.ctx.fiber.state !== FiberState.ACTIVE) throw Error('task_coordination_executor_disposed')
    const provider = this.ctx.get('collaborationTaskExecutions'), view = log ? provider?.read(agent.id, log.turn) : null
    const association = binding.association
    if (!log || !view || !provider || association.sessionId !== agent.id
      || view.commandId !== association.commandId || binding.provider !== provider || binding.signal !== view.signal)
      throw Error('task_coordination_unassociated')
    const current = () => {
      this.assertOpen(association)
      binding.signal.throwIfAborted()
      if (!binding.current() || this.bindings.get(agent) !== binding) throw Error('task_coordination_consumer_changed')
      if (this.ctx.get('collaborationTaskExecutions') !== provider || provider.read(agent.id, log.turn) !== view)
        throw Error('task_coordination_consumer_changed')
      view.signal.throwIfAborted()
    }
    current()
    if (new Set(input.calls.map(call => call.id)).size !== input.calls.length) throw Error('task_coordination_call_conflict')
    const controller = new AbortController(), controllers = this.active.get(association.floorDigest) ?? new Set<AbortController>()
    controllers.add(controller); this.active.set(association.floorDigest, controllers)
    const originalSignal = AbortSignal.any([input.signal, controller.signal, view.signal]), records = new Map<string,
      CollaborationTaskNativeCall>()
    const update = async (entry: CollaborationTaskNativeCall) => {
      this.live.set(entry.itemId, entry); records.set(entry.callId, entry)
      await this.journal.recordCall(entry)
    }
    const removeDispatchObserver = this.ctx.on('tools/execute', async (exec, next) => {
      const entry = exec.agent === agent ? records.get(exec.callId) : undefined
      if (entry && exec.parent === undefined) {
        await update({ ...entry, state: 'prepared' })
        await update({ ...entry, state: 'dispatch_wait' })
      }
      return next()
    }, { prepend: true })
    try {
      for (const call of input.calls) {
        const entry: CollaborationTaskNativeCall = { itemId: randomUUID(), commandId: association.commandId,
          invocationId: association.invocationId, sessionId: association.sessionId, turn: log.turn,
          step: log.step, callId: call.id, state: 'queued', bodyEntered: false }
        await update(entry)
      }
      current(); originalSignal.throwIfAborted()
      const wrap = (tool: ToolDefinition): ToolDefinition => {
        const wrapped: ToolDefinition = { ...tool, execute: async (args, exec) => {
          const entry = records.get(exec.callId)
          if (!entry) throw Error('task_coordination_call_untracked')
          // Durable intent precedes the final check. A crash after this write is unknown, never replayable.
          await update({ ...entry, state: 'dispatch_wait' })
          current(); originalSignal.throwIfAborted(); exec.signal.throwIfAborted()
          const entered = { ...entry, state: 'body_entered' as const, bodyEntered: true }
          this.live.set(entry.itemId, entered); records.set(entry.callId, entered)
          // No await separates the closed-floor check, actual body marker, and provider invocation.
          try { return await tool.execute(args, exec) }
          finally { await update({ ...entered, state: 'returned_not_durable' }) }
        } }
        return new Proxy(wrapped, { get(target, key): unknown {
          if (key === 'execute') return target.execute.bind(target)
          const value: unknown = Reflect.get(tool, key, tool)
          return typeof value === 'function' ? value.bind(tool) : value
        } })
      }
      const toolSet = { dispose: () => {}, view: (scope: Parameters<Context['tools']['definitions']>[0]) => {
        const admitted = input.toolSet?.view(scope)
          ?? new Map(this.ctx.tools.definitions(scope).flatMap((tool) => {
            const executable = this.ctx.tools.executable(tool.name, scope)
            return executable ? [[tool.name, executable] as const] : []
          }))
        return new Map([...admitted].map(([name, tool]) => [name, wrap(tool)]))
      } }
      const restricted = { ...input, signal: originalSignal, toolSet }
      const result = await delegate(restricted)
      // Root result events are memory-visible before the public persistence barrier completes.
      if (!await this.ctx.sessions.flush(agent.session)) throw Error('task_coordination_result_not_durable')
      const durable = await binding.provider.captureDurable?.(view.commandId, agent)
      if (!durable || !durable.isCurrent() || durable.turn !== log.turn || durable.state.step !== log.step
        || !binding.current() || this.ctx.get('collaborationTaskExecutions') !== binding.provider) return result
      for (const entry of records.values()) {
        const pair = durable.state.pairs.find(pair => pair.callId === entry.callId)
        if (!pair || pair.resultSeq === null || pair.resultDigest === null) return result
        this.durableCalls.set(entry.itemId, { callSeq: pair.callSeq, callDigest: pair.callDigest,
          resultSeq: pair.resultSeq, resultDigest: pair.resultDigest, abortedBeforeDispatch: pair.abortedBeforeDispatch })
        await update({ ...entry, state: 'settled' })
      }
      return result
    } finally {
      removeDispatchObserver()
      controllers.delete(controller)
      if (!controllers.size) this.active.delete(association.floorDigest)
    }
  }

  /** List the retained metadata for this owner's actual native calls.
   * @param commandId - Original command or verified Root command set whose live invocations are observed.
   * @returns Actual live state overlaid on durable metadata; no completed work is replayed.
   */
  calls(commandId: string | readonly string[]): readonly CollaborationTaskNativeCall[] {
    return this.journal.calls(commandId).map(entry => this.live.get(entry.itemId) ?? entry)
  }

  private assertOpen(association: CollaborationTaskAssociation): void {
    if (this.closed.has(association.floorDigest) || this.journal.blocked(association.floorDigest)) throw Error('task_coordination_closed')
  }
}
