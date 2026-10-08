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

it.each([false, true])('publishes a verified result before an older Source finishes, with prior history=%s', async (loaded) => {
  const f = fixture(), older = { ...original, snapshot_digest: 'b'.repeat(64), source: { ...source, source_message_id: 'older' } }
  f.reads.mockResolvedValue({ ok: true, value: { items: [original, older] } })
  f.deliveries.mockImplementation(async request => ({ ok: true, value: { deliveries: request.source.source_message_id === 'older'
    ? [] : [reply] } }))
  if (loaded) await f.model.refresh()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.deliveries>>>()
  const entered = Promise.withResolvers<undefined>()
  f.deliveries.mockImplementation(async (request) => {
    if (request.source.source_message_id === 'older') { entered.resolve(undefined); return held.promise }
    return { ok: true, value: { deliveries: [{ ...reply, answer: 'Updated verified result' }] } }
  })
  const refresh = f.model.refresh()
  onTestFinished(async () => { held.resolve({ ok: true, value: { deliveries: [] } }); f.model.dispose(); await refresh })
  await entered.promise
  const intermediate = f.model.getSnapshot()
  expect(intermediate.phase).toBe('loading')
  expect(intermediate.groups[0]?.replies[0]?.answer).toBe('Updated verified result')
  expect(intermediate.groups).toHaveLength(loaded ? 2 : 1)
  held.resolve({ ok: true, value: { deliveries: [] } })
  await refresh
  expect(f.model.getSnapshot().phase).toBe('ready')
  expect(f.model.getSnapshot().groups).toHaveLength(2)
  expect(intermediate.groups).toHaveLength(loaded ? 2 : 1)
})

it('removes a denied result while the next original message is still loading', async () => {
  const f = fixture(), older = { ...original, snapshot_digest: 'b'.repeat(64), source: { ...source, source_message_id: 'older' } }
  f.reads.mockResolvedValue({ ok: true, value: { items: [original, older] } })
  f.deliveries.mockImplementation(async request => ({ ok: true, value: { deliveries: request.source.source_message_id === 'older' ? [] : [reply] } }))
  await f.model.refresh()
  const held = Promise.withResolvers<Awaited<ReturnType<typeof f.deliveries>>>()
  const entered = Promise.withResolvers<undefined>()
  f.deliveries.mockImplementation(async (request) => {
    if (request.source.source_message_id === 'older') { entered.resolve(undefined); return held.promise }
    return { ok: false, errorCode: 'denied' }
  })
  const refresh = f.model.refresh()
  onTestFinished(async () => { held.resolve({ ok: true, value: { deliveries: [] } }); f.model.dispose(); await refresh })
  await entered.promise
  expect(f.model.getSnapshot().groups[0]?.replies).toEqual([])
  expect(f.model.getSnapshot().groups[0]?.phase).toBe('error')
  f.reset()
  expect(f.model.getSnapshot().groups).toEqual([])
  held.resolve({ ok: true, value: { deliveries: [] } })
  await refresh
  expect(f.model.getSnapshot().groups).toEqual([])
})

it.each(['workspace-removal', 'dispose'] as const)('stops older reads when an incremental notification triggers %s', async (ending) => {
  const f = fixture(), older = { ...original, snapshot_digest: 'b'.repeat(64), source: { ...source, source_message_id: 'older' } }
  f.reads.mockResolvedValue({ ok: true, value: { items: [original, older] } })
  let interrupted = false
  const stop = f.model.subscribe(() => {
    if (interrupted || f.model.getSnapshot().phase !== 'loading' || !f.model.getSnapshot().groups.length) return
    interrupted = true
    if (ending === 'workspace-removal') f.move()
    else f.model.dispose()
  })
  onTestFinished(stop)
  await vi.waitFor(() => { expect(interrupted).toBe(true) })
  expect(f.deliveries).toHaveBeenCalledTimes(1)
  expect(f.model.getSnapshot().groups).toEqual([])
})

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
    quietReset: () => { remoteGeneration = 2 },
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

