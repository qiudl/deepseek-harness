import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionCollaborationSourceItem, SessionCollaborationSourcesValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'
import { workspaceSnapshot } from './fixture-state.client.ts'

const workspaceId = '40000000-0000-4000-8000-000000000004'
const original = (sessionId: string, digit: string) => ({
  source: { workspace_id: workspaceId, session_id: sessionId, source_message_id: `message-${digit}`, source_revision: '1' },
  snapshot_digest: digit.repeat(64), original_message: `@Guide · Project question ${digit}`,
})
const first = original('first', 'a'), second = original('second', 'b'), older = original('second', 'c')
type Lookup = (original: SessionCollaborationSourceItem, signal: AbortSignal) => Promise<
  { ok: true; value: SessionCollaborationSourcesValue } | { ok: false }>

function fixture() {
  let snapshot = workspaceSnapshot(workspaceId, 'first')
  snapshot = { ...snapshot, items: snapshot.items.map(item => ({ ...item, sessionIds: [SessionId('first'), SessionId('second')] })) }
  const listeners = new Set<() => void>()
  const workspaces: WorkspaceSource = { getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const generation = { getSnapshot: () => 1, subscribe: () => () => {} }
  let head = older
  const reads = vi.fn<ConstructorParameters<typeof CollaborationResultsModel>[3]>(async (cursor, _signal, sessionId) => ({ ok: true,
    value: sessionId === 'first' ? { items: [first] } : cursor ? { items: [older] } : { items: [head],
      ...(head === second ? { next_cursor: second.snapshot_digest } : {}) } }))
  const lookup = vi.fn<Lookup>(async item => ({ ok: true, value: { items: [item] } }))
  const deliveries = vi.fn<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>(async () => ({ ok: true, value: { deliveries: [] } }))
  let bridge: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationDeliveries: deliveries }
  const model = new CollaborationResultsModel(SessionId('first'), workspaces, generation, reads, () => bridge, 'workspace', lookup)
  const target = new CollaborationResultsModel(SessionId('second'), workspaces, generation, reads, () => bridge, 'workspace', lookup)
  onTestFinished(() => { model.dispose(); target.dispose() })
  const changed = () => { listeners.forEach((fn) => { fn() }) }
  return { model, target, reads, lookup, deliveries, setNewHead: () => { head = second },
    move: () => { snapshot = { ...snapshot, items: snapshot.items.map(item => ({ ...item, sessionIds: [SessionId('first')] })) }; changed() },
    archive: () => { snapshot = { ...snapshot, archivedSessionIds: [SessionId('second')] }; changed() },
    revoke: () => { bridge = { collaborationScopeAvailable: false }; changed() },
  }
}

it('revalidates a record before opening its original Session and focuses the exact old Source through refresh and paging', async () => {
  const f = fixture()
  await f.model.refresh(); await f.model.loadSources()
  f.setNewHead()
  const opened = vi.fn((item: SessionCollaborationSourceItem) => { expect(f.target.revealOriginal(item)).toBe(true) })
  await f.model.locateOriginal(older.snapshot_digest, opened)
  expect(opened).toHaveBeenCalledWith(older)
  expect(f.lookup).toHaveBeenCalledWith(older, expect.any(AbortSignal))
  await f.target.refresh()
  expect(f.target.getSnapshot().focus?.snapshotDigest).toBe(older.snapshot_digest)
  expect(f.target.getSnapshot().groups.map(group => group.original)).toEqual([older, second])
  await f.target.loadSources()
  expect(f.target.getSnapshot().groups.map(group => group.original)).toEqual([older, second])
  expect(f.target.getSnapshot().phase).toBe('ready')
  await f.target.refresh()
  expect(f.target.getSnapshot().groups.map(group => group.original)).toEqual([second, older])
  expect(f.target.getSnapshot().focus?.snapshotDigest).toBe(older.snapshot_digest)
})

