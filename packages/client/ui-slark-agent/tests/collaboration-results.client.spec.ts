import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceSnapshot } from './fixture-state.client.ts'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionCollaborationSourcesValue } from '@deepseek-ai/dsh-api-session-controller/types'

const workspace_id = '40000000-0000-4000-8000-000000000004'
const source = { workspace_id, session_id: 'session', source_message_id: 'message', source_revision: '1' }
const original = { source, snapshot_digest: 'a'.repeat(64), original_message: '@Guide · Project 请分析' }
const reply = { delivery_id: 'delivery', invocation_id: 'invocation', delivery_state: 'pending', delivery_state_version: '1',
  source_locator: source, source_snapshot_digest: original.snapshot_digest, execution_state: 'succeeded', invocation_state_version: '2',
  target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' }, answer: '完整答复' }
const { answer: _answer, ...replyWithoutAnswer } = reply
type DeliveryRequest = Parameters<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>[0]

it('keeps the aggregate view within its budget when loading additional replies', async () => {
  const f = fixture(), second = { ...original, snapshot_digest: 'b'.repeat(64), source: { ...source, source_message_id: 'second' } }
  f.reads.mockResolvedValue({ ok: true, value: { items: [original, second] } })
  f.bridge.collaborationDeliveries = vi.fn(async (request: DeliveryRequest) => {
    const start = request.after_delivery_id ? Number(request.after_delivery_id) + 1 : 0
    const digest = request.source.source_message_id === 'second' ? second.snapshot_digest : original.snapshot_digest
    return { ok: true as const, value: { deliveries: Array.from({ length: 5 }, (_, i) => ({ ...reply,
      delivery_id: String(start + i), source_locator: request.source, source_snapshot_digest: digest,
      answer: 'x'.repeat(128 * 1024) })), next_cursor: String(start + 4) } }
  })
  await f.model.refresh()
  // Several valid transport pages can collectively exceed the Session view budget.
  for (let i = 0; i < 24; i++) await f.model.loadReplies(original.snapshot_digest)
  expect(new TextEncoder().encode(JSON.stringify(f.model.getSnapshot())).length).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(f.model.getSnapshot().groups[0]?.phase).toBe('error')
  expect(f.model.getSnapshot().groups[1]?.replies).toHaveLength(5)
  f.model.dispose()
})
function fixture() {
  let grouped = true, remoteGeneration: unknown = 1
  const listeners = new Set<() => void>(), changed = () => { listeners.forEach((fn) => { fn() }) }
  const workspaces: WorkspaceSource = { getSnapshot: () => workspaceSnapshot(workspace_id, 'session', grouped),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const generation = { getSnapshot: () => remoteGeneration,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const reads = vi.fn<ConstructorParameters<typeof CollaborationResultsModel>[3]>(async () => ({ ok: true, value: { items: [original] } }))
  const deliveries = vi.fn<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>(async () => ({ ok: true, value: { deliveries: [reply] } }))
  let bridge: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationDeliveries: deliveries }
  const model = new CollaborationResultsModel(SessionId('session'), workspaces, generation, reads, () => bridge)
  onTestFinished(() => { model.dispose() })
  return { model, reads, bridge, deliveries, changeBridge: (value: CollaborationResultsBridge) => { bridge = value },
    move: () => { grouped = false; changed() }, reset: () => { remoteGeneration = 2; changed() } }
}
it('reconstructs original messages and results using readonly coordinates, with separate execution and delivery state', async () => {
  const f = fixture()
  await f.model.refresh()
  expect(f.reads).toHaveBeenCalledTimes(1)
  expect(f.deliveries).toHaveBeenCalledWith({ source, limit: 50 })
  expect(f.model.getSnapshot().groups[0]?.original.original_message).toBe(original.original_message)
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.answer).toBe('完整答复')
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.delivery_state).toBe('pending')
  f.model.dispose()
})
it('late results cannot restore a previous bridge, workspace or connection generation', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.move() }, (f: ReturnType<typeof fixture>) => { f.reset() },
    (f: ReturnType<typeof fixture>) => { f.changeBridge({ ...f.bridge }) }]) {
    const f = fixture()
    let release!: (value: Awaited<ReturnType<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>>) => void
    f.bridge.collaborationDeliveries = () => new Promise((resolve) => { release = resolve })
    const pending = f.model.refresh()
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    change(f); release({ ok: true, value: { deliveries: [reply] } }); await pending
    expect(f.model.getSnapshot().groups).toEqual([]); f.model.dispose()
  }
})
it('original Source paging and reply paging preserve identity and reject duplicate or substituted replies', async () => {
  const f = fixture(), second = { ...original, source: { ...source, source_message_id: 'older' }, snapshot_digest: 'b'.repeat(64) }
  f.reads.mockImplementation(async cursor => ({ ok: true,
    value: cursor ? { items: [second] } : { items: [original], next_cursor: original.snapshot_digest } }))
  const call = vi.fn(async (input: Parameters<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>[0]) => ({ ok: true as const, value: {
    deliveries: input.source.source_message_id === 'older' ? [] : input.after_delivery_id ? [{ ...reply, delivery_id: 'delivery2' }] : [reply],
    ...(input.source.source_message_id === 'message' && !input.after_delivery_id ? { next_cursor: 'delivery' } : {}) } }))
  f.bridge.collaborationDeliveries = call
  await f.model.refresh(); await f.model.loadSources(); await f.model.loadReplies(original.snapshot_digest)
  expect(f.model.getSnapshot().groups).toHaveLength(2)
  expect(f.model.getSnapshot().groups[0]?.replies.map(r => r.delivery_id)).toEqual(['delivery', 'delivery2'])
  await f.model.refresh()
  expect(f.model.getSnapshot().groups).toHaveLength(2)
  expect(f.model.getSnapshot().groups[0]?.replies.map(r => r.delivery_id)).toEqual(['delivery', 'delivery2'])
  call.mockImplementation(async () => ({ ok: true, value: { deliveries: [{ ...reply, source_locator: { ...source, session_id: 'other' } }] } }))
  await f.model.refresh()
  expect(f.model.getSnapshot().groups[0]?.replies).toEqual([])
  expect(f.model.getSnapshot().groups[0]?.phase).toBe('error'); f.model.dispose()
})
it('older delivery versions cannot roll a known delivered result back to pending', async () => {
  const f = fixture()
  f.bridge.collaborationDeliveries = async () => ({ ok: true, value: { deliveries: [{ ...reply, delivery_state: 'delivered', delivery_state_version: '2' }] } })
  await f.model.refresh()
  f.bridge.collaborationDeliveries = async () => ({ ok: true, value: { deliveries: [reply] } })
  await f.model.refresh()
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.delivery_state).toBe('delivered')
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.delivery_state_version).toBe('2')
  f.model.dispose()
})
it('restricted results replace prior answers and never restore private data from an older state version', async () => {
  const f = fixture(); await f.model.refresh()
  f.bridge.collaborationDeliveries = async () => ({ ok: true, value: { deliveries: [{ delivery_id: 'delivery', invocation_id: 'invocation',
    delivery_state: 'restricted', delivery_state_version: '1', source_locator: source, source_snapshot_digest: original.snapshot_digest }] } })
  await f.model.refresh()
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.answer).toBeUndefined()
  expect(f.model.getSnapshot().groups[0]?.replies[0]?.target_display_snapshot).toBeUndefined()
  f.model.dispose()
})
it('inactive scope and disposal prevent further reads and abort the owning request', async () => {
  const f = fixture(); f.changeBridge({ collaborationScopeAvailable: false }); await f.model.refresh()
  expect(f.reads).not.toHaveBeenCalled(); f.model.dispose(); await f.model.refresh(); expect(f.reads).not.toHaveBeenCalled()
  const b = fixture(); let active!: AbortSignal
  b.reads.mockImplementation(async (_cursor, signal) => { active = signal; return new Promise(() => {}) })
  const pending = b.model.refresh(); await vi.waitFor(() => { expect(active).toBeDefined() }); b.model.dispose()
  expect(active.aborted).toBe(true); await pending
})

