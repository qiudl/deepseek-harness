// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceSnapshot, dockRuntime, panelRuntime, dockTranslate } from './fixture-state.client.ts'
import { ProjectScopeModel } from '../src/client/project-scope.ts'
import type { WorkspaceBridge } from '../src/client/project-scope.ts'
import { ProjectScopeDock, ProjectScopePanel, CollaborationTabTitle } from '../src/client/ProjectScopeDock.tsx'
import { zh } from '../src/client/locales.ts'

const workspaceId = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
afterEach(cleanup)
function fixture(grouped = true, executable = false, initialSelected: readonly string[] = []) {
  let selected: readonly string[] = initialSelected, version = 0
  const call = vi.fn<NonNullable<WorkspaceBridge['collaborationWorkspace']>>(async (input) => {
    const op = input.operation
    if (op.kind === 'apply') { selected = op.selected_project_ids; version++ }
    if (op.kind === 'get' || op.kind === 'apply') return { ok: true as const,
      value: { workspace_id: workspaceId, version: String(version), selected_project_ids: selected } }
    if (op.kind === 'projects') return { ok: true as const, value: { items: [
      { project_id: 'one', project_name: '产品空间' }, { project_id: 'two', project_name: '研发空间' },
    ], next_cursor: null } }
    return { ok: true as const, value: { items: selected.length ? [{ project_id: 'one', project_name: '产品空间',
      agent_id: 'agent', agent_name: '<script>Guide', available: executable,
      capability_snapshot: 'a'.repeat(64), reason_code: executable ? 'ready' : 'executor_unavailable' }] : [],
    next_cursor: null, scope_version: String(version) } }
  })
  const bridge = { collaborationWorkspace: call, collaborationExecutionAvailable: executable }
  const workspaces: WorkspaceSource = { getSnapshot: () => workspaceSnapshot(workspaceId, 'session', grouped),
    subscribe: () => () => undefined }
  const model = new ProjectScopeModel('session' as never, workspaces, () => bridge)
  onTestFinished(() => { model.dispose() })
  const insertAgent = vi.fn(() => true)
  const props: Parameters<typeof ProjectScopePanel>[0] = { ...panelRuntime(), renderSlot: () => null,
    useSlarkScope: <T,>(selector: (s: ReturnType<typeof model.getSnapshot>) => T) =>
      selector(useSyncExternalStore(model.subscribe, model.getSnapshot)),
    refreshScope: () => model.refresh(), applyScope: (ids: readonly string[]) => model.apply(ids),
    loadProjects: () => model.loadProjects(), loadAgents: () => model.loadAgents(), insertAgent,
    t: dockTranslate,
  }
  return { model, call, props, insertAgent }
}
it('optional collaboration area supports multi-select, apply and explicit clear with Agent space labels', async () => {
  const f = fixture(), view = render(<ProjectScopePanel {...f.props} />)
  const first = await screen.findByRole('checkbox', { name: '产品空间' })
  fireEvent.click(first); fireEvent.click(screen.getByRole<HTMLInputElement>('checkbox', { name: '研发空间' }))
  expect(f.call.mock.calls.filter(([x]) => x.operation.kind === 'apply')).toHaveLength(0)
  fireEvent.click(screen.getByTestId('slark-scope-apply'))
  await screen.findByText('<script>Guide · 产品空间')
  expect(view.container.querySelector('script')).toBeNull()
  expect(screen.getByText('仅供查看')).toBeTruthy()
  expect((screen.getByRole<HTMLInputElement>('checkbox', { name: '研发空间' })).checked).toBe(true)
  fireEvent.click(screen.getByTestId('slark-scope-clear'))
  fireEvent.click(screen.getByTestId('slark-scope-apply'))
  await screen.findByText(zh['scope.empty'])
  expect(f.call.mock.calls.filter(([x]) => x.operation.kind === 'apply').map(([x]) => x.operation))
    .toEqual([{ kind: 'apply', expected_version: '0', selected_project_ids: ['one', 'two'] },
      { kind: 'apply', expected_version: '1', selected_project_ids: [] }])
  view.unmount(); f.model.dispose()
})
it('qualified Agents invite chat mentions without adding a task form or send button', async () => {
  const f = fixture(true, true)
  const span = { start: 2, end: 2, draftRev: 7 }
  f.props.inputActions.captureInsertion = vi.fn(() => span)
  const submit = vi.fn()
  f.props.inputActions.submit = submit
  const view = render(<ProjectScopePanel {...f.props} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: '产品空间' }))
  fireEvent.click(screen.getByTestId('slark-scope-apply'))
  await screen.findByText('<script>Guide · 产品空间')
  expect(screen.getByText(zh['scope.mentionReady'])).toBeTruthy()
  expect(screen.getByText(zh['scope.chatReady'])).toBeTruthy()
  expect(screen.queryByText(zh['scope.executorPending'])).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(screen.getByTestId('slark-scope-mention-one-agent'))
  expect(f.insertAgent).toHaveBeenCalledWith('one', 'agent', span)
  expect(submit).not.toHaveBeenCalled()
  view.unmount(); f.model.dispose()
})
it('cancel discards the local selection without saving or clearing the authority', async () => {
  const f = fixture(), view = render(<ProjectScopePanel {...f.props} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: '产品空间' }))
  fireEvent.click(screen.getByTestId('slark-scope-cancel'))
  view.unmount()
  const reopened = render(<ProjectScopePanel {...f.props} />)
  onTestFinished(() => { reopened.unmount() })
  await waitFor(() => { expect((screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' })).checked).toBe(false) })
  expect(f.call.mock.calls.every(([x]) => x.operation.kind !== 'apply')).toBe(true)
  view.unmount(); f.model.dispose()
})
it('ungrouped Session makes no range requests and names the required workspace', () => {
  const f = fixture(false), view = render(<ProjectScopePanel {...f.props} />)
  expect(screen.getByText(zh['scope.ungrouped'])).toBeTruthy()
  expect(f.call).not.toHaveBeenCalled(); expect(screen.queryByRole('checkbox')).toBeNull()
  view.unmount(); f.model.dispose()
})
it('save conflict replaces the stale selection, shows recovery copy, and does not replay', async () => {
  const f = fixture(), view = render(<ProjectScopePanel {...f.props} />)
  fireEvent.click(await screen.findByRole('checkbox', { name: '产品空间' }))
  f.call.mockImplementationOnce(async () => ({ ok: false, errorCode: 'scope_conflict', refreshRequired: true }) as never)
  await act(async () => { fireEvent.click(screen.getByTestId('slark-scope-apply')) })
  await screen.findByText(zh['scope.conflict'])
  await waitFor(() => { expect((screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' })).checked).toBe(false) })
  expect(f.call.mock.calls.filter(([x]) => x.operation.kind === 'apply')).toHaveLength(1)
  view.unmount(); f.model.dispose()
})

it('retains unloaded selected spaces, supports deselection and directory paging, and refreshes saved authority', async () => {
  const f = fixture(true, true, ['one', 'unloaded']), view = render(<ProjectScopePanel {...f.props} />)
  onTestFinished(() => { view.unmount() })
  const first = await screen.findByRole<HTMLInputElement>('checkbox', { name: '产品空间' })
  expect(first.checked).toBe(true)
  expect(screen.getByText(dockTranslate('scope.selectedPending', { count: 1 }))).toBeTruthy()
  fireEvent.click(first)
  expect(first.checked).toBe(false)
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'projects-more' } })
  await act(async () => { await f.model.loadProjects(true) })
  expect(screen.queryByText(zh['scope.noProjects'])).toBeNull()
  fireEvent.click(screen.getByTestId('slark-scope-more-projects'))
  await screen.findByRole('checkbox', { name: '研发空间' })
  expect(f.call).toHaveBeenLastCalledWith(expect.objectContaining({ operation: {
    kind: 'projects', query: { limit: 20, cursor: 'projects-more' },
  } }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' }).checked).toBe(false)
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'agents-more', scope_version: '0' } })
  await act(async () => { await f.model.loadAgents(true) })
  fireEvent.click(screen.getByTestId('slark-scope-more-agents'))
  await screen.findByText('<script>Guide · 产品空间')
  expect(f.call).toHaveBeenLastCalledWith(expect.objectContaining({ operation: {
    kind: 'agents', query: { limit: 20, cursor: 'agents-more' },
  } }))
  fireEvent.click(screen.getByTestId('slark-scope-refresh'))
  await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' }).checked).toBe(true) })
  expect(f.model.getSnapshot().scope?.selected_project_ids).toEqual(['one', 'unloaded'])
  expect(f.call.mock.calls.some(([input]) => input.operation.kind === 'apply')).toBe(false)
})

it('limits new selections to fifty spaces while allowing deselection and blocks edits during an outstanding save', async () => {
  const saved = ['one', ...Array.from({ length: 49 }, (_, i) => `unloaded-${i}`)]
  const f = fixture(true, false, saved), view = render(<ProjectScopePanel {...f.props} />)
  onTestFinished(() => { view.unmount() })
  const first = await screen.findByRole<HTMLInputElement>('checkbox', { name: '产品空间' })
  const second = screen.getByRole<HTMLInputElement>('checkbox', { name: '研发空间' })
  expect(first.disabled).toBe(false); expect(second.disabled).toBe(true)
  fireEvent.click(first)
  expect(second.disabled).toBe(false)
  fireEvent.click(second)
  const original = f.call.getMockImplementation()
  if (!original) throw Error('missing scope transport')
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.call.mockImplementationOnce(async (input) => { const result = await original(input); await held; return result })
  let pending: Promise<void> | undefined
  onTestFinished(async () => { release?.(); await pending })
  await act(async () => { pending = f.model.apply([...saved.filter(id => id !== 'one'), 'two']) })
  expect(screen.getByText(zh['scope.saving'])).toBeTruthy()
  expect(first.disabled).toBe(true); expect(second.disabled).toBe(true)
  for (const id of ['clear', 'cancel', 'apply', 'refresh'])
    expect(screen.getByTestId<HTMLButtonElement>(`slark-scope-${id}`).disabled).toBe(true)
  const count = f.call.mock.calls.filter(([input]) => input.operation.kind === 'apply').length
  fireEvent.click(screen.getByTestId('slark-scope-apply'))
  expect(f.call.mock.calls.filter(([input]) => input.operation.kind === 'apply')).toHaveLength(count)
  if (!release || !pending) throw Error('missing pending scope save')
  await act(async () => { release?.(); await pending })
  expect(screen.queryByText(zh['scope.saving'])).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '研发空间' }).checked).toBe(true)
})