async function executableFixture() {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  f.deliveries.mockResolvedValue({ ok: true, value: { deliveries: [{ ...reply, task_id: 'task' }] } })
  const command = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>()
  f.bridge.collaborationRootExecution = command
  await f.model.refresh()
  const preview = { ok: true, previewId: 'preview', rootTraceId: 'b'.repeat(32), executionEnabled: true,
    tasks: [{ taskId: 'task', question: 'Work', agentName: 'Guide', projectName: 'Project' }] }
  command.mockResolvedValue(preview)
  await f.model.executionAction(original.snapshot_digest)
  return { ...f, command, preview }
}
it('keeps invalid execution acknowledgments uncertain and ignores rejection from an old connection', async () => {
  const f = await executableFixture()
  f.command.mockResolvedValue({ ok: true, status: 'wrong' })
  await f.model.executionAction(original.snapshot_digest, 'task')
  expect(f.model.getSnapshot().groups[0]?.execution?.outcomes?.task).toBe('uncertain')
  f.command.mockImplementationOnce(async () => { f.reset(); throw Error('old connection') })
  await f.model.executionAction(original.snapshot_digest, 'task', true)
  expect(f.model.getSnapshot().groups).toEqual([])
})
it('rejects malformed task arrays and trace previews instead of enabling confirmation', async () => {
  const f = await executableFixture()
  for (const patch of [{ rootTraceId: '0'.repeat(32) }, { tasks: [null] }, { tasks: [] }, { previewId: '' }]) {
    f.command.mockResolvedValue({ ...f.preview, ...patch })
    await f.model.executionAction(original.snapshot_digest)
    expect(f.model.getSnapshot().groups[0]?.execution?.phase).toBe('error')
  }
})
it('records acknowledged consumption separately from continuation and never repeats a fresh grant', async () => {
  const f = await executableFixture()
  const ack = { ok: true, rootTraceId: f.preview.rootTraceId, status: 'context_applied', consumptionAcknowledged: true, continuationObserved: false }
  f.command.mockResolvedValue(ack)
  await f.model.consumptionAction(original.snapshot_digest, 'delivery')
  expect(f.command).toHaveBeenLastCalledWith({ action: 'consume', previewId: 'preview', taskId: 'task', deliveryId: 'delivery' })
  expect(f.model.getSnapshot().groups[0]?.execution?.consumptions?.delivery).toBe('context_applied')
  const calls = f.command.mock.calls.length
  await f.model.consumptionAction(original.snapshot_digest, 'delivery')
  expect(f.command).toHaveBeenCalledTimes(calls)
  f.command.mockResolvedValue({ ...ack, continuationObserved: true })
  await f.model.consumptionAction(original.snapshot_digest, 'delivery', true)
  expect(f.command).toHaveBeenLastCalledWith({ action: 'consumption-status', previewId: 'preview', taskId: 'task', deliveryId: 'delivery' })
  expect(f.model.getSnapshot().groups[0]?.execution?.consumptions?.delivery).toBe('continued')
})
it('does not certify consumption from absent, unacknowledged or foreign-root replies', async () => {
  const f = await executableFixture()
  for (const value of [null, { ok: false }, { ok: true, rootTraceId: 'f'.repeat(32) },
    { ok: true, rootTraceId: f.preview.rootTraceId, consumptionAcknowledged: false },
    { ok: true, rootTraceId: f.preview.rootTraceId, consumptionAcknowledged: true, status: 'queued' }]) {
    f.command.mockResolvedValue(value)
    await f.model.consumptionAction(original.snapshot_digest, 'delivery', true)
    expect(f.model.getSnapshot().groups[0]?.execution?.consumptions?.delivery).toBe('uncertain')
  }
})
it.each(['resolve', 'reject'] as const)('discards %s after consumption ownership changes', async (mode) => {
  const f = await executableFixture()
  f.command.mockImplementationOnce(async () => {
    f.reset()
    if (mode === 'reject') throw Error('old connection')
    return { ok: true, rootTraceId: f.preview.rootTraceId, consumptionAcknowledged: true, status: 'context_applied', continuationObserved: true }
  })
  await f.model.consumptionAction(original.snapshot_digest, 'delivery')
  expect(f.model.getSnapshot().groups).toEqual([])
})

