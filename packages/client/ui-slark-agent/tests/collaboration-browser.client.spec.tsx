// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { CollaborationBadge, CollaborationBrowser, CollaborationMobileTab } from '../src/client/CollaborationBrowser.tsx'
import type { ConversationIndex } from '../src/client/CollaborationBrowser.tsx'
import { en } from '../src/client/locales.ts'
import { createCollaborationBrowserStore } from '../src/client/collaboration-browser-store.ts'

afterEach(cleanup)

function viewingProps() {
  const store = createCollaborationBrowserStore().create()
  return { useStore: bindSnapshotSelector(store), actions: store.actions }
}

it('retains the all-workspace filter, search and scroll when returning from a mobile conversation', () => {
  const first = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const second = 'b15fc774-6fae-4795-9f55-f4be65e06846'
  const id = SessionId('return-to-collaboration-list')
  const openConversation = vi.fn()
  const props = {
    ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(createSnapshotStore<ConversationIndex>({
      state: 'ready', global_pending_count: 0, items: [{
        workspace_id: second, session_id: id, first_source_at: '1', last_activity_at: '2',
        source_count: 1, pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
        first_pending_digest: null, pinned: false, archived: false,
      }],
    })),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { [id]: { displayTitle: 'Review' } } }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', items: [
      { workspaceId: first, title: 'First', sessionIds: [] },
      { workspaceId: second, title: 'Second', sessionIds: [id] },
    ], dedicatedCollaborationSessionIds: [], archivedSessionIds: [], pinnedSessionIds: [] }),
    openConversation, startConversation: vi.fn(), currentWorkspaceId: () => first,
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(),
    t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0]
  const view = render(<CollaborationBrowser {...props} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Review' } })
  fireEvent.scroll(screen.getByRole('region'), { target: { scrollTop: 180 } })
  fireEvent.click(screen.getByRole('button', { name: /Review/ }))
  expect(openConversation).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: second, session_id: id }))
  view.unmount()
  const returned = render(<CollaborationBrowser {...props} />)
  expect({
    scope: screen.getByRole<HTMLSelectElement>('combobox').value,
    query: screen.getByRole<HTMLInputElement>('searchbox').value,
    scrollTop: screen.getByRole('region').scrollTop,
  }).toMatchInlineSnapshot(`
    {
      "query": "Review",
      "scope": "all",
      "scrollTop": 180,
    }
  `)
  expect(screen.getByRole('button', { name: /Review/ })).toBeTruthy()
  expect(props.currentWorkspaceId()).toBe(first)
  returned.unmount()
  render(<CollaborationBrowser {...props} {...viewingProps()} />)
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(first)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(screen.getByRole('region').scrollTop).toBe(0)
  expect(screen.queryByRole('button', { name: /Review/ })).toBeNull()
})

it('shows a Host-marked dedicated Session before its first accepted Source', () => {
  const sessionId = SessionId('dedicated-blank')
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 0, items: [] })
  const openConversation = vi.fn()
  render(<CollaborationBrowser {...({ ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(index),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: {
      [sessionId]: { displayTitle: 'New collaboration', updatedAt: 42 },
    } }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', items: [{
      workspaceId, title: 'North', sessionIds: [sessionId],
    }], dedicatedCollaborationSessionIds: [sessionId], archivedSessionIds: [], pinnedSessionIds: [] }),
    openConversation, startConversation: vi.fn(), currentWorkspaceId: () => workspaceId,
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(),
    t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  fireEvent.click(screen.getByRole('button', { name: /New collaboration/ }))
  expect(openConversation).toHaveBeenCalledWith(expect.objectContaining({
    session_id: sessionId, source_count: 0, pending_count: 0,
  }))
  act(() => { index.set({ state: 'unavailable', global_pending_count: 0, items: [] }) })
  expect(screen.getByRole('option', { name: 'North · — pending' })).toBeTruthy()
})