it('publishes only the current verified planning state and removes it when the read fails', async () => {
  const f = fixture()
  f.bridge.collaborationDeliveries = async () => ({ ok: true, value: { deliveries: [] } })
  let planning_state = 'planning'
  f.bridge.collaborationPending = async () => ({ ok: true, value: { source,
    plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1',
      planning_state, route_decision: 'collaboration' }, frozen_task_count: 0, pending_items: [] } })
  try {
    await f.model.refresh()
    expect(f.model.getSnapshot().groups[0]).toMatchObject({ planningState: 'planning' })
    planning_state = 'failed'
    await f.model.refresh()
    expect(f.model.getSnapshot().groups[0]).toMatchObject({ planningState: 'failed' })
    f.bridge.collaborationPending = async () => ({ ok: false, errorCode: 'unavailable' })
    await f.model.refresh()
    expect(f.model.getSnapshot().groups[0]).not.toHaveProperty('planningState')
    expect(f.model.getSnapshot().groups[0]?.pendingUnavailable).toBe(true)
    f.reset()
    expect(f.model.getSnapshot().groups).toEqual([])
  } finally { f.model.dispose() }
})

it('rejects substituted, duplicate, oversized and stalled Source pages before reading their results', async () => {
  const pages: SessionCollaborationSourcesValue[] = [
    { items: Array.from({ length: 9 }, () => original) },
    { items: Array.from({ length: 8 }, (_, i) => ({ ...original, snapshot_digest: String(i).repeat(64), original_message: 'x'.repeat(32 * 1024) })) },
    { items: [original], next_cursor: 'other' },
    { items: [], next_cursor: original.snapshot_digest },
    { items: [{ ...original, source: { ...source, session_id: 'other' } }] },
    { items: [{ ...original, source: { ...source, workspace_id: 'other' } }] },
    { items: [{ ...original, snapshot_digest: 'bad' }] },
    { items: [original, original] },
    { items: [{ ...original, original_message: 'x'.repeat(32 * 1024 + 1) }] },
    { items: [{ ...original, original_message: '\ud800' }] },
  ]
  for (const value of pages) {
    const f = fixture(); f.reads.mockResolvedValue({ ok: true, value })
    await f.model.refresh()
    expect(f.model.getSnapshot()).toEqual({ phase: 'error', groups: [] })
    expect(f.deliveries).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.reads.mockResolvedValue({ ok: true, value: { items: [original], next_cursor: original.snapshot_digest } })
  await f.model.refresh(); await f.model.loadSources()
  expect(f.model.getSnapshot()).toEqual({ phase: 'error', groups: [] })
})

it('removes an invalid result page instead of showing substituted, leaked or duplicated replies', async () => {
  type Page = Extract<Awaited<ReturnType<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>>, { ok: true }>['value']
  const pages: Page[] = [
    { deliveries: Array.from({ length: 51 }, () => reply) },
    { deliveries: Array.from({ length: 7 }, (_, i) => ({ ...reply, delivery_id: String(i), answer: 'x'.repeat(128 * 1024) })) },
    ...(['workspace_id', 'session_id', 'source_message_id', 'source_revision'] as const).map(key => ({
      deliveries: [{ ...reply, source_locator: { ...source, [key]: 'other' } }],
    })),
    { deliveries: [{ ...reply, source_snapshot_digest: 'b'.repeat(64) }] },
    { deliveries: [reply, reply] },
    { deliveries: [{ ...reply, answer: 'x'.repeat(128 * 1024 + 1) }] },
    { deliveries: [{ ...reply, answer: '\ud800' }] },
    { deliveries: [{ ...reply, delivery_state: 'restricted' }] },
    { deliveries: [{ ...replyWithoutAnswer, delivery_state: 'restricted' }] },
    { deliveries: [], next_cursor: 'delivery' },
    { deliveries: [reply], next_cursor: 'other' },
  ]
  for (const value of pages) {
    const f = fixture(); f.deliveries.mockResolvedValue({ ok: true, value })
    await f.model.refresh()
    expect(f.model.getSnapshot().groups[0]).toMatchObject({ phase: 'error', replies: [] })
  }
  const f = fixture()
  f.deliveries.mockResolvedValueOnce({ ok: true, value: { deliveries: [reply], next_cursor: 'delivery' } })
  await f.model.refresh()
  f.deliveries.mockResolvedValueOnce({ ok: true, value: { deliveries: [{ ...reply, delivery_id: 'second' }], next_cursor: 'delivery' } })
  await f.model.loadReplies(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]).toMatchObject({ phase: 'error', replies: [] })
})

