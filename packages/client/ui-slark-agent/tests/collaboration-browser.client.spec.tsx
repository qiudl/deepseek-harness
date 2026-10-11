// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { CollaborationBadge, CollaborationBrowser, CollaborationMobileTab } from '../src/client/CollaborationBrowser.tsx'
import type { ConversationIndex } from '../src/client/CollaborationBrowser.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('shows a Host-marked dedicated Session before its first accepted Source', () => {
  const sessionId = SessionId('dedicated-blank')
  const workspaceId = 'a15fc774-6fae-4795-9f55-f4be65e06846'
  const index = createSnapshotStore<ConversationIndex>({ state: 'ready', global_pending_count: 0, items: [] })
  const openConversation = vi.fn()
  render(<CollaborationBrowser {...({
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
  render(<CollaborationBrowser {...({
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
