// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { ProjectScopeModel } from '../src/client/project-scope.ts'
import type { WorkspaceBridge } from '../src/client/project-scope.ts'
import { ProjectScopeDock } from '../src/client/ProjectScopeDock.tsx'
import { zh } from '../src/client/locales.ts'

const workspaceId = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
afterEach(cleanup)
function fixture(grouped = true) {
  let selected: readonly string[] = [], version = 0
  const call = vi.fn(async (input: Parameters<NonNullable<WorkspaceBridge['collaborationWorkspace']>>[0]) => {
    const op = input.operation
    if (op.kind === 'apply') { selected = op.selected_project_ids; version++ }
    if (op.kind === 'get' || op.kind === 'apply') return { ok: true as const,
      value: { workspace_id: workspaceId, version: String(version), selected_project_ids: selected } }
    if (op.kind === 'projects') return { ok: true as const, value: { items: [
      { project_id: 'one', project_name: '产品空间' }, { project_id: 'two', project_name: '研发空间' },
    ], next_cursor: null } }
    return { ok: true as const, value: { items: selected.length ? [{ project_id: 'one', project_name: '产品空间',
      agent_id: 'agent', agent_name: '<script>Guide', available: false as const,
      capability_snapshot: 'a'.repeat(64), reason_code: 'executor_unavailable' }] : [],
    next_cursor: null, scope_version: String(version) } }
  })
  const bridge = { collaborationWorkspace: call }
  const workspaces = { getSnapshot: () => ({ phase: 'ready', state: 'idle', archivedSessionIds: [],
    items: grouped ? [{ workspaceId, sessionIds: ['session'] }] : [] }), subscribe: () => () => undefined } as unknown as WorkspaceSource
  const model = new ProjectScopeModel('session' as never, workspaces, () => bridge)
  const props = { useSlarkScope: <T,>(selector: (s: ReturnType<typeof model.getSnapshot>) => T) =>
    selector(useSyncExternalStore(model.subscribe, model.getSnapshot)),
  refreshScope: () => model.refresh(), applyScope: (ids: readonly string[]) => model.apply(ids),
  loadProjects: () => model.loadProjects(), loadAgents: () => model.loadAgents(),
  t: (key: keyof typeof zh, params?: Record<string, unknown>) => {
    let value: string = zh[key]; for (const [name, item] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(item))
    return value
  } } as unknown as Parameters<typeof ProjectScopeDock>[0]
  return { model, call, props }
}
it('optional collaboration area supports multi-select, apply and explicit clear with Agent space labels', async () => {
  const f = fixture(), view = render(<ProjectScopeDock {...f.props} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
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
it('cancel discards the local selection without saving or clearing the authority', async () => {
  const f = fixture(), view = render(<ProjectScopeDock {...f.props} />)
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
  fireEvent.click(await screen.findByRole('checkbox', { name: '产品空间' }))
  fireEvent.click(screen.getByTestId('slark-scope-cancel'))
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
  expect((screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' })).checked).toBe(false)
  expect(f.call.mock.calls.every(([x]) => x.operation.kind !== 'apply')).toBe(true)
  view.unmount(); f.model.dispose()
})
it('ungrouped Session makes no range requests and names the required workspace', () => {
  const f = fixture(false), view = render(<ProjectScopeDock {...f.props} />)
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
  expect(screen.getByText(zh['scope.ungrouped'])).toBeTruthy()
  expect(f.call).not.toHaveBeenCalled(); expect(screen.queryByRole('checkbox')).toBeNull()
  view.unmount(); f.model.dispose()
})
it('save conflict replaces the stale selection, shows recovery copy, and does not replay', async () => {
  const f = fixture(), view = render(<ProjectScopeDock {...f.props} />)
  fireEvent.click(screen.getByTestId('slark-scope-toggle'))
  fireEvent.click(await screen.findByRole('checkbox', { name: '产品空间' }))
  f.call.mockImplementationOnce(async () => ({ ok: false, errorCode: 'scope_conflict', refreshRequired: true }) as never)
  await act(async () => { fireEvent.click(screen.getByTestId('slark-scope-apply')) })
  await screen.findByText(zh['scope.conflict'])
  await waitFor(() => { expect((screen.getByRole<HTMLInputElement>('checkbox', { name: '产品空间' })).checked).toBe(false) })
  expect(f.call.mock.calls.filter(([x]) => x.operation.kind === 'apply')).toHaveLength(1)
  view.unmount(); f.model.dispose()
})