it.each(['source', 'digest', 'text', 'count', 'cursor', 'refused'] as const)('does not open a substituted or unreadable original: %s', async (mode) => {
  const f = fixture()
  await f.model.refresh()
  f.lookup.mockResolvedValue(mode === 'refused' ? { ok: false } : { ok: true, value: {
    items: mode === 'count' ? [first, first] : [mode === 'source' ? { ...first, source: { ...first.source, source_revision: '2' } }
      : mode === 'digest' ? { ...first, snapshot_digest: 'f'.repeat(64) } : mode === 'text' ? { ...first, original_message: 'changed' } : first],
    ...(mode === 'cursor' ? { next_cursor: first.snapshot_digest } : {}),
  } })
  const opened = vi.fn()
  await f.model.locateOriginal(first.snapshot_digest, opened)
  expect(opened).not.toHaveBeenCalled()
  expect(f.model.getSnapshot().location).toEqual({ snapshotDigest: first.snapshot_digest, status: 'unavailable' })
})

it.each(['move', 'archive', 'revoke', 'dispose'] as const)('does not navigate after locator ownership changes: %s', async (mode) => {
  const f = fixture()
  await f.model.refresh(); await f.model.loadSources()
  let release!: (value: Awaited<ReturnType<Lookup>>) => void
  f.lookup.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const opened = vi.fn(), pending = f.model.locateOriginal(older.snapshot_digest, opened)
  onTestFinished(async () => { f.model.dispose(); release?.({ ok: false }); await pending })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  if (mode === 'dispose') f.model.dispose()
  else f[mode]()
  release({ ok: true, value: { items: [older] } }); await pending
  expect(opened).not.toHaveBeenCalled()
  expect(f.model.getSnapshot().groups).toEqual([])
})

it('explains a failed navigation and does not locate a group absent from the current view', async () => {
  const f = fixture(), opened = vi.fn()
  await f.model.refresh()
  await f.model.locateOriginal(older.snapshot_digest, opened)
  expect(f.lookup).not.toHaveBeenCalled()
  await f.model.locateOriginal(first.snapshot_digest, () => { throw Error('navigation refused') })
  expect(f.model.getSnapshot().location?.status).toBe('unavailable')
})

it('removes a pinned original when fresh lookup stops authorizing it', async () => {
  const f = fixture()
  f.setNewHead()
  expect(f.target.revealOriginal(older)).toBe(true)
  f.lookup.mockResolvedValue({ ok: false })
  await f.target.refresh()
  expect(f.target.getSnapshot().groups.map(group => group.original)).toEqual([second])
  expect(f.target.getSnapshot().focus).toBeUndefined()
  expect(f.target.getSnapshot().location?.status).toBe('unavailable')
})

it.each(['coordinates', 'text'] as const)('refuses a history page substituting a located immutable original: %s', async (mode) => {
  const f = fixture()
  f.target.revealOriginal(older)
  f.reads.mockResolvedValue({ ok: true, value: { items: [{ ...older,
    ...(mode === 'text' ? { original_message: 'substituted text' }
      : { source: { ...older.source, source_revision: '2' } }),
  }] } })
  await f.target.refresh()
  expect(f.target.getSnapshot().phase).toBe('error')
  expect(f.target.getSnapshot().groups).toEqual([])
})

it('refuses to reveal an original in a different Session or workspace and after disposal', () => {
  const f = fixture()
  expect(f.model.revealOriginal(older)).toBe(false)
  expect(f.target.revealOriginal({ ...older, source: { ...older.source, workspace_id: 'other' } })).toBe(false)
  f.target.dispose()
  expect(f.target.revealOriginal(older)).toBe(false)
  expect(f.target.getSnapshot().focus).toBeUndefined()
})

it('does not retain a location when navigation itself revokes its workspace authority', async () => {
  const f = fixture()
  await f.model.refresh()
  await f.model.locateOriginal(first.snapshot_digest, f.revoke)
  expect(f.model.getSnapshot().groups).toEqual([])
  expect(f.model.getSnapshot().location).toBeUndefined()
})

it.each(['success', 'refusal'] as const)('does not retain a refreshed pinned original after a late ownership change: %s', async (mode) => {
  const f = fixture()
  f.setNewHead()
  f.target.revealOriginal(older)
  let release!: (value: Awaited<ReturnType<Lookup>>) => void
  f.lookup.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const pending = f.target.refresh()
  onTestFinished(async () => { f.target.dispose(); release?.({ ok: false }); await pending })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  f.move()
  release(mode === 'success' ? { ok: true, value: { items: [older] } } : { ok: false })
  await pending
  expect(f.target.getSnapshot().groups).toEqual([])
  expect(f.target.getSnapshot().focus).toBeUndefined()
})