it('coalesces refresh requests while reading and ignores paging calls without a cursor', async () => {
  const f = fixture()
  await f.model.loadSources(); await f.model.loadReplies('missing')
  expect(f.reads).not.toHaveBeenCalled()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.reads.mockImplementationOnce(async () => { await held; return { ok: true, value: { items: [original] } } })
  const active = f.model.refresh()
  onTestFinished(async () => { release?.(); await active })
  await f.model.refresh(); await f.model.refresh(); await f.model.loadSources(); await f.model.loadReplies(original.snapshot_digest)
  expect(f.reads).toHaveBeenCalledTimes(1)
  release?.(); await active
  await vi.waitFor(() => { expect(f.reads).toHaveBeenCalledTimes(2) })
  await vi.waitFor(() => { expect(f.model.getSnapshot().phase).toBe('ready') })
  await f.model.loadReplies(original.snapshot_digest)
  expect(f.deliveries).toHaveBeenCalledTimes(2)
})

it('aborts a pending plan read on connection change and never restores the old questions', async () => {
  const f = fixture()
  let release: (() => void) | undefined, entered: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  f.bridge.collaborationPending = async () => {
    entered?.(); await held
    return { ok: true, value: { source, plan: null, frozen_task_count: 0, pending_items: [] } }
  }
  const active = f.model.refresh()
  onTestFinished(async () => { release?.(); await active })
  await started; f.reset(); release?.(); await active
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
})