it('allows a new explicit confirmation only after the original command is known not admitted', async () => {
  const f = await executableFixture()
  f.command.mockResolvedValue({ ok: true, status: 'not_admitted' })
  await f.model.executionAction(original.snapshot_digest, 'task')
  expect(f.model.getSnapshot().groups[0]?.execution?.outcomes?.task).toBe('not_admitted')
  f.command.mockResolvedValue({ ok: true, status: 'recorded' })
  await f.model.executionAction(original.snapshot_digest, 'task')
  expect(f.model.getSnapshot().groups[0]?.execution?.outcomes?.task).toBe('recorded')
})

it('reads original-root trajectory without preview or execution and restores requested pages on refresh', async () => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const root = { root_task_id: '10000000-0000-4000-8000-000000000001', root_trace_id: 'b'.repeat(32), task_revision: '1', state_version: '1', state: 'active', intent_state: 'active' as const }
  const trace = vi.fn(async (r: { action: string; cursor?: { after_seq: number } }) => {
    expect(r.action).toBe('trace')
    const after = r.cursor?.after_seq ?? 0
    const events = Array.from({ length: after ? 1 : 20 }, (_, n) => ({ event_id: `event-${after + n + 1}`,
      root_seq: after + n + 1, task_revision: 1, type: 'execution_observed', phase: 'execution_admitted',
      occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
      trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1, step_id: 'step', attempt_id: 'attempt' } }))
    return { ok: true, value: { root, events, next_after_seq: after ? null : 20, coverage: 'partial' } }
  })
  f.bridge.collaborationRootExecution = trace
  await f.model.refresh()
  expect(trace).not.toHaveBeenCalled()
  await f.model.traceAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]?.trace?.page?.events).toHaveLength(20)
  await f.model.traceAction(original.snapshot_digest, true)
  expect(f.model.getSnapshot().groups[0]?.trace?.page?.events).toHaveLength(21)
  await f.model.refresh()
  expect(f.model.getSnapshot().groups[0]?.trace?.page?.events).toHaveLength(21)
  expect(trace.mock.calls.map(([r]) => r.cursor?.after_seq)).toEqual([0, 20, 0, 20])
  expect(f.model.getSnapshot().groups[0]?.trace?.page?.root.state).toBe('active')
  f.reset()
  expect(f.model.getSnapshot().groups).toEqual([])
})

it('pages settlement evidence through readonly commands and clears it when authority fails', async () => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '1', state_version: '1', state: 'active', intent_state: 'active' }
  const event = { event_id: 'event', root_seq: 1, task_revision: 1, type: 'execution_observed', phase: 'execution_succeeded',
    occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
    trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1 } }
  const command = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async (request) => {
    if (request.action !== 'trace') throw Error('must only read')
    const after = request.cursor.evidence?.after_sequence ?? 0
    return { ok: true, value: { root, events: [event], next_after_seq: null, coverage: 'partial',
      ...(request.cursor.evidence ? { execution: { event_id: 'event', attempt_id: 'attempt', state: 'succeeded', digest: 'a'.repeat(64),
        provider_visibility: 'boundary_only', next_after_sequence: after ? null : 20,
        events: Array.from({ length: after ? 1 : 20 }, (_, n) => ({ sequence: after + n + 1, observedAt: 0, type: 'tool.completed' })) } } : {}) } }
  })
  f.bridge.collaborationRootExecution = command
  await f.model.refresh()
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event')
  expect(command).not.toHaveBeenCalled()
  await f.model.traceAction(original.snapshot_digest)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'missing')
  expect(command).toHaveBeenCalledTimes(1)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event', true)
  expect(command).toHaveBeenCalledTimes(1)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event')
  expect(f.model.getSnapshot().groups[0]?.trace?.execution?.page?.events).toHaveLength(20)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event', true)
  expect(command).toHaveBeenLastCalledWith({ action: 'trace', source: original.source,
    cursor: { after_seq: 0, limit: 20, evidence: { event_id: 'event', after_sequence: 20 } } })
  expect(f.model.getSnapshot().groups[0]?.trace?.execution?.page?.events).toHaveLength(21)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event', true)
  expect(command).toHaveBeenCalledTimes(3)
  command.mockRejectedValueOnce(Error('revoked'))
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event')
  expect(f.model.getSnapshot().groups[0]?.trace).toEqual({ phase: 'error' })
  await f.model.traceAction(original.snapshot_digest)
  command.mockImplementationOnce(async () => { f.reset(); return { ok: false } })
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event')
  expect(f.model.getSnapshot().groups).toEqual([])
})