it('starts a mobile collaboration in the workspace selected from the sidebar', () => {
  const first = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const second = 'b15fc774-6fae-4795-9f55-f4be65e06846'
  const startConversation = vi.fn()
  render(<CollaborationBrowser {...({ ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(createSnapshotStore<ConversationIndex>({
      state: 'ready', global_pending_count: 0, items: [],
    })),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: {} }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', items: [
      { workspaceId: first, title: 'First', sessionIds: [] },
      { workspaceId: second, title: 'Second', sessionIds: [] },
    ], dedicatedCollaborationSessionIds: [], archivedSessionIds: [], pinnedSessionIds: [] }),
    openConversation: vi.fn(), startConversation, currentWorkspaceId: () => undefined,
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(),
    t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  fireEvent.click(screen.getByRole('button', { name: '＋ New' }))
  expect(startConversation).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('Choose a workspace')
  fireEvent.change(screen.getByRole('combobox', { name: 'Collaboration workspace' }), { target: { value: second } })
  fireEvent.click(screen.getByRole('button', { name: '＋ New' }))
  expect(startConversation).toHaveBeenCalledWith(second)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the global pending badge, groups one conversation once, and opens its original Session', async () => {
  const sessionId = SessionId('source-session')
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 2, items: [{
    workspace_id: 'a15fc774-6fae-4795-9f55-f4be65e06846', session_id: sessionId,
    first_source_at: '1', last_activity_at: '2', source_count: 2, pending_count: 2,
    planning_count: 0, running_count: 0, issue_count: 0, first_pending_digest: 'a'.repeat(64), pinned: false, archived: false,
  }] })
  const useCollaborationIndex = bindSnapshotSelector(index)
  const openConversation = vi.fn()
  const togglePin = vi.fn().mockResolvedValue(undefined)
  const t = makeTranslate(en)
  const props = {
    ...viewingProps(),
    useCollaborationIndex,
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { [sessionId]: { displayTitle: 'Release review' } } }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', dedicatedCollaborationSessionIds: [], pinnedSessionIds: [], archivedSessionIds: [], items: [{
      workspaceId: 'a15fc774-6fae-4795-9f55-f4be65e06846', title: 'North', sessionIds: [sessionId],
    }] }),
    openConversation, startConversation: vi.fn(), currentWorkspaceId: () => undefined, togglePin,
    renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(), t,
  } as Parameters<typeof CollaborationBrowser>[0]
  render(<CollaborationBrowser {...props} />)
  expect(screen.getByText('2 items need attention')).toBeTruthy()
  expect(screen.getAllByText('Release review')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /Release review/ }))
  expect(openConversation).toHaveBeenCalledWith(index.getSnapshot().items[0])
  fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
  expect(togglePin).toHaveBeenCalledWith(sessionId, false)
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Pin' }).hasAttribute('disabled')).toBe(false) })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(screen.getByText('No matching collaboration conversations')).toBeTruthy()
  act(() => {
    index.set({ state: 'ready', global_pending_count: 0,
      items: [{ ...index.getSnapshot().items[0]!, archived: true, pinned: false,
        pending_count: 0, first_pending_digest: null }] })
  })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Release' } })
  expect(screen.getAllByText('Archived').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(props.restoreConversation).toHaveBeenCalledWith(sessionId)
  cleanup()
  index.set({ state: 'ready', global_pending_count: 2,
    items: [{ ...index.getSnapshot().items[0]!, archived: false,
      pending_count: 2, first_pending_digest: 'a'.repeat(64) }] })
  const mobileProps = { active: false, open: vi.fn(), useCollaborationIndex,
    useWorkspaces: props.useWorkspaces, t } as Parameters<typeof CollaborationMobileTab>[0]
  render(<CollaborationMobileTab {...mobileProps} />)
  expect(screen.getByText('2')).toBeTruthy()
  act(() => { index.set({ state: 'unavailable', items: [], global_pending_count: 0 }) })
  expect(screen.getByLabelText('Pending count unavailable')).toBeTruthy()
})

