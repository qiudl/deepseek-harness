/** REQ-20261031-0006 / Task26691: actual Loader/native race, controlled model/input and denial fixture. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CollaborationExecutionCommandId } from '@deepseek-ai/dsh-api-session-controller'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openCollaborationTaskCoordinationJournal } from '@deepseek-ai/dsh-api-session-controller/host/collaboration-task-coordination-journal'
import { taskFixture } from '../../../host/desktop-host/tests/task-coordination.test-support.ts'
import { DesktopTaskCoordinationNative } from '../src/desktop-task-coordination-native.ts'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'

function barrier() {
  let release: () => void = () => { throw Error('barrier not initialized') }
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
class OneNativeCall extends LlmAdapter {
  private readonly requested = new Set<string>()
  toolName = 'perform_step'
  constructor(private readonly parallel = false) { super() }
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.streamFor(model, options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { yield* this.streamFor(options.model, options) }
  private async *streamFor(model: string, _options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.requested.has(model)) {
      this.requested.add(model)
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('native-' + model),
        name: this.toolName, arguments: '{}' } }
      if (this.parallel && model === 'root-a') yield { type: 'block-end', index: 1, block: { type: 'tool-call',
        id: ToolCallId('native-second-' + model), name: 'perform_step', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each(['floor', 'account', 'provider_replaced', 'provider_absent', 'composition_unsupported',
  'composition_native', 'executor_replaced', 'executor_disposed', 'executor_frozen', 'executor_accessor', 'executor_nonconfigurable', 'executor_custom',
  'executor_owned', 'executor_changed_prestart', 'provider_removed_prestart', 'executor_overwritten', 'executor_removed', 'binding_conflict', 'early_finish', 'flush_denied', 'tampered_call_id', 'unknown_tool', 'parallel', 'allowed'] as const)('closes an already-prepared call at %s before its body despite an awaited wrapper replacing its signal', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'req0006-task-drain-loader-')), cwd = await realpath(root)
  const ctx = new Context(), entered = barrier(), release = barrier(), dispatched = barrier()
  const bodies = new Map<string, number>(), prepared = new Set<string>()
  let nativeSignal: AbortSignal | undefined
  // Controlled associations exercise restriction metadata, not Cloud authorization grants.
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(join(root, 'coordination'))
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const journal = await openCollaborationTaskCoordinationJournal(facility)
  const agents: { whenIdle(): Promise<void> }[] = []
  onTestFinished(async () => {
    release.release()
    vi.restoreAllMocks()
    await Promise.allSettled(agents.map(agent => agent.whenIdle()))
    await journal.close()
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const plugins = { sessions: SessionStore, projections: SessionProjectionRegistry, persistence: Persistence, agents: AgentRegistry,
    llm: LlmRuntime,
    prompt: SystemPrompt, tools: Tools, executor: { apply: (mount: Context) => { mount.tools.setExecutor(new NativeToolExecutor(mount)) },
      inject: ['tools'] }, loop: AgentLoop }
  await writeFile(join(root, 'cordis.yml'), JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `task-drain:${id}`,
    config: id === 'persistence' ? { root: join(root, 'sessions'), compression: 'none' } : {} }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('missing actual Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key): unknown {
    if (key === 'import') return async (specifier: string) => {
      const plugin = plugins[specifier.slice('task-drain:'.length) as keyof typeof plugins]
      if (!plugin) throw Error('unknown task-drain fixture plugin')
      return typeof plugin === 'function' ? { default: plugin } : plugin
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const contribution: { native?: DesktopTaskCoordinationNative } = {}
  const coordinationOwner = await ctx.plugin({ name: 'task-coordination-restrictions', inject: ['tools', 'sessions'],
    apply: (owner: Context) => { contribution.native = new DesktopTaskCoordinationNative(owner, journal) },
  })
  const native = contribution.native
  if (!native) throw Error('missing actual native restriction owner')
  const model = new OneNativeCall(mode === 'parallel')
  ctx.llm.registerAdapter(['fixture'], model)
  class InheritedTool implements ToolDefinition {
    readonly #name = 'perform_step'
    get name(): string { return this.#name }
    get description(): string { return 'Perform the isolated test step' }
    get parameters(): ToolDefinition['parameters'] { return {} }
    get output(): ToolDefinition['output'] {
      return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }] }
    }
    finalizeContent(_exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>): undefined {
      if (this.#name !== 'perform_step') throw Error('lost original tool receiver')
      return undefined
    }
    async execute(_args: unknown, exec: ToolRunContext): Promise<string> {
      if (!exec.agent) throw Error('actual Agent required')
      exec.toolSet?.dispose()
      const id = exec.agent.id
      bodies.set(id, (bodies.get(id) ?? 0) + 1)
      return 'recorded isolated effect'
    }
  }
  ctx.effect(() => ctx.tools.register(new InheritedTool()))
  ctx.tools.register({ name: 'conditional_step', description: 'Not admitted outside a step', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] },
    execute: () => { throw Error('conditional registration must stay unavailable') } }, { when: () => false })
  if (mode === 'unknown_tool') model.toolName = 'unoffered_tool'
  await journal.associate({ floorDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), commandId: 'original-command',
    invocationId: 'original-invocation', sessionId: 'root-a', commandDigest: 'c'.repeat(64), coordinationEpoch: '1' },
  new AbortController().signal)
  let currentSignal = new AbortController().signal
  const parent = mode === 'account' ? await taskFixture() : undefined
  let view = Object.freeze({ commandId: brandString<CollaborationExecutionCommandId>('original-command'),
    sessionId: SessionId('root-a'), turn: 1, signal: currentSignal })
  const reader = { read: (sessionId: SessionId, turn: number) => sessionId === view.sessionId && turn === view.turn ? view : null }
  const removeReader = ctx.provide('collaborationTaskExecutions', reader)
  ctx.tools.guard((exec) => {
    if (exec.agent) prepared.add(exec.agent.id)
    return undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent?.id === 'root-a') {
      nativeSignal = exec.signal
      entered.release()
      await release.promise
      exec.signal = new AbortController().signal
      if (mode === 'tampered_call_id') expect(Reflect.set(exec, 'callId', ToolCallId('foreign-call'))).toBe(true)
    }
    return next()
  })
  const a = await ctx.agentLoop.create(SessionId('root-a'), { provider: 'fixture', model: 'root-a' }, { cwd })
  const b = await ctx.agentLoop.create(SessionId('root-b'), { provider: 'fixture', model: 'root-b' }, { cwd })
  agents.push(a, b)
  if (mode === 'allowed') {
    // Ordinary service/tool calls retain their original non-Root path, including executor-owned parallel defaults.
    const standalone = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('standalone'),
      name: 'perform_step', arguments: '{}' }], signal: new AbortController().signal })
    expect(standalone.results).toHaveLength(1)
    await ctx.tools.execute({ agent: a, calls: [], signal: new AbortController().signal })
    await ctx.tools.execute({ agent: a, log: { turn: 1, step: 0 }, calls: [], signal: currentSignal })
    expect(bodies.size).toBe(0)
  }
  const configurationReads = { count: 0 }
  const special = new NativeToolExecutor(a.ctx, () => { configurationReads.count++; return 1 })
  let removeSelected: (() => void) | undefined
  if (['executor_frozen', 'executor_accessor', 'executor_nonconfigurable', 'executor_custom', 'executor_owned', 'executor_removed'].includes(mode)) {
    if (mode === 'executor_frozen') Object.preventExtensions(special)
    if (mode === 'executor_accessor') Object.defineProperty(special, 'execute', { configurable: true,
      get: () => { throw Error('accessor must not be invoked') } })
    if (mode === 'executor_nonconfigurable' || mode === 'executor_owned') Object.defineProperty(special, 'execute', {
      value: Object.getOwnPropertyDescriptor(NativeToolExecutor.prototype, 'execute')?.value,
      configurable: mode === 'executor_owned', writable: true })
    if (mode === 'executor_custom') special.execute = async () => { throw Error('custom implementation must not run') }
    removeSelected = a.ctx.tools.setExecutor(special)
  }
  const startIdentity = { commandId: view.commandId, agent: a, signal: currentSignal }
  await ctx.serial('task-coordination/consumer-settling', startIdentity)
  if (['executor_frozen', 'executor_accessor', 'executor_nonconfigurable', 'executor_custom'].includes(mode)) {
    await expect(ctx.serial('task-coordination/consumer-prepare', startIdentity)).rejects.toThrow('executor_unsupported')
    return
  }
  if (mode === 'provider_absent') {
    removeReader()
    await expect(ctx.serial('task-coordination/consumer-prepare', startIdentity)).rejects.toThrow('consumer_unavailable')
    expect(bodies.size).toBe(0)
    return
  }
  if (mode === 'composition_unsupported' || mode === 'composition_native') {
    a.ctx.tools.setExecutor(mode === 'composition_native' ? new NativeToolExecutor(a.ctx) : {
      describe: () => ({ schemas: [] }), execute: async () => { throw Error('unsupported executor invoked') },
    })
    if (mode === 'composition_unsupported') {
      await expect(ctx.serial('task-coordination/consumer-prepare', startIdentity)).rejects.toThrow('executor_unsupported')
      expect(bodies.size).toBe(0)
      return
    }
  }
  await ctx.serial('task-coordination/consumer-prepare', startIdentity)
  await ctx.serial('task-coordination/consumer-prepare', startIdentity)
  const selected = ctx.tools.inspectExecutor(a)
  const retainedExecute = selected.execute.bind(selected)
  if (mode === 'executor_changed_prestart') {
    a.ctx.tools.setExecutor(new NativeToolExecutor(a.ctx))
    await expect(ctx.serial('task-coordination/consumer-start', startIdentity)).rejects.toThrow('executor_changed')
    return
  }
  if (mode === 'provider_removed_prestart') {
    removeReader()
    await expect(ctx.serial('task-coordination/consumer-start', startIdentity)).rejects.toThrow('consumer_unavailable')
    return
  }
  if (mode === 'executor_overwritten') {
    const replacement = new NativeToolExecutor(a.ctx), execute = replacement.execute.bind(replacement)
    Object.defineProperty(selected, 'execute', { value: execute, configurable: true })
    await expect(ctx.serial('task-coordination/consumer-prepare', startIdentity)).rejects.toThrow('executor_changed')
    await coordinationOwner.dispose()
    expect(Object.getOwnPropertyDescriptor(selected, 'execute')?.value).toBe(execute)
    return
  }
  if (mode === 'allowed') {
    const other = brandString<CollaborationExecutionCommandId>('second-original-command')
    await journal.associate({ ...journal.association(view.commandId)!, commandId: other, sessionId: b.id,
      floorDigest: 'd'.repeat(64) }, new AbortController().signal)
    b.ctx.tools.setExecutor(new NativeToolExecutor(b.ctx))
    await ctx.serial('task-coordination/consumer-prepare', { commandId: other, agent: b, signal: currentSignal })
  }
  if (mode === 'binding_conflict') {
    await ctx.serial('task-coordination/consumer-start', startIdentity)
    await expect(ctx.serial('task-coordination/consumer-start', { ...startIdentity, signal: new AbortController().signal }))
      .rejects.toThrow('consumer_conflict')
    const otherCommand = brandString<CollaborationExecutionCommandId>('another-original-command')
    await journal.associate({ ...journal.association(view.commandId)!, commandId: otherCommand }, new AbortController().signal)
    await expect(ctx.serial('task-coordination/consumer-start', { ...startIdentity, commandId: otherCommand }))
      .rejects.toThrow('consumer_conflict')
    // An unrelated old completion cannot discard the original request's retained restriction.
    await ctx.serial('task-coordination/consumer-finished', { ...startIdentity, signal: new AbortController().signal })
  }
  const allowed = mode === 'flush_denied' || mode === 'allowed' || mode === 'composition_native' || mode === 'binding_conflict' || mode === 'parallel' || mode === 'executor_owned'
  const start = async () => {
    await ctx.serial('task-coordination/consumer-start', { commandId: view.commandId, agent: a, signal: currentSignal })
    a.followup(createUserMessage({ content: [{ type: 'text', text: 'start original root A' }], source: { kind: 'user' } }))
    dispatched.release()
    await a.whenIdle()
    if (mode === 'binding_conflict' || mode === 'executor_owned') {
      const outsideAdmission = await ctx.tools.execute({ agent: a, log: { turn: 1, step: 0 }, signal: currentSignal,
        calls: [{ type: 'tool-call', id: ToolCallId('conditional-outside-admission'), name: 'conditional_step', arguments: '{}' }] })
      expect(outsideAdmission.results[0]?.result.isError).toBe(true)
    }
    await ctx.serial('task-coordination/consumer-finished', { commandId: view.commandId, agent: a, signal: currentSignal })
  }
  if (mode === 'unknown_tool') release.release()
  const originalRequest = parent ? parent.host.withCollaborationAccountRequest({ ...parent.account, ownerId: parent.ownerId },
    currentSignal, async (_profile, signal) => {
      currentSignal = signal
      view = Object.freeze({ ...view, signal })
      await start()
    }) : start()
  const requestOutcome = originalRequest.then(() => null, (error: unknown) => error)
  await Promise.race([dispatched.promise, requestOutcome.then((outcome) => { throw Error('consumer did not dispatch: ' + JSON.stringify(outcome)) })])
  if (mode === 'unknown_tool') {
    expect(await requestOutcome).toBeNull()
    expect(bodies.size).toBe(0)
    return
  }
  await Promise.race([entered.promise, a.whenIdle().then(() => {
    throw Error('original Agent stopped before wrapper: ' + JSON.stringify(a.session.snapshotEvents()))
  })])
  expect(prepared.has('root-a')).toBe(true)
  if (mode === 'binding_conflict') {
    await expect(ctx.tools.execute({ agent: a, calls: [], signal: currentSignal })).rejects.toThrow('unassociated')
    const call = { type: 'tool-call' as const, id: ToolCallId('duplicate-call'), name: 'perform_step', arguments: '{}' }
    await expect(ctx.tools.execute({ agent: a, log: { turn: 1, step: 0 }, calls: [call, call], signal: currentSignal }))
      .rejects.toThrow('call_conflict')
  }
  if (mode === 'executor_replaced') a.ctx.tools.setExecutor(new NativeToolExecutor(a.ctx))
  const ownerDisposal = mode === 'executor_disposed' ? coordinationOwner.dispose() : undefined
  if (mode === 'executor_disposed') await expect(retainedExecute({ agent: a, log: { turn: 1, step: 0 },
    calls: [], signal: currentSignal })).rejects.toThrow('executor_disposed')
  if (mode === 'executor_removed') {
    removeSelected?.()
    expect(native.observes(view.commandId)).toBe(false)
    const result = await NativeToolExecutor.prototype.execute.call(special, { agent: a, log: { turn: 1, step: 0 },
      calls: [{ type: 'tool-call', id: ToolCallId('unloaded-check'), name: 'perform_step', arguments: '{}' }], signal: currentSignal })
    expect(result.results[0]?.result.isError).toBe(true)
  }
  if (mode === 'flush_denied') vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
  if (mode === 'early_finish') await ctx.serial('task-coordination/consumer-finished', startIdentity)
  if (mode === 'floor') {
    expect((await ctx.tools.execute({ agent: a, log: { turn: 1, step: 0 }, calls: [], signal: currentSignal })).results).toEqual([])
  }
  if (mode === 'floor') {
    await native.closeFloor({ floorDigest: 'a'.repeat(64), canonicalDigest: 'f'.repeat(64),
      authorityEnvironmentId: 'db6d3f48-0aa7-490b-8cab-19a93782a171',
      environmentKey: 'isolated', ownerUserId: 'owner', accountIssuer: 'https://account.test', accountSubject: 'subject',
      hostProfileId: 'b565c7ab-257e-47e0-a994-bf7d0b5f9490', workerId: 'original-worker', authorizationJson: '{}',
      scopeDigest: 'b'.repeat(64),
      transferRequestId: '4c931704-1427-48b6-bff8-4f86ee1527e4', payloadDigest: 'd'.repeat(64),
      acceptedCoordinationEpoch: '2', closedAt: Date.now() }, new AbortController().signal)
    expect(nativeSignal?.aborted).toBe(true)
    await expect(ctx.tools.execute({ agent: a, log: { turn: 1, step: 0 }, calls: [], signal: currentSignal })).rejects.toThrow('closed')
    expect(await readFile(join(root, 'coordination', 'collaboration_task_coordination_v1.json'),
      'utf8')).toContain('4c931704-1427-48b6-bff8-4f86ee1527e4')
  } else if (mode === 'provider_replaced') {
    removeReader()
    ctx.provide('collaborationTaskExecutions', { ...reader })
  } else if (mode === 'account') {
    if (!parent) throw Error('missing actual Account fixture')
    parent.host.revokeOwner(parent.ownerId)
    expect(currentSignal.aborted).toBe(true)
  }
  b.followup(createUserMessage({ content: [{ type: 'text', text: 'start independent root B' }], source: { kind: 'user' } }))
  await b.whenIdle()
  release.release()
  await a.whenIdle()
  const outcome = await requestOutcome
  await ownerDisposal
  if (mode === 'account') expect(outcome).toMatchObject({ code: 'unauthorized' })
  else expect(outcome).toBeNull()
  expect(bodies.get('root-b')).toBe(1)
  expect(bodies.get('root-a') ?? 0).toBe(allowed ? mode === 'parallel' ? 2 : 1 : 0)
  if (mode === 'flush_denied') expect(journal.calls(view.commandId).map(call => call.state)).toEqual(['returned_not_durable'])
  if (allowed && mode !== 'flush_denied') {
    const result = a.session.snapshotEvents().findLast(event => event.type === 'tool/result'
      && event.data.message.toolCallId === ToolCallId('native-root-a'))
    if (result?.type !== 'tool/result') throw Error('missing actual native settlement')
    expect(Boolean(result.data.message.isError)).toBe(false)
    expect(result.data.message.content).toEqual([{ type: 'text', text: 'recorded isolated effect' }])
  }
  if (mode === 'allowed' || mode === 'executor_owned') {
    await coordinationOwner.dispose()
    expect(ctx.tools.inspectExecutor(a)).toBe(selected)
    if (mode === 'executor_owned') {
      expect(configurationReads.count).toBeGreaterThan(0)
      expect(Object.getOwnPropertyDescriptor(selected, 'execute')).toEqual(
        Object.getOwnPropertyDescriptor(NativeToolExecutor.prototype, 'execute'))
    }
    else expect(Object.getOwnPropertyDescriptor(selected, 'execute')).toBeUndefined()
    const replacement = new NativeToolExecutor(ctx)
    removeSelected?.()
    a.ctx.tools.setExecutor(replacement)
    expect(a.ctx.tools.inspectExecutor(a)).toBe(replacement)
  }
})