function auditPage(after = 0, full = false) {
  const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '1', state_version: '1', state: 'active', intent_state: 'active' }
  return { ok: true, value: { root, coverage: 'partial', next_after_seq: full ? after + 20 : null,
    events: Array.from({ length: full ? 20 : 1 }, (_, n) => ({ event_id: `event-${after + n + 1}`, root_seq: after + n + 1,
      task_revision: 1, type: 'root_accepted', phase: 'root_accepted', occurred_at: '2026-10-07T00:00:00.000Z',
      recorded_at: '2026-10-07T00:00:00.000Z', trace_context: { root_task_id: root.root_task_id,
        root_trace_id: root.root_trace_id, task_revision: 1 } })) } }
}
it('refuses unavailable trajectory reads, stale responses and duplicate events across pages', async () => {
  const f = fixture()
  await f.model.traceAction(original.snapshot_digest)
  await f.model.refresh()
  await f.model.traceAction(original.snapshot_digest, true)
  await f.model.traceAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]?.trace).toEqual({ phase: 'error' })
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const command = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async () => auditPage(0, true))
  f.bridge.collaborationRootExecution = command
  await f.model.traceAction(original.snapshot_digest)
  const duplicate = auditPage(20, true)
  duplicate.value.events[0]!.event_id = 'event-1'
  command.mockResolvedValueOnce(duplicate)
  await f.model.traceAction(original.snapshot_digest, true)
  expect(f.model.getSnapshot().groups[0]?.trace).toEqual({ phase: 'error' })
  command.mockImplementationOnce(async () => { f.reset(); return auditPage() })
  await f.model.traceAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups).toEqual([])
  await f.model.refresh()
  command.mockImplementationOnce(async () => { f.changeBridge({ ...f.bridge }); throw Error('obsolete') })
  await f.model.traceAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups).toEqual([])
})
it('caps retained audit and runtime histories even when every page is individually valid', async () => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const command = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async (request) => {
    if (request.action !== 'trace') throw Error('unexpected execution')
    const page = auditPage(request.cursor.after_seq, true), evidence = request.cursor.evidence
    return evidence ? { ...page, value: { ...page.value, execution: {
      event_id: evidence.event_id, attempt_id: 'attempt', state: 'succeeded', digest: 'a'.repeat(64), provider_visibility: 'boundary_only',
      next_after_sequence: evidence.after_sequence + 20, events: Array.from({ length: 20 }, (_, n) => ({
        sequence: evidence.after_sequence + n + 1, observedAt: 0, type: 'tool.completed' })),
    } } } : page
  })
  f.bridge.collaborationRootExecution = command
  await f.model.refresh()
  await f.model.traceAction(original.snapshot_digest)
  for (let n = 0; n < 204; n++) await f.model.traceAction(original.snapshot_digest, true)
  expect(f.model.getSnapshot().groups[0]?.trace).toEqual({ phase: 'error' })
  // Refresh this Source's history, then independently exhaust runtime observation capacity.
  command.mockResolvedValueOnce(auditPage())
  await f.model.traceAction(original.snapshot_digest)
  await f.model.traceEvidenceAction(original.snapshot_digest, 'event-1')
  for (let n = 0; n < 102; n++) await f.model.traceEvidenceAction(original.snapshot_digest, 'event-1', true)
  expect(f.model.getSnapshot().groups[0]?.trace).toEqual({ phase: 'error' })
})