it('surfaces new work in an archived conversation and offers restore', () => {
  const sessionId = SessionId('archived-with-work')
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 1, items: [{
    workspace_id: workspaceId, session_id: sessionId, first_source_at: '1', last_activity_at: '2',
    source_count: 1, pending_count: 1, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: 'a'.repeat(64), pinned: false, archived: true,
  }] })
  const restoreConversation = vi.fn().mockResolvedValue(undefined)
  const workspaces = createSnapshotStore({ phase: 'ready', items: [{
    workspaceId, title: 'North', sessionIds: [sessionId],
  }], dedicatedCollaborationSessionIds: [] as SessionId[], archivedSessionIds: [sessionId], pinnedSessionIds: [] as SessionId[] })
  render(<CollaborationBrowser {...({ ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(index),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: {
      [sessionId]: { displayTitle: 'Needs restoring', updatedAt: 2 },
    } }),
    useWorkspaces: bindSnapshotSelector(workspaces),
    openConversation: vi.fn(), startConversation: vi.fn(), currentWorkspaceId: () => workspaceId,
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation,
    t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  expect(screen.getByText('1 items need attention')).toBeTruthy()
  expect(screen.getByText('Archived · new work, restore to continue')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
  expect(restoreConversation).toHaveBeenCalledWith(sessionId)
  act(() => { workspaces.set({ ...workspaces.getSnapshot(), items: [{ workspaceId, title: 'North', sessionIds: [] }] }) })
  expect(screen.queryByText('Needs restoring')).toBeNull()
})

it('removes a revoked local Session from the badge before the next cloud poll', () => {
  const sessionId = SessionId('revoked-session')
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 2, items: [{
    workspace_id: workspaceId, session_id: sessionId, first_source_at: '1', last_activity_at: '2',
    source_count: 1, pending_count: 2, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: 'a'.repeat(64), pinned: false, archived: false,
  }] })
  const workspaces = createSnapshotStore({ phase: 'ready', items: [{
    workspaceId, title: 'North', sessionIds: [sessionId],
  }] })
  const props = { useCollaborationIndex: bindSnapshotSelector(index),
    useWorkspaces: bindSnapshotSelector(workspaces), t: makeTranslate(en) } as Parameters<typeof CollaborationBadge>[0]
  render(<CollaborationBadge {...props} />)
  expect(screen.getByText('2')).toBeTruthy()
  act(() => { workspaces.set({ phase: 'ready', items: [{ workspaceId, title: 'North', sessionIds: [] }] }) })
  expect(screen.queryByText('2')).toBeNull()
})

