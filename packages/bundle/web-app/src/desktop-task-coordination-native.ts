/** Root-scoped restrictions on the existing native pipeline; these methods grant no execution permission. */
import type { CollaborationTaskDurableCut, CollaborationTaskExecutions } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { randomUUID } from 'node:crypto'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolExecutor, ToolDefinition, ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import type { CollaborationTaskAssociation, CollaborationTaskClosedFloor, CollaborationTaskCoordinationJournal,
  CollaborationTaskNativeCall } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination-journal'

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
      const agents = [...this.agents]
      for (const agent of agents) agent.cancel({ kind: 'parent' }, { keepInbox: true })
      for (const controllers of this.active.values()) for (const controller of controllers)
        controller.abort(Error('task_coordination_executor_disposed'))
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
  }

  private async execute(input: ToolBatchInput, delegate: (input: ToolBatchInput) => Promise<ToolBatchResult>): Promise<ToolBatchResult> {
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
