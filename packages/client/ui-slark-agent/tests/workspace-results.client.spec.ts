import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionCollaborationSourcesValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'
import { workspaceSnapshot } from './fixture-state.client.ts'

const workspaceId = '40000000-0000-4000-8000-000000000004'
const original = (sessionId: string, digit: string) => ({
  source: { workspace_id: workspaceId, session_id: sessionId, source_message_id: `message-${digit}`, source_revision: '1' },
  snapshot_digest: digit.repeat(64), original_message: `@Guide · Project question ${digit}`,
})
const first = original('session', 'a'), second = original('second', 'b'), older = original('second', 'c')
type ReadWorkspace = (sessionId: SessionId, cursor: string | undefined, signal: AbortSignal) => Promise<
  { ok: true; value: SessionCollaborationSourcesValue } | { ok: false }>

function fixture() {
  let snapshot = workspaceSnapshot(workspaceId)
  snapshot = { ...snapshot, items: snapshot.items.map(item => ({ ...item,
    sessionIds: [SessionId('second'), SessionId('session'), SessionId('empty')] })) }
  const listeners = new Set<() => void>()
  const workspaces: WorkspaceSource = { getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const workspaceReads = vi.fn<ReadWorkspace>(async sessionId => ({ ok: true,
    value: { items: sessionId === 'session' ? [first] : sessionId === 'second' ? [second] : [] } }))
  const deliveries = vi.fn<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>(async () => ({ ok: true, value: { deliveries: [] } }))
  const bridge: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationDeliveries: deliveries }
  const model = new CollaborationResultsModel(SessionId('session'), workspaces,
    { getSnapshot: () => 1, subscribe: () => () => {} }, (cursor, signal, sessionId) => workspaceReads(sessionId, cursor, signal), () => bridge, 'workspace')
  onTestFinished(() => { model.dispose() })
  const members = (ids: string[], archived: string[] = []) => {
    snapshot = { ...snapshot, archivedSessionIds: archived.map(SessionId),
      items: snapshot.items.map(item => ({ ...item, sessionIds: ids.map(SessionId) })) }
    listeners.forEach((fn) => { fn() })
  }
  return { model, workspaceReads, deliveries, bridge, members }
}

it('pages other workspace Sessions and reads every result through its own original Source', async () => {
  const f = fixture()
  await f.model.refresh()
  expect(f.model.getSnapshot()).toMatchObject({ workspaceHistory: true, groups: [{ original: first }], nextCursor: first.snapshot_digest })
  await f.model.loadSources()
  expect(f.model.getSnapshot().groups.map(group => group.original)).toEqual([first, second])
  expect(f.deliveries.mock.calls.map(([request]) => request.source)).toEqual([first.source, second.source])
  expect(f.workspaceReads.mock.calls.map(([id]) => id)).toEqual(['session', 'empty', 'second'])
  expect(f.model.getSnapshot().nextCursor).toBeUndefined()
})

it('preserves Native cursors within each Session and refreshes all loaded workspace pages', async () => {
  const f = fixture()
  f.members(['session', 'second'])
  f.workspaceReads.mockImplementation(async (sessionId, cursor) => ({ ok: true,
    value: sessionId === 'session' ? { items: [first] } : cursor ? { items: [older] }
      : { items: [second], next_cursor: second.snapshot_digest } }))
  await f.model.refresh(); await f.model.loadSources(); await f.model.loadSources()
  expect(f.model.getSnapshot().groups.map(group => group.original.snapshot_digest))
    .toEqual([first, second, older].map(item => item.snapshot_digest))
  await f.model.refresh()
  expect(f.model.getSnapshot().groups.map(group => group.original)).toEqual([first, second, older])
  expect(f.workspaceReads.mock.calls.map(([id, cursor]) => [id, cursor])).toEqual([
    ['session', undefined], ['second', undefined], ['second', second.snapshot_digest],
    ['session', undefined], ['second', undefined], ['second', second.snapshot_digest],
  ])
})

it.each(['foreign-workspace', 'wrong-session', 'duplicate', 'bad-cursor'] as const)('rejects %s before reading its results', async (mode) => {
  const f = fixture()
  f.members(['session', 'second'])
  await f.model.refresh()
  const invalid = mode === 'foreign-workspace' ? { ...second, source: { ...second.source, workspace_id: 'other' } }
    : mode === 'wrong-session' ? first : mode === 'duplicate' ? { ...second, snapshot_digest: first.snapshot_digest } : second
  f.workspaceReads.mockResolvedValue({ ok: true, value: { items: [invalid],
    ...(mode === 'bad-cursor' ? { next_cursor: first.snapshot_digest } : {}) } })
  await f.model.loadSources()
  expect(f.model.getSnapshot()).toMatchObject({ phase: 'error', groups: [] })
  expect(f.deliveries).toHaveBeenCalledTimes(1)
})

it.each(['move', 'archive'] as const)('discards an in-flight page when a sibling Session changes membership: %s', async (mode) => {
  const f = fixture()
  f.members(['session', 'second'])
  await f.model.refresh()
  let release!: (value: Awaited<ReturnType<ReadWorkspace>>) => void
  let active!: AbortSignal
  f.workspaceReads.mockImplementationOnce((_id, _cursor, signal) => {
    active = signal
    return new Promise((resolve) => { release = resolve })
  })
  const pending = f.model.loadSources()
  onTestFinished(async () => { f.model.dispose(); release?.({ ok: false }); await pending })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  if (mode === 'move') f.members(['session'])
  else f.members(['session', 'second'], ['second'])
  expect(f.model.getSnapshot().groups).toEqual([])
  expect(active.aborted).toBe(true)
  release({ ok: true, value: { items: [second] } }); await pending
  expect(f.model.getSnapshot().groups).toEqual([])
  await f.model.refresh()
  expect(f.model.getSnapshot().groups.map(group => group.original)).toEqual([first])
  expect(f.model.getSnapshot().nextCursor).toBeUndefined()
})

it('skips empty and archived Sessions without fetching any archived Source', async () => {
  const f = fixture()
  f.members(['session', 'empty', 'second'], ['second'])
  f.workspaceReads.mockResolvedValue({ ok: true, value: { items: [] } })
  await f.model.refresh()
  expect(f.workspaceReads.mock.calls.map(([id]) => id)).toEqual(['session', 'empty'])
  expect(f.model.getSnapshot()).toMatchObject({ phase: 'ready', groups: [] })
})

it('clears workspace history when Native refuses a sibling Source read', async () => {
  const f = fixture()
  f.members(['session', 'second'])
  await f.model.refresh()
  f.workspaceReads.mockResolvedValue({ ok: false })
  await f.model.loadSources()
  expect(f.model.getSnapshot()).toMatchObject({ phase: 'error', groups: [] })
  expect(f.deliveries).toHaveBeenCalledTimes(1)
})

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('cannot restore sibling records during queued Source resolution (delay %i)', async (delay) => {
  const f = fixture()
  f.members(['session', 'second'])
  await f.model.refresh()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  f.workspaceReads.mockImplementationOnce(async () => { await held; return { ok: true, value: { items: [second] } } })
  const pending = f.model.loadSources()
  release()
  const move = async () => { for (let i = 0; i < delay; i++) await Promise.resolve(); f.members(['session']) }
  await Promise.all([pending, move()])
  expect(f.model.getSnapshot().groups).toEqual([])
})