it('groups owned work, filters by workspace and title, and completes rename and archive controls', async () => {
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const otherWorkspaceId = 'b15fc774-6fae-4795-9f55-f4be65e06846'
  const base = {
    workspace_id: workspaceId, first_source_at: '1', last_activity_at: '2', source_count: 1,
    pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: null, pinned: false, archived: false,
  }
  const ids = ['pending', 'issue', 'running', 'planning', 'draft', 'finished', 'archive', 'other'] as const
  const rows = [
    { ...base, session_id: ids[0], pending_count: 2, pinned: true },
    { ...base, session_id: ids[1], issue_count: 1 },
    { ...base, session_id: ids[2], running_count: 1 },
    { ...base, session_id: ids[3], planning_count: 1 },
    { ...base, session_id: ids[4], source_count: 0 },
    { ...base, session_id: ids[5] },
    { ...base, session_id: ids[6], archived: true },
    { ...base, session_id: ids[7], workspace_id: otherWorkspaceId, last_activity_at: '3' },
  ]
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 2, items: rows })
  const sessions = { byId: Object.fromEntries(ids.map(id => [id, { displayTitle: `Topic ${id}`, updatedAt: 3 }])) }
  const workspaces = { phase: 'ready', dedicatedCollaborationSessionIds: [] as SessionId[],
    pinnedSessionIds: [] as SessionId[], archivedSessionIds: [] as SessionId[], items: [
      { workspaceId, title: 'North', sessionIds: ids.slice(0, 7).map(SessionId) },
      { workspaceId: otherWorkspaceId, title: 'South', sessionIds: [SessionId(ids[7])] },
    ] }
  const renameConversation = vi.fn(async () => {}), archiveConversation = vi.fn(async () => {})
  const startConversation = vi.fn(), togglePin = vi.fn(async () => {})
  render(<CollaborationBrowser {...({ ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(index),
    useSessions: (select: (value: unknown) => unknown) => select(sessions),
    useWorkspaces: (select: (value: unknown) => unknown) => select(workspaces),
    openConversation: vi.fn(), startConversation, currentWorkspaceId: () => workspaceId,
    togglePin, renameConversation, archiveConversation, restoreConversation: vi.fn(), t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  expect(screen.getByText(/Topic pending/)).toBeTruthy()
  expect(screen.getByText('Topic issue')).toBeTruthy()
  expect(screen.getByText('Topic running')).toBeTruthy()
  expect(screen.getByText('Topic planning')).toBeTruthy()
  expect(screen.getByText('Topic draft')).toBeTruthy()
  expect(screen.getByText('Topic finished')).toBeTruthy()
  expect(screen.queryByText('Topic archive')).toBeNull()
  expect(screen.queryByText('Topic other')).toBeNull()
  expect(screen.getByText('1 items need review')).toBeTruthy()
  expect(screen.getAllByText('Task execution or result sync in progress').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '＋ New' }))
  expect(startConversation).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByRole('combobox', { name: 'Collaboration workspace' }), { target: { value: 'all' } })
  expect(screen.getByText('Topic other')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'archive' } })
  expect(screen.getByText('Topic archive')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Topic finished' } })
  const shell = screen.getByRole('button', { name: /Topic finished/ }).parentElement!
  expect(within(shell).getByText('Completed')).toBeTruthy()
  fireEvent.click(within(shell).getByRole('button', { name: 'Rename' }))
  const edit = within(shell).getByRole('textbox', { name: 'Rename' })
  fireEvent.keyDown(edit, { key: 'a' })
  fireEvent.click(within(shell).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(shell).getByRole('button', { name: 'Rename' }))
  fireEvent.change(within(shell).getByRole('textbox', { name: 'Rename' }), { target: { value: '  Updated topic  ' } })
  fireEvent.click(within(shell).getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(renameConversation).toHaveBeenCalledWith(SessionId('finished'), 'Updated topic') })
  await waitFor(() => { expect(within(shell).queryByRole('textbox', { name: 'Rename' })).toBeNull() })
  fireEvent.click(within(shell).getByRole('button', { name: 'Archive' }))
  expect(within(shell).getByText('You can restore this conversation from search. Archiving waits until work is finished.')).toBeTruthy()
  fireEvent.click(within(shell).getAllByRole('button', { name: 'Archive' })[1]!)
  await waitFor(() => { expect(archiveConversation).toHaveBeenCalledWith(SessionId('finished')) })
  await waitFor(() => { expect(within(shell).queryByText('You can restore this conversation from search. Archiving waits until work is finished.')).toBeNull() })
})

it('bounds mobile and desktop badges, exposes unavailable states, and starts from the mobile tab', () => {
  const id = SessionId('many-pending'), workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 101, items: [{
    workspace_id: workspaceId, session_id: id, first_source_at: '1', last_activity_at: '2',
    source_count: 1, pending_count: 101, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: null, pinned: false, archived: false,
  }] })
  const workspaces = createSnapshotStore({ phase: 'ready', items: [{ workspaceId, sessionIds: [id] }] })
  const shared = { useCollaborationIndex: bindSnapshotSelector(index),
    useWorkspaces: bindSnapshotSelector(workspaces), t: makeTranslate(en) }
  const open = vi.fn()
  render(<><CollaborationBadge {...(shared as Parameters<typeof CollaborationBadge>[0])} />
    <CollaborationMobileTab {...({ ...shared, active: true, open } as Parameters<typeof CollaborationMobileTab>[0])} /></>)
  expect(screen.getAllByText('99+')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: /Collaboration/ }))
  expect(open).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: /Collaboration/ }).getAttribute('aria-current')).toBe('page')
  act(() => { index.set({ ...index.getSnapshot(), items: [...index.getSnapshot().items,
    { ...index.getSnapshot().items[0]!, workspace_id: 'unowned' }] }) })
  expect(screen.getAllByText('99+')).toHaveLength(2)
  act(() => { workspaces.set({ phase: 'loading', items: [{ workspaceId, sessionIds: [id] }] }) })
  expect(screen.getAllByLabelText('Pending count unavailable')).toHaveLength(2)
  act(() => { index.set({ state: 'loading', global_pending_count: 0, items: [] }) })
  expect(screen.getAllByLabelText('Pending count unavailable')).toHaveLength(2)
})

