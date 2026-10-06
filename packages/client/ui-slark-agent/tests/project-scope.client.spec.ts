import { expect, it, onTestFinished, vi } from 'vitest'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workspaceSnapshot } from './fixture-state.client.ts'
import { ProjectScopeModel } from '../src/client/project-scope.ts'
import type { WorkspaceBridge, WorkspaceResponse } from '../src/client/project-scope.ts'

const workspaceId = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
function fixture() {
  let snapshot = workspaceSnapshot(workspaceId)
  const listeners = new Set<() => void>()
  const source: WorkspaceSource = { getSnapshot: () => snapshot, subscribe: (fn: () => void) => {
    listeners.add(fn); return () => { listeners.delete(fn) }
  } }
  let version = '0', selected: string[] = []
  const call = vi.fn<NonNullable<WorkspaceBridge['collaborationWorkspace']>>(async (input) => {
    const kind = input.operation.kind
    if (input.operation.kind === 'apply') {
      version = String(Number(version) + 1); selected = [...input.operation.selected_project_ids]
    }
    if (kind === 'get' || kind === 'apply') return { ok: true as const,
      value: { workspace_id: input.workspace_id, version, selected_project_ids: selected } }
    return { ok: true as const, value: { items: kind === 'projects' ? [{ project_id: 'one', project_name: 'First space' },
      { project_id: 'two', project_name: 'Second space' }] : [], next_cursor: null,
    ...(kind === 'agents' ? { scope_version: version } : {}) } }
  })
  let host: WorkspaceBridge | undefined = { collaborationWorkspace: call }
  const model = new ProjectScopeModel(SessionId('session'), source, () => host)
  onTestFinished(() => { model.dispose() })
  return { model, call, listeners, replaceBridge: (replacement?: WorkspaceBridge) => { host = replacement },
    setSnapshot: (value: typeof snapshot) => { snapshot = value; listeners.forEach((fn) => { fn() }) },
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

it('clears scope when the Session is archived or workspace authority is loading or failed', async () => {
  for (const invalid of [
    { ...workspaceSnapshot(workspaceId), archivedSessionIds: [SessionId('session')] },
    { ...workspaceSnapshot(workspaceId), phase: 'pending' as const },
    { ...workspaceSnapshot(workspaceId), state: 'error' as const },
  ]) {
    const f = fixture(); await f.model.refresh(); await f.model.apply(['one'])
    f.setSnapshot(invalid)
    const calls = f.call.mock.calls.length
    await f.model.refresh(); await f.model.loadProjects(); await f.model.loadAgents()
    expect(f.model.getSnapshot()).toMatchObject({ workspaceId: null, scope: null, agents: [], projects: [] })
    expect(f.call).toHaveBeenCalledTimes(calls)
  }
})

it('keeps an unavailable bridge or a failed scope read explicit without reading an Agent directory', async () => {
  for (const mode of ['missing-bridge', 'missing-method', 'rejected-read', 'wrong-category', 'closed'] as const) {
    const f = fixture()
    if (mode === 'missing-bridge') f.replaceBridge(undefined)
    if (mode === 'missing-method') f.replaceBridge({})
    if (mode === 'rejected-read') f.call.mockRejectedValueOnce(new Error('Main unavailable'))
    if (mode === 'wrong-category') f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: null } })
    if (mode === 'closed') f.model.dispose()
    await f.model.refresh()
    expect(f.model.getSnapshot().scope).toBeNull()
    expect(f.model.getSnapshot().agents).toEqual([])
    if (mode !== 'closed') expect(f.model.getSnapshot()).toMatchObject({ phase: 'error', notice: 'unavailable' })
    expect(f.call.mock.calls.every(([input]) => input.operation.kind === 'get')).toBe(true)
  }
})

it('reloads scope after a rejected save without retrying the selection and retains the uncertainty notice on failed reconciliation', async () => {
  const f = fixture(); await f.model.refresh()
  f.call.mockRejectedValueOnce(new Error('save disconnected'))
  f.call.mockRejectedValueOnce(new Error('read disconnected'))
  await f.model.apply(['one'])
  expect(f.model.getSnapshot()).toMatchObject({ phase: 'error', notice: 'uncertain', scope: null })
  expect(f.call.mock.calls.filter(([input]) => input.operation.kind === 'apply')).toHaveLength(1)
  await f.model.refresh()
  expect(f.model.getSnapshot()).toMatchObject({ phase: 'ready', notice: null })
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual([])
})