it('stops automatic polling when the last observer leaves and refuses subscriptions after disposal', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const f = fixture(), first = vi.fn(), second = vi.fn()
  const stopFirst = f.model.subscribe(first), stopSecond = f.model.subscribe(second)
  onTestFinished(() => { stopFirst(); stopSecond() })
  await vi.waitFor(() => { expect(f.model.getSnapshot().phase).toBe('ready') })
  const before = f.reads.mock.calls.length
  await vi.advanceTimersByTimeAsync(3_000)
  expect(f.reads).toHaveBeenCalledTimes(before + 1)
  expect(second).toHaveBeenCalled()
  stopFirst(); f.move()
  expect(f.model.getSnapshot().groups).toEqual([])
  stopSecond(); await vi.advanceTimersByTimeAsync(3_000)
  expect(f.reads).toHaveBeenCalledTimes(before + 1)
  f.model.dispose()
  const closed = vi.fn(), stopClosed = f.model.subscribe(closed)
  stopClosed(); await f.model.refresh()
  expect(closed).not.toHaveBeenCalled()
})

it('bounds the number of complete replies accumulated for one Source', async () => {
  const f = fixture()
  f.bridge.collaborationDeliveries = async (request) => {
    const start = request.after_delivery_id ? Number(request.after_delivery_id) + 1 : 0
    const deliveries = Array.from({ length: 50 }, (_, i) => ({ ...replyWithoutAnswer, delivery_id: String(start + i) }))
    return { ok: true, value: { deliveries,
      next_cursor: String(start + 49) } }
  }
  await f.model.refresh()
  for (let i = 0; i < 82; i++) await f.model.loadReplies(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]).toMatchObject({ phase: 'error', replies: [] })
})

it('rejects unavailable feeds and repeated originals across otherwise valid cursor pages', async () => {
  const f = fixture()
  f.reads.mockResolvedValueOnce({ ok: false }); await f.model.refresh()
  expect(f.model.getSnapshot()).toEqual({ phase: 'error', groups: [] })
  f.reads.mockResolvedValueOnce({ ok: true, value: { items: [original], next_cursor: original.snapshot_digest } })
  await f.model.refresh()
  const older = { ...original, snapshot_digest: 'b'.repeat(64) }
  f.reads.mockResolvedValueOnce({ ok: true, value: { items: [original, older], next_cursor: older.snapshot_digest } })
  await f.model.loadSources()
  expect(f.model.getSnapshot()).toEqual({ phase: 'error', groups: [] })
})

it('bounds the total loaded message count and aggregate reply bytes across Sources', async () => {
  for (const mode of ['count', 'bytes'] as const) {
    const f = fixture()
    f.reads.mockImplementation(async (cursor) => {
      const start = cursor ? Number.parseInt(cursor, 16) + 1 : 0
      const items = Array.from({ length: 8 }, (_, i) => ({ ...original, snapshot_digest: (start + i).toString(16).padStart(64, '0'),
        source: { ...source, source_message_id: String(start + i) } }))
      const last = items.at(-1)
      if (!last) throw Error('empty Source page fixture')
      return { ok: true, value: { items, next_cursor: last.snapshot_digest } }
    })
    f.deliveries.mockImplementation(async request => ({ ok: true, value: { deliveries: mode === 'count' ? [] :
      Array.from({ length: 5 }, (_, i) => ({ ...reply, delivery_id: String(i), source_locator: request.source,
        source_snapshot_digest: Number(request.source.source_message_id).toString(16).padStart(64, '0'), answer: 'x'.repeat(128 * 1024) })) } }))
    await f.model.refresh()
    for (let i = 0; i < (mode === 'count' ? 16 : 3); i++) await f.model.loadSources()
    expect(f.model.getSnapshot()).toEqual({ phase: 'error', groups: [] })
  }
})