it('drops completed audit and evidence reads when connection generation changes before its notification', async () => {
  for (const evidence of [false, true]) {
    const f = fixture()
    Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
    const command = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async () => auditPage())
    f.bridge.collaborationRootExecution = command
    await f.model.refresh()
    if (evidence) await f.model.traceAction(original.snapshot_digest)
    command.mockImplementationOnce(async () => { f.quietReset(); return auditPage() })
    if (evidence) await f.model.traceEvidenceAction(original.snapshot_digest, 'event-1')
    else await f.model.traceAction(original.snapshot_digest)
    expect(f.model.getSnapshot().groups).toEqual([])
  }
})
it('bounds combined cloud history across separate original Sources', async () => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const originals = Array.from({ length: 6 }, (_, n) => ({ ...original, snapshot_digest: String(n + 1).repeat(64),
    source: { ...source, source_message_id: `source-${n}` } }))
  f.reads.mockResolvedValue({ ok: true, value: { items: originals } })
  f.deliveries.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  const large = '界'.repeat(240)
  f.bridge.collaborationRootExecution = async (request) => {
    if (request.action !== 'trace') throw Error('unexpected execution')
    const page = auditPage(request.cursor.after_seq, true)
    return { ...page, value: { ...page.value, events: page.value.events.map(e => ({ ...e,
      event_id: `${large}${e.root_seq}`, phase: large, type: large,
      trace_context: { ...e.trace_context, step_id: large, attempt_id: large, causation_id: large } })) } }
  }
  await f.model.refresh()
  for (const source of originals) {
    await f.model.traceAction(source.snapshot_digest)
    for (let n = 0; n < 35; n++) await f.model.traceAction(source.snapshot_digest, true)
  }
  const snapshot = f.model.getSnapshot()
  expect(snapshot.groups.some(g => g.trace?.phase === 'error')).toBe(true)
  expect(snapshot.groups.some(g => g.trace?.phase === 'ready')).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(snapshot.groups.map(g => g.trace))).length).toBeLessThan(16 * 1024 * 1024)
})

// REQ-20261004-0008: real network latency must not discard explicit trajectory reads.
it.each(['finish', 'reset', 'dispose'] as const)('queues a trace behind a pending refresh and handles %s', async (ending) => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '1', state_version: '1', state: 'active', intent_state: 'active' }
  const trace = vi.fn(async () => ({ ok: true, value: { root, events: [], next_after_seq: null, coverage: 'partial' } }))
  f.bridge.collaborationRootExecution = trace
  await f.model.refresh()
  const hold = Promise.withResolvers<Awaited<ReturnType<typeof f.deliveries>>>()
  f.deliveries.mockImplementationOnce(() => hold.promise)
  const refresh = f.model.refresh()
  await vi.waitFor(() => { expect(f.deliveries).toHaveBeenCalledTimes(2) })
  const selected = f.model.traceAction(original.snapshot_digest)
  const duplicate = f.model.traceAction(original.snapshot_digest)
  expect(f.model.getSnapshot().groups[0]?.trace?.phase).toBe('loading')
  expect(trace).not.toHaveBeenCalled()
  if (ending === 'reset') f.reset()
  if (ending === 'dispose') f.model.dispose()
  hold.resolve({ ok: true, value: { deliveries: [reply] } })
  await Promise.all([refresh, selected, duplicate])
  expect(trace).toHaveBeenCalledTimes(ending === 'finish' ? 1 : 0)
  if (ending === 'finish') expect(f.model.getSnapshot().groups[0]?.trace?.page?.root.root_trace_id).toBe(root.root_trace_id)
  else expect(f.model.getSnapshot().groups.every(g => g.trace === undefined)).toBe(true)
})