it('handles empty, fallback, cancel, and failed actions without losing the list', async () => {
  const id = SessionId('fallback'), workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const row = { workspace_id: workspaceId, session_id: id, first_source_at: '1', last_activity_at: '2',
    source_count: 1, pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: null, pinned: false, archived: false }
  const index = createSnapshotStore<ConversationIndex>({ state: 'loading', global_pending_count: 0, items: [] })
  const togglePin = vi.fn(async () => { throw Error('offline') })
  const renameConversation = vi.fn(async () => {})
  render(<CollaborationBrowser {...({ ...viewingProps(), useCollaborationIndex: bindSnapshotSelector(index),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: {} }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', items: [{
      workspaceId, title: '', sessionIds: [id],
    }], dedicatedCollaborationSessionIds: [id, SessionId('missing')], pinnedSessionIds: [], archivedSessionIds: [] }),
    openConversation: vi.fn(), startConversation: vi.fn(), currentWorkspaceId: () => undefined,
    togglePin, renameConversation, archiveConversation: vi.fn(), restoreConversation: vi.fn(), t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  expect(screen.getByText('Loading collaboration conversations…')).toBeTruthy()
  act(() => { index.set({ state: 'unavailable', global_pending_count: 0, items: [] }) })
  expect(screen.getByText('Collaboration list is unavailable. Try again later.')).toBeTruthy()
  act(() => { index.set({ state: 'ready', global_pending_count: 0, items: [] }) })
  expect(screen.getByText('No recent collaboration conversations. Start with @Agent or search the archive.')).toBeTruthy()
  act(() => { index.set({ state: 'ready', global_pending_count: 0, items: [row] }) })
  expect(screen.getByText('Untitled collaboration conversation')).toBeTruthy()
  const shell = screen.getByRole('button', { name: /Untitled collaboration conversation/ }).parentElement!
  fireEvent.click(within(shell).getByRole('button', { name: 'Pin' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Action failed') })
  fireEvent.click(within(shell).getByRole('button', { name: 'Rename' }))
  expect(within(shell).getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(within(shell).getByRole('textbox', { name: 'Rename' }), { target: { value: '  ' } })
  fireEvent.submit(within(shell).getByRole('textbox', { name: 'Rename' }).closest('form')!)
  expect(renameConversation).not.toHaveBeenCalled()
  fireEvent.keyDown(within(shell).getByRole('textbox', { name: 'Rename' }), { key: 'Escape' })
  expect(within(shell).queryByRole('textbox', { name: 'Rename' })).toBeNull()
  fireEvent.click(within(shell).getByRole('button', { name: 'Archive' }))
  fireEvent.click(within(shell).getByRole('button', { name: 'Cancel' }))
  expect(within(shell).queryByText('You can restore this conversation from search. Archiving waits until work is finished.')).toBeNull()
})

it('uses the fallback workspace label and keeps sorted rows stable for equal activity', () => {
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const ids = [SessionId('one'), SessionId('two'), SessionId('three')]
  const base = { workspace_id: workspaceId, first_source_at: '1', source_count: 1,
    pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: null, pinned: false, archived: false }
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 0, items: [
    { ...base, session_id: ids[0]!, last_activity_at: '3' },
    { ...base, session_id: ids[1]!, last_activity_at: '1' },
    { ...base, session_id: ids[2]!, last_activity_at: '1' },
  ] })
  render(<CollaborationBrowser {...({ ...viewingProps(), useCollaborationIndex: bindSnapshotSelector(index),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: {} }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready',
      items: [{ workspaceId, title: undefined, sessionIds: ids }], pinnedSessionIds: [], archivedSessionIds: [] }),
    openConversation: vi.fn(), startConversation: vi.fn(), currentWorkspaceId: () => undefined,
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(), t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  expect(screen.getAllByText(/Workspace ·/)).toHaveLength(3)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'one' } })
  expect(screen.getByText('Untitled collaboration conversation')).toBeTruthy()
})

