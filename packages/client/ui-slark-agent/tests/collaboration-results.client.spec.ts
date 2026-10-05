import { expect, it, vi } from 'vitest'
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
  const reads = vi.fn(async (_cursor: string | undefined, _signal: AbortSignal) =>
    ({ ok: true as const, value: { items: [original] } as SessionCollaborationSourcesValue }))
  const deliveries = vi.fn(async () => ({ ok: true as const, value: { deliveries: [reply] } }))
  let bridge: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationDeliveries: deliveries }
  const model = new CollaborationResultsModel('session' as never, workspaces, generation, reads, () => bridge)
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