it('contains transport loss during page reads and ignores late reads and saves from a moved Session', async () => {
  for (const operation of ['projects', 'agents', 'apply'] as const) {
    const f = fixture(); await f.model.refresh()
    f.call.mockImplementationOnce(async () => {
      f.change([])
      throw new Error('old bridge disconnected')
    })
    if (operation === 'apply') await f.model.apply(['one'])
    else if (operation === 'projects') await f.model.loadProjects(true)
    else await f.model.loadAgents(true)
    expect(f.model.getSnapshot()).toMatchObject({ workspaceId: null, phase: 'idle', projects: [], agents: [] })
  }
  const f = fixture(); await f.model.refresh()
  f.call.mockRejectedValueOnce(new Error('directory disconnected'))
  await f.model.loadProjects(true)
  expect(f.model.getSnapshot()).toMatchObject({ loadingProjects: false, notice: 'unavailable' })
})

it('appends directory pages by stable identities and refreshes matching rows without losing unloaded selected projects', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.apply(['one', 'unloaded'])
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [{ project_id: 'one', project_name: 'First space' }], next_cursor: 'projects' } })
  await f.model.loadProjects(true)
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [{ project_id: 'one', project_name: 'Renamed space' },
    { project_id: 'two', project_name: 'Second space' }], next_cursor: null } })
  await f.model.loadProjects()
  expect(f.model.getSnapshot().projects.map(p => p.project_name)).toEqual(['Renamed space', 'Second space'])
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual(['one', 'unloaded'])
  const agent = { project_id: 'one', project_name: 'Renamed space', agent_id: 'guide', agent_name: 'Guide',
    available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' }
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [agent], next_cursor: 'agents', scope_version: '1' } })
  await f.model.loadAgents(true)
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [{ ...agent, agent_name: 'New Guide' },
    { ...agent, project_id: 'two', project_name: 'Second space' }], next_cursor: null, scope_version: '1' } })
  await f.model.loadAgents()
  expect(f.call).toHaveBeenLastCalledWith(expect.objectContaining({ operation: { kind: 'agents', query: { limit: 20, cursor: 'agents' } } }))
  expect(f.model.getSnapshot().agents.map(a => [a.project_name, a.agent_name])).toEqual([
    ['Renamed space', 'New Guide'], ['Second space', 'Guide'],
  ])
})

it('refuses page categories or Agent scope versions that do not match the current saved selection', async () => {
  const f = fixture(); await f.model.refresh()
  f.call.mockResolvedValueOnce({ ok: true, value: { workspace_id: workspaceId, version: '0', selected_project_ids: [] } })
  await f.model.loadProjects(true)
  expect(f.model.getSnapshot()).toMatchObject({ loadingProjects: false, notice: 'unavailable' })
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'wrong', scope_version: '0' } })
  await f.model.loadProjects(true)
  expect(f.model.getSnapshot()).toMatchObject({ agentCursor: null, loadingProjects: false, notice: 'unavailable' })
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'wrong', scope_version: '1' } })
  await f.model.loadAgents(true)
  expect(f.model.getSnapshot()).toMatchObject({ agents: [], agentCursor: null, loadingAgents: false, notice: 'unavailable' })
})

it('keeps one in-flight directory read and discards its completion when the workspace changes', async () => {
  const f = fixture(); await f.model.refresh()
  let finish: ((value: WorkspaceResponse) => void) | undefined
  f.call.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const pending = f.model.loadAgents(true), calls = f.call.mock.calls.length
  onTestFinished(async () => {
    finish?.({ ok: true, value: { items: [], next_cursor: null, scope_version: '0' } })
    await pending
  })
  await f.model.loadAgents(true)
  expect(f.call).toHaveBeenCalledTimes(calls)
  expect(f.model.getSnapshot().loadingAgents).toBe(true)
  f.change([])
  if (!finish) throw Error('missing directory read')
  finish({ ok: true, value: { items: [], next_cursor: 'late', scope_version: '0' } })
  await pending
  expect(f.model.getSnapshot()).toMatchObject({ workspaceId: null, loadingAgents: false, agents: [], agentCursor: null })
})