it('shows empty and loading directories without hiding continuation controls or allowing a second page request', async () => {
  const f = fixture(), view = render(<ProjectScopePanel {...f.props} />)
  onTestFinished(() => { view.unmount() })
  await screen.findByRole('checkbox', { name: '产品空间' })
  f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: null } })
  await act(async () => { await f.model.loadProjects(true) })
  expect(screen.getByText(zh['scope.noProjects'])).toBeTruthy()
  for (const kind of ['projects', 'agents'] as const) {
    f.call.mockResolvedValueOnce({ ok: true, value: { items: [], next_cursor: 'more',
      ...(kind === 'agents' ? { scope_version: '0' } : {}) } })
    await act(async () => { if (kind === 'projects') await f.model.loadProjects(true); else await f.model.loadAgents(true) })
    const original = f.call.getMockImplementation()
    if (!original) throw Error('missing directory transport')
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    f.call.mockImplementationOnce(async (input) => { const result = await original(input); await held; return result })
    let pending: Promise<void> | undefined
    onTestFinished(async () => { release?.(); await pending })
    await act(async () => { pending = kind === 'projects' ? f.model.loadProjects() : f.model.loadAgents() })
    expect(screen.getByText(zh['scope.loading'])).toBeTruthy()
    const more = screen.getByTestId<HTMLButtonElement>(`slark-scope-more-${kind}`)
    expect(more.disabled).toBe(true)
    const calls = f.call.mock.calls.length
    fireEvent.click(more)
    expect(f.call).toHaveBeenCalledTimes(calls)
    if (!release || !pending) throw Error('missing pending directory page')
    await act(async () => { release?.(); await pending })
    expect(screen.queryByText(zh['scope.loading'])).toBeNull()
  }
})