it('runs queued execution evidence before a requested background refresh and coalesces clicks', async () => {
  const f = fixture(), order: string[] = []
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  f.bridge.collaborationRootExecution = async (request) => {
    if (request.action !== 'trace') throw Error('readonly test')
    const page = auditPage()
    if (!request.cursor.evidence) return page
    order.push('evidence')
    return { ...page, value: { ...page.value, execution: { event_id: 'event-1', attempt_id: 'attempt',
      state: 'succeeded', digest: 'a'.repeat(64), provider_visibility: 'boundary_only', next_after_sequence: null,
      events: [{ sequence: 1, observedAt: 0, type: 'tool.completed', success: true }] } } }
  }
  await f.model.refresh()
  await f.model.traceAction(original.snapshot_digest)
  const hold = Promise.withResolvers<Awaited<ReturnType<typeof f.deliveries>>>()
  f.deliveries.mockImplementationOnce(() => hold.promise)
  const refresh = f.model.refresh()
  await vi.waitFor(() => { expect(f.deliveries).toHaveBeenCalledTimes(2) })
  f.deliveries.mockImplementation(async () => { order.push('refresh'); return { ok: true, value: { deliveries: [reply] } } })
  const evidence = f.model.traceEvidenceAction(original.snapshot_digest, 'event-1')
  const duplicate = f.model.traceEvidenceAction(original.snapshot_digest, 'event-1')
  expect(f.model.getSnapshot().groups[0]?.trace?.execution?.phase).toBe('loading')
  await f.model.refresh()
  hold.resolve({ ok: true, value: { deliveries: [reply] } })
  await Promise.all([refresh, evidence, duplicate])
  await vi.waitFor(() => { expect(order).toEqual(['evidence', 'refresh']) })
  expect(f.model.getSnapshot().groups[0]?.trace?.execution?.page?.events).toHaveLength(1)
})

it.each(['reset', 'dispose'] as const)('discards queued execution evidence after %s without reading the previous root', async (ending) => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const trace = vi.fn(async () => auditPage())
  f.bridge.collaborationRootExecution = trace
  await f.model.refresh()
  await f.model.traceAction(original.snapshot_digest)
  const hold = Promise.withResolvers<Awaited<ReturnType<typeof f.deliveries>>>()
  f.deliveries.mockImplementationOnce(() => hold.promise)
  const refresh = f.model.refresh()
  await vi.waitFor(() => { expect(f.deliveries).toHaveBeenCalledTimes(2) })
  const evidence = f.model.traceEvidenceAction(original.snapshot_digest, 'event-1')
  expect(f.model.getSnapshot().groups[0]?.trace?.execution?.phase).toBe('loading')
  // The current Source's background history read starts independently of its held results.
  expect(trace).toHaveBeenCalledTimes(2)
  if (ending === 'reset') f.reset()
  else f.model.dispose()
  hold.resolve({ ok: true, value: { deliveries: [reply] } })
  await Promise.all([refresh, evidence])
  expect(trace).toHaveBeenCalledTimes(2)
  expect(f.model.getSnapshot().groups.every(g => g.trace === undefined)).toBe(true)
})