it('discards a paged result when its owning workspace changes during the read', async () => {
  const f = fixture()
  f.deliveries.mockResolvedValueOnce({ ok: true, value: { deliveries: [reply], next_cursor: reply.delivery_id } })
  await f.model.refresh()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.deliveries.mockImplementationOnce(async () => { await held; return { ok: true, value: { deliveries: [] } } })
  const active = f.model.loadReplies(original.snapshot_digest)
  onTestFinished(async () => { release?.(); await active })
  f.move(); release?.(); await active
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
})

it('does not poll while a Source read is outstanding and ignores results after the view closes', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const f = fixture()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.reads.mockImplementationOnce(async () => { await held; return { ok: true, value: { items: [original] } } })
  const stop = f.model.subscribe(() => {})
  onTestFinished(() => { release?.(); stop() })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(f.reads).toHaveBeenCalledTimes(1)
  release?.()
  await vi.waitFor(() => { expect(f.model.getSnapshot().phase).toBe('ready') })
  stop()
  f.deliveries.mockImplementationOnce(() => {
    f.model.dispose()
    return Promise.resolve({ ok: true, value: { deliveries: [reply] } })
  })
  await f.model.refresh()
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
})

it('does not notify disposed observers when the previous request completes after a bridge change', async () => {
  const f = fixture()
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.reads.mockImplementationOnce(async () => { await held; return { ok: true, value: { items: [original] } } })
  const observer = vi.fn(), stop = f.model.subscribe(observer)
  onTestFinished(() => { release?.(); stop() })
  f.model.dispose(); const before = observer.mock.calls.length
  f.changeBridge({ ...f.bridge }); release?.()
  await vi.waitFor(() => { expect(f.reads).toHaveBeenCalledTimes(1) })
  await f.model.refresh()
  expect(observer).toHaveBeenCalledTimes(before)
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
})

it('ignores a Source page from a workspace that changes before the read completes', async () => {
  const f = fixture()
  f.reads.mockImplementationOnce(async () => { f.move(); return { ok: true, value: { items: [original] } } })
  await f.model.refresh()
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
  expect(f.deliveries).not.toHaveBeenCalled()
})

it('discards a fulfilled Source page if workspace ownership changes before the awaiting query resumes', async () => {
  const f = fixture()
  f.reads.mockImplementationOnce(() => {
    queueMicrotask(() => { queueMicrotask(() => { f.move() }) })
    return Promise.resolve({ ok: true, value: { items: [original] } })
  })
  await f.model.refresh()
  expect(f.model.getSnapshot()).toEqual({ phase: 'idle', groups: [] })
  expect(f.deliveries).not.toHaveBeenCalled()
})

it.each(['reset', 'move'] as const)('discards late execution previews after %s', async (change) => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  let finish!: (value: unknown) => void
  f.bridge.collaborationRootExecution = () => new Promise((resolve) => { finish = resolve })
  await f.model.refresh()
  const pending = f.model.executionAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]?.execution?.phase).toBe('loading')
  f[change]()
  finish({ ok:true,previewId:'old',rootTraceId:'b'.repeat(32),executionEnabled:true,tasks:[{ taskId:'task',question:'old',agentName:'Guide',projectName:'Project' }] })
  await pending
  expect(f.model.getSnapshot().groups).toEqual([])
})
it('rejects malformed or duplicate previews and disabled execution without confirmation', async () => {
  const f=fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const task={ taskId:'task',question:'Work',agentName:'Guide',projectName:'Project' }
  const command=vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>()
  f.bridge.collaborationRootExecution=command
  await f.model.refresh()
  for(const value of [null, { ok:false }, { ok:true,previewId:'p',rootTraceId:'b'.repeat(32),executionEnabled:true,tasks:[task,task] },
    { ok:true,previewId:'p',rootTraceId:'b'.repeat(32),executionEnabled:true,tasks:[{ ...task,question:'x'.repeat(32769) }] }]) {
    command.mockResolvedValue(value)
    await f.model.executionAction(original.snapshot_digest)
    expect(f.model.getSnapshot().groups[0]?.execution?.phase).toBe('error')
  }
  command.mockResolvedValue({ ok:true,previewId:'p',rootTraceId:'b'.repeat(32),executionEnabled:false,tasks:[task] })
  await f.model.executionAction(original.snapshot_digest)
  const count=command.mock.calls.length
  await f.model.executionAction(original.snapshot_digest,'task')
  expect(command).toHaveBeenCalledTimes(count)
})
