import { expect, it, vi } from 'vitest'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ProjectScopeModel } from '../src/client/project-scope.ts'

const workspaceId = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
function fixture() {
  let snapshot = { items: [{ workspaceId, sessionIds: ['session'] }], phase: 'ready', state: 'idle', archivedSessionIds: [] }
  const listeners = new Set<() => void>()
  const source = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => {
    listeners.add(fn); return () => { listeners.delete(fn) }
  } } as unknown as WorkspaceSource
  let version = '0', selected: string[] = []
  const call = vi.fn(async (input: { workspace_id: string; operation: { kind: string; selected_project_ids?: readonly string[] } }) => {
    const kind = input.operation.kind
    if (kind === 'apply') { version = String(Number(version) + 1); selected = [...input.operation.selected_project_ids!] }
    if (kind === 'get' || kind === 'apply') return { ok: true as const,
      value: { workspace_id: input.workspace_id, version, selected_project_ids: selected } }
    return { ok: true as const, value: { items: kind === 'projects' ? [{ project_id: 'one', project_name: 'First space' },
      { project_id: 'two', project_name: 'Second space' }] : [], next_cursor: null,
    ...(kind === 'agents' ? { scope_version: version } : {}) } }
  })
  let host = { collaborationWorkspace: call }
  const model = new ProjectScopeModel('session' as never, source, () => host)
  return { model, call, listeners, replaceBridge: () => { host = { collaborationWorkspace: vi.fn() as never } },
    change: (items: typeof snapshot.items) => {
      snapshot = { ...snapshot, items }; listeners.forEach((fn) => { fn() })
    } }
}
it('loads default empty scope and applies multiple spaces and an explicit clear', async () => {
  const f = fixture()
  await f.model.refresh()
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual([])
  await f.model.apply(['one', 'two'])
  expect(f.call).toHaveBeenCalledWith(expect.objectContaining({ operation: {
    kind: 'apply', expected_version: '0', selected_project_ids: ['one', 'two'],
  } }))
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual(['one', 'two'])
  await f.model.apply([])
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual([])
  f.model.dispose(); expect(f.listeners.size).toBe(0)
})
it('ungrouped and moved Sessions never retain the preceding workspace scope or a late response', async () => {
  const f = fixture()
  await f.model.refresh(); await f.model.apply(['one'])
  let resolve!: (value: never) => void
  f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const old = f.model.refresh()
  f.change([])
  expect(f.model.getSnapshot()).toMatchObject({ workspaceId: null, scope: null, projects: [], agents: [] })
  resolve({ ok: true, value: { workspace_id: workspaceId, version: '9', selected_project_ids: ['one'] } } as never)
  await old
  expect(f.model.getSnapshot().scope).toBeNull()
  const calls = f.call.mock.calls.length
  await f.model.apply(['one']); expect(f.call).toHaveBeenCalledTimes(calls)
  f.model.dispose()
})
it('empty project page with continuation remains loadable and preserves selected ids', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.apply(['two'])
  f.call.mockImplementationOnce(async () => ({ ok: true, value: { items: [], next_cursor: 'more' } }) as never)
  await f.model.loadProjects(true)
  expect(f.model.getSnapshot().projectCursor).toBe('more')
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual(['two'])
  await f.model.loadProjects()
  expect(f.call).toHaveBeenLastCalledWith(expect.objectContaining({ operation: {
    kind: 'projects', query: { limit: 20, cursor: 'more' },
  } }))
  f.model.dispose()
})
it('conflict and ambiguous save read fresh authority and never reapply the draft', async () => {
  for (const errorCode of ['scope_conflict', 'collaboration_scope_unavailable']) {
    const f = fixture(); await f.model.refresh()
    f.call.mockImplementationOnce(async () => ({ ok: false, errorCode, refreshRequired: true }) as never)
    await f.model.apply(['one'])
    expect(f.model.getSnapshot().notice).toBe(errorCode === 'scope_conflict' ? 'conflict' : 'uncertain')
    expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual([])
    expect(f.call.mock.calls.filter(([x]) => x.operation.kind === 'apply')).toHaveLength(1)
    f.model.dispose()
  }
})
it('disposal and bridge replacement ignore in-flight data and preserve no foreign account list', async () => {
  const f = fixture()
  let resolve!: (value: never) => void
  f.call.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const pending = f.model.refresh(); f.model.dispose()
  resolve({ ok: true, value: { workspace_id: workspaceId, version: '0', selected_project_ids: ['one'] } } as never)
  await pending; expect(f.model.getSnapshot().scope).toBeNull()
})

it('a replaced Desktop bridge clears cached authority before a save or late page can cross accounts', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.apply(['one'])
  const calls = f.call.mock.calls.length
  f.replaceBridge(); await f.model.apply(['two'])
  expect(f.call).toHaveBeenCalledTimes(calls)
  expect(f.model.getSnapshot()).toMatchObject({ scope: null, projects: [], agents: [] })
  f.model.dispose()
})

it('Agent ids containing separators retain distinct project and Agent pairs', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.apply(['space:a', 'space'])
  f.call.mockImplementationOnce(async () => ({ ok: true, value: { scope_version: '1', next_cursor: null,
    items: [ { project_id: 'space:a', agent_id: 'b', project_name: 'First', agent_name: 'Guide', available: false,
      capability_snapshot: 'a'.repeat(64), reason_code: 'executor_unavailable' },
    { project_id: 'space', agent_id: 'a:b', project_name: 'Second', agent_name: 'Guide', available: false,
      capability_snapshot: 'b'.repeat(64), reason_code: 'executor_unavailable' } ] } }) as never)
  await f.model.loadAgents(true)
  expect(f.model.getSnapshot().agents.map(x => x.project_name)).toEqual(['First', 'Second'])
  f.model.dispose()
})