it('shows a retained-draft notice when a directory insertion is refused', async () => {
  const f = fixture(true, true, ['one'])
  f.insertAgent.mockReturnValue(false)
  f.props.inputActions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 0 })
  const view = render(<ProjectScopePanel {...f.props} />)
  fireEvent.click(await screen.findByTestId('slark-scope-mention-one-agent'))
  expect(screen.getByText(zh['scope.insertUnavailable'])).toBeTruthy()
  view.unmount()
})
it.each(['adjudicating', 'claimed', 'submitting'] as const)('directory mention cannot alter a %s composer', async (phase) => {
  const f = fixture(true, true, ['one'])
  const view = render(<ProjectScopePanel {...f.props} useInput={selector => selector({ ...dockRuntime().input, phase })} />)
  const button = await screen.findByTestId('slark-scope-mention-one-agent')
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(f.insertAgent).not.toHaveBeenCalled()
  view.unmount()
})

it.each([false, true])('the composer launcher opens the existing sidebar without project controls, history or another input (grouped=%s)', async (grouped) => {
  const f = fixture(grouped, true, ['one']), openCollaboration = vi.fn()
  const view = render(<ProjectScopeDock {...dockRuntime()} useSlarkScope={f.props.useSlarkScope}
    refreshScope={f.props.refreshScope} openCollaboration={openCollaboration} t={dockTranslate} />)
  if (grouped) await screen.findByText(dockTranslate('scope.count', { count: 1 }))
  else expect(f.call).not.toHaveBeenCalled()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByTestId('slark-scope-panel')).toBeNull()
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
  expect(openCollaboration).toHaveBeenCalledOnce()
  expect(f.insertAgent).not.toHaveBeenCalled()
  expect(f.call.mock.calls.every(([x]) => x.operation.kind !== 'apply')).toBe(true)
  view.unmount()
})