it('replaces an in-flight history read with the verified original without cancelling accepted work', async () => {
  const f = fixture()
  let release!: (value: Awaited<ReturnType<typeof f.reads>>) => void
  f.reads.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const pending = f.target.refresh()
  onTestFinished(async () => { f.target.dispose(); release?.({ ok: false }); await pending })
  expect(f.target.revealOriginal(older)).toBe(true)
  release({ ok: true, value: { items: [second] } })
  await pending
  await vi.waitFor(() => { expect(f.target.getSnapshot().phase).toBe('ready') })
  expect(f.target.getSnapshot().groups.map(group => group.original)).toContainEqual(older)
  expect(f.target.getSnapshot().focus?.snapshotDigest).toBe(older.snapshot_digest)
})

it('counts a located old original within the bounded workspace history capacity', async () => {
  const f = fixture()
  const items = Array.from({ length: 128 }, (_, i) => ({ ...second, snapshot_digest: i.toString(16).padStart(64, '0'),
    source: { ...second.source, source_message_id: `newer-${i}` } }))
  items[127] = older
  f.reads.mockImplementation(async (cursor, _signal, sessionId) => {
    if (sessionId !== 'second') return { ok: true, value: { items: [] } }
    const start = cursor ? items.findIndex(item => item.snapshot_digest === cursor) + 1 : 0
    const page = items.slice(start, start + 8)
    return { ok: true, value: { items: page, ...(start + 8 < items.length ? { next_cursor: page.at(-1)?.snapshot_digest } : {}) } }
  })
  f.target.revealOriginal(older)
  await f.target.refresh()
  for (let i = 1; i < 16; i++) await f.target.loadSources()
  expect(f.target.getSnapshot().groups).toHaveLength(128)
  items[127] = { ...second, snapshot_digest: 'e'.repeat(64) }
  await f.target.refresh()
  expect(f.target.getSnapshot().phase).toBe('error')
  expect(f.target.getSnapshot().groups).toEqual([])
})

it('discards a pinned original whose result read finishes after its Session leaves the workspace', async () => {
  const f = fixture()
  f.setNewHead(); f.target.revealOriginal(older)
  let release!: (value: Awaited<ReturnType<typeof f.deliveries>>) => void
  f.deliveries.mockImplementation(async request => request.source.source_message_id === older.source.source_message_id
    ? new Promise((resolve) => { release = resolve }) : { ok: true, value: { deliveries: [] } })
  const pending = f.target.refresh()
  onTestFinished(async () => { f.target.dispose(); release?.({ ok: false, errorCode: 'unavailable' }); await pending })
  await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
  f.move(); release({ ok: true, value: { deliveries: [] } }); await pending
  expect(f.target.getSnapshot().groups).toEqual([])
  expect(f.target.getSnapshot().focus).toBeUndefined()
})

it.each([1, 2, 3, 4])('refuses navigation after a queued authority change around lookup completion (%i)', async (turns) => {
  const f = fixture()
  await f.model.refresh()
  let revoked = false, removal: Promise<void> | undefined
  f.lookup.mockImplementation((item) => {
    removal = (async () => {
      for (let i = 0; i < turns; i++) await Promise.resolve()
      revoked = true; f.revoke()
    })()
    return Promise.resolve({ ok: true, value: { items: [item] } })
  })
  await f.model.locateOriginal(first.snapshot_digest, () => { expect(revoked).toBe(false) })
  await removal
  expect(f.model.getSnapshot().groups).toEqual([])
  expect(f.model.getSnapshot().location).toBeUndefined()
})

it.each([1, 2, 3, 4])('discards a pinned lookup after a queued membership change around refresh completion (%i)', async (turns) => {
  const f = fixture()
  f.setNewHead(); f.target.revealOriginal(older)
  let removal: Promise<void> | undefined
  f.lookup.mockImplementation((item) => {
    removal = (async () => {
      for (let i = 0; i < turns; i++) await Promise.resolve()
      f.move()
    })()
    return Promise.resolve({ ok: true, value: { items: [item] } })
  })
  await f.target.refresh(); await removal
  expect(f.target.getSnapshot().groups).toEqual([])
  expect(f.target.getSnapshot().focus).toBeUndefined()
})