it('orders pending first, then pinned and recent conversations across execution states', async () => {
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const base = { workspace_id: workspaceId, first_source_at: '1', source_count: 1,
    pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: null, pinned: false, archived: false }
  const items = [
    { ...base, session_id: 'finished-pin', last_activity_at: '1', pinned: true },
    { ...base, session_id: 'running', last_activity_at: '20', running_count: 1 },
    { ...base, session_id: 'draft-pin', last_activity_at: '2', source_count: 0, pinned: true },
    { ...base, session_id: 'issue', last_activity_at: '40', issue_count: 1 },
    { ...base, session_id: 'finished', last_activity_at: '50' },
    { ...base, session_id: 'planning', last_activity_at: '30', planning_count: 1 },
    { ...base, session_id: 'draft', last_activity_at: '10', source_count: 0 },
    { ...base, session_id: 'pending-old', last_activity_at: '90', pending_count: 1 },
    { ...base, session_id: 'pending-new', last_activity_at: '100', pending_count: 1 },
    { ...base, session_id: 'pending-pin', last_activity_at: '1', pending_count: 1, pinned: true },
    { ...base, session_id: 'archived', last_activity_at: '200', pinned: true, archived: true },
  ]
  render(<CollaborationBrowser {...({ ...viewingProps(),
    useCollaborationIndex: bindSnapshotSelector(createSnapshotStore<ConversationIndex>({
      state: 'ready', items, global_pending_count: 3,
    })),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: Object.fromEntries(
      items.map(row => [row.session_id, { displayTitle: `Order ${row.session_id}` }]),
    ) }),
    useWorkspaces: (select: (value: unknown) => unknown) => select({ phase: 'ready', items: [
      { workspaceId, title: 'Workspace', sessionIds: items.map(row => SessionId(row.session_id)) },
    ], dedicatedCollaborationSessionIds: [], archivedSessionIds: [], pinnedSessionIds: [] }),
    currentWorkspaceId: () => workspaceId, openConversation: vi.fn(), startConversation: vi.fn(),
    togglePin: vi.fn(), renameConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(),
    t: makeTranslate(en),
  } as Parameters<typeof CollaborationBrowser>[0])} />)
  const rowTitles = () => screen.getAllByRole('button').flatMap((button) => {
    const title = button.querySelector('span')?.textContent
    return title?.includes('Order ') ? [title.replace(/^◆ /u, '')] : []
  })
  expect(rowTitles()).toEqual(['Order pending-pin', 'Order pending-new', 'Order pending-old',
    'Order draft-pin', 'Order finished-pin', 'Order finished', 'Order issue', 'Order planning',
    'Order running', 'Order draft'])
  expect(screen.getByText('1 items need review')).toBeTruthy()
  expect(screen.getAllByText('Task execution or result sync in progress')).toHaveLength(2)
  for (const id of ['pending-pin', 'issue', 'planning', 'running']) {
    const row = screen.getByRole('button', { name: new RegExp(`Order ${id}`, 'u') })
    expect(within(row.parentElement!).getByRole('button', { name: 'Archive' }).hasAttribute('disabled')).toBe(true)
  }
  await expect(rowTitles().join('\n') + '\n').toMatchFileSnapshot('./expected/collaboration-browser-order.expected.txt')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Order' } })
  expect(rowTitles().at(-1)).toBe('Order archived')
  const archived = screen.getByRole('button', { name: /Order archived/ })
  expect(archived.hasAttribute('disabled')).toBe(true)
  expect(within(archived.parentElement!).getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false)
})