it.each([false, true])('a sidebar directory insertion closes only a fullscreen presentation (%s)', async (fullscreen) => {
  const f = fixture(true, true, ['one']), close = vi.fn()
  f.props.inputActions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 0 })
  const view = render(<ProjectScopePanel {...f.props} useTabInfo={panelRuntime('session', close, fullscreen).useTabInfo} />)
  fireEvent.click(await screen.findByTestId('slark-scope-mention-one-agent'))
  expect(f.insertAgent).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledTimes(fullscreen ? 1 : 0)
  view.unmount()
})

it('a failed narrow-screen insertion keeps the directory and original draft available', async () => {
  const f = fixture(true, true, ['one']), close = vi.fn()
  f.insertAgent.mockReturnValue(false)
  f.props.inputActions.captureInsertion = () => ({ start: 0, end: 0, draftRev: 0 })
  const view = render(<ProjectScopePanel {...f.props} useTabInfo={panelRuntime('session', close, true).useTabInfo} />)
  fireEvent.click(await screen.findByTestId('slark-scope-mention-one-agent'))
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByText(zh['scope.insertUnavailable'])).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: '产品空间' })).toBeTruthy()
  view.unmount()
})

it('the sidebar title uses localized copy and an existing decorative icon', () => {
  const view = render(<CollaborationTabTitle t={dockTranslate} />)
  expect(screen.getByText(zh['scope.title'])).toBeTruthy()
  expect(view.container.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
})