it('refreshes each original Source with its own deadline while reading its trace independently of result latency', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new DOMException('Timed out', 'TimeoutError')) }, ms)
    return controller.signal
  })
  onTestFinished(() => { timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers() })
  const f = fixture(), originals = [original, ...['b', 'c'].map(id => ({ ...original,
    snapshot_digest: id.repeat(64), source: { ...source, source_message_id: id } }))]
  f.reads.mockResolvedValue({ ok: true, value: { items: originals } })
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })
  let slow = false
  f.bridge.collaborationDeliveries = async (request) => {
    if (slow) await delay(12_000)
    const found = originals.find(item => item.source.source_message_id === request.source.source_message_id)!
    return { ok: true, value: { deliveries: [{ ...reply, source_locator: found.source, source_snapshot_digest: found.snapshot_digest }] } }
  }
  f.bridge.collaborationPending = async (request) => {
    if (slow) await delay(12_000)
    return { ok: true, value: { source: request.source, plan: null, frozen_task_count: 0, pending_items: [] } }
  }
  f.bridge.collaborationRootExecution = async () => { if (slow) await delay(18_000); return auditPage() }
  await f.model.refresh()
  for (const item of originals) await f.model.traceAction(item.snapshot_digest)
  slow = true
  const refresh = f.model.refresh()
  onTestFinished(async () => { f.model.dispose(); await refresh })
  await vi.advanceTimersByTimeAsync(100_000)
  await refresh
  expect(f.model.getSnapshot().groups.map(group => ({ phase: group.phase, pendingUnavailable: group.pendingUnavailable,
    trace: group.trace?.phase, events: group.trace?.page?.events.length }))).toEqual(originals.map(() => ({
    phase: 'ready', pendingUnavailable: undefined, trace: 'ready', events: 1,
  })))
})

it.each(['finish', 'reset', 'dispose', 'dispose-on-notification'] as const)('services a queued trace before older Sources and handles %s', async (ending) => {
  const f = fixture(), older = { ...original, snapshot_digest: 'b'.repeat(64), source: { ...source, source_message_id: 'older' } }
  f.reads.mockResolvedValue({ ok: true, value: { items: [original, older] } })
  f.deliveries.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  await f.model.refresh()
  const order: string[] = [], entered = Promise.withResolvers<undefined>(), held = Promise.withResolvers<undefined>()
  f.deliveries.mockImplementation(async (request) => {
    order.push(request.source.source_message_id)
    if (request.source.source_message_id === 'message') { entered.resolve(undefined); await held.promise }
    return { ok: true, value: { deliveries: [] } }
  })
  f.bridge.collaborationRootExecution = async () => {
    order.push('trace')
    if (ending === 'reset') f.reset()
    if (ending === 'dispose') f.model.dispose()
    return auditPage()
  }
  const refresh = f.model.refresh()
  onTestFinished(async () => { held.resolve(undefined); f.model.dispose(); await refresh })
  await entered.promise
  if (ending === 'dispose-on-notification') {
    const stop = f.model.subscribe(() => {
      if (f.model.getSnapshot().groups[0]?.trace?.phase === 'ready') queueMicrotask(() => { f.model.dispose() })
    })
    onTestFinished(stop)
  }
  const trace = f.model.traceAction(original.snapshot_digest)
  held.resolve(undefined)
  await Promise.all([refresh, trace])
  expect(order).toEqual(ending === 'finish' ? ['message', 'trace', 'older'] : ['message', 'trace'])
  if (ending === 'finish') expect(f.model.getSnapshot().groups[0]?.trace?.phase).toBe('ready')
  else expect(f.model.getSnapshot().groups).toEqual([])
})

it.each([32_000, 41_000])('bounds a history read at the Desktop response deadline for a %i ms response', async (elapsed) => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, ms)
    return controller.signal
  })
  onTestFinished(() => { timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers() })
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  f.bridge.collaborationRootExecution = async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, elapsed) })
    return auditPage()
  }
  await f.model.refresh()
  const read = f.model.traceAction(original.snapshot_digest)
  onTestFinished(async () => { f.model.dispose(); await read })
  await vi.advanceTimersByTimeAsync(42_000)
  await read
  expect(f.model.getSnapshot().groups[0]?.trace?.phase).toBe(elapsed < 40_000 ? 'ready' : 'error')
  if (elapsed > 40_000) expect(f.model.getSnapshot().groups[0]?.trace?.page).toBeUndefined()
})
