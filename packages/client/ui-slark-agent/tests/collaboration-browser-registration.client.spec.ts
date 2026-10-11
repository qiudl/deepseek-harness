// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply } from '../src/client/index.ts'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import type { ConversationIndex, ConversationRow } from '../src/client/CollaborationBrowser.tsx'

const sessionId = SessionId('collaboration-session')
const workspaceId = '40000000-0000-4000-8000-000000000004'
const row: ConversationRow = {
  workspace_id: workspaceId, session_id: sessionId, first_source_at: '1', last_activity_at: '2',
  source_count: 1, pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
  first_pending_digest: null, pinned: false, archived: false,
}
type Bindings = {
  hooks: { collaborationIndex: { getSnapshot(): ConversationIndex } }
  openConversation(value: ConversationRow): void
  startConversation(): void
  currentWorkspaceId(): string | undefined
  togglePin(id: SessionId, pinned: boolean): Promise<void>
  renameConversation(id: SessionId, title: string): Promise<void>
  archiveConversation(id: SessionId): Promise<void>
  restoreConversation(id: SessionId): Promise<void>
}

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => { cleanup() })
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
  vi.restoreAllMocks()
})

function registration(withFocus = false) {
  let refreshTick: (() => void) | undefined
  vi.spyOn(window, 'setInterval').mockImplementation((callback) => {
    refreshTick = callback
    return 1 as never
  })
  const captured = new Map<string, () => Bindings>()
  const state = { phase: 'ready', state: 'idle', archivedSessionIds: [] as SessionId[],
    items: [{ workspaceId, sessionIds: [sessionId] }], dedicatedCollaborationSessionIds: [sessionId] }
  const openSession = vi.fn(), startCollaborationSession = vi.fn()
  const pinSession = vi.fn(async () => {}), unpinSession = vi.fn(async () => {})
  const rename = vi.fn(async () => {})
  const using = vi.fn(async (_id: SessionId, _source: unknown, callback: (reference: unknown) => Promise<void>) => {
    await callback({ binding: { session: { rename } } })
    return { ok: true as const, value: undefined }
  })
  const conversations = vi.fn(async () => ({ ok: true as const,
    value: { items: [row, { ...row, session_id: 'unrelated-session' }], global_pending_count: 0 } }))
  const archive = vi.fn(async (input: { action: string }) => ({
    state: input.action === 'archive' ? 'archived' as const : 'restored' as const,
  }))
  const host = { collaborationConversations: conversations, collaborationArchive: archive,
    collaborationScopeAvailable: withFocus, collaborationExecutionAvailable: withFocus,
    collaborationDeliveries: vi.fn(async () => ({ ok: false as const, errorCode: 'unavailable' })) }
  Reflect.set(window, '__DSH_DESKTOP_HOST__', host)
  const release = vi.fn()
  const sourceReads = vi.fn(async () => ({ ok: false as const, errorCode: 'unavailable' }))
  let activeSessionId: SessionId | undefined
  const sourceCtx = { fiber: { uid: 1 }, effect: (create: () => () => void) => {
    const cleanup = create(); cleanups.push(cleanup); return cleanup
  } }
  const binding = { sessionId, ctx: sourceCtx }
  const owner = { registerActivity: () => () => {} }
  const browserCtx = {
    workspaces: { list: { getSnapshot: () => state, subscribe: () => () => {} } },
    uiWorkspace: { openSession, startCollaborationSession, currentWorkspaceId: () => workspaceId,
      pinSession, unpinSession },
    sessions: { using },
    slots: { inject: (_name: string, register: () => void) => { register() },
      register: (options: { name: string; inject: () => Bindings }) => { captured.set(options.name, options.inject) } },
    effect: (create: () => (() => void) | undefined) => { const cleanup = create(); if (cleanup) cleanups.push(cleanup) },
  }
  const resultsCtx = {
    ...browserCtx,
    fiber: { uid: 1 },
    get: () => ({ generation: { getSnapshot: () => 1, subscribe: () => () => {} } }),
    remote: { session: { collaborationSources: sourceReads } },
    sessions: { ...browserCtx.sessions, binding: (id: SessionId) => id === sessionId ? binding : undefined },
    uiConversation: { binding: () => owner },
    chatTimeline: { register: () => () => {} },
    uiWorkspace: { ...browserCtx.uiWorkspace, currentSessionId: () => activeSessionId },
    slots: { inject: () => {} },
  }
  const ctx = {
    locale: { register: () => () => {}, bind: () => () => '' },
    effect: (create: () => (() => void) | undefined) => { const cleanup = create(); if (cleanup) cleanups.push(cleanup) },
    inject: (services: string[], callback: (value: typeof browserCtx) => void) => {
      if (services[0] === 'uiWorkspace') callback(browserCtx)
      if (services[0] === 'remote' && withFocus) callback(resultsCtx as never)
    },
    slots: { inject: () => {} },
    sessions: { retain: () => ({ release }) },
    get: () => ({ registerSource: () => () => {} }),
  }
  apply(ctx as never)
  const inject = captured.get('sidebar.collaboration')
  if (!inject) throw Error('collaboration slot missing')
  return { bindings: inject(), state, host, conversations, archive, using, rename,
    sourceReads, release, setActiveSession: (id: SessionId | undefined) => { activeSessionId = id },
    refresh: () => { refreshTick?.() },
    openSession, startCollaborationSession, pinSession, unpinSession }
}

it('registers one original Session and delegates pin, rename, archive and restore through owned bridges', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  expect(b.currentWorkspaceId()).toBe(workspaceId)
  b.startConversation()
  expect(f.startCollaborationSession).toHaveBeenCalledOnce()
  b.openConversation(row)
  expect(f.openSession).toHaveBeenCalledWith(sessionId)
  b.openConversation({ ...row, workspace_id: 'other' })
  expect(f.openSession).toHaveBeenCalledTimes(1)
  await b.togglePin(sessionId, false)
  expect(f.pinSession).toHaveBeenCalledWith(sessionId)
  expect(b.hooks.collaborationIndex.getSnapshot().items[0]?.pinned).toBe(true)
  await b.togglePin(sessionId, true)
  expect(f.unpinSession).toHaveBeenCalledWith(sessionId)
  await b.renameConversation(sessionId, 'New title')
  expect(f.using).toHaveBeenCalledWith(sessionId, { source: 'collaborationBrowserOperation' }, expect.any(Function))
  expect(f.rename).toHaveBeenCalledWith('New title')
  await b.archiveConversation(sessionId)
  expect(f.archive).toHaveBeenCalledWith({ workspace_id: workspaceId, session_id: sessionId, action: 'archive' })
  expect(b.hooks.collaborationIndex.getSnapshot().items[0]?.archived).toBe(true)
  await b.restoreConversation(sessionId)
  expect(f.archive).toHaveBeenCalledWith({ workspace_id: workspaceId, session_id: sessionId, action: 'restore' })
  expect(b.hooks.collaborationIndex.getSnapshot().items[0]?.archived).toBe(false)
  f.state.items.splice(0)
  await expect(b.togglePin(sessionId, false)).rejects.toThrow('collaboration_membership_changed')
  await expect(b.renameConversation(sessionId, 'Denied')).rejects.toThrow('collaboration_membership_changed')
})

it('locates a pending original only while its digest and active Session still match', async () => {
  const f = registration(true), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  const pending = { ...row, pending_count: 1, first_pending_digest: 'a'.repeat(64) }
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.sourceReads).toHaveBeenCalledOnce() })
  expect(f.release).toHaveBeenCalledOnce()
  f.sourceReads.mockImplementationOnce(async () => ({ ok: true, value: { items: [{
    snapshot_digest: 'b'.repeat(64), source: { workspace_id: workspaceId, session_id: sessionId },
  }] } } as never))
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.sourceReads).toHaveBeenCalledTimes(2) })
  f.sourceReads.mockImplementationOnce(async () => ({ ok: true, value: { items: [{
    snapshot_digest: pending.first_pending_digest, source: { workspace_id: workspaceId, session_id: sessionId },
  }] } } as never))
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.sourceReads).toHaveBeenCalledTimes(3) })
  expect(f.release).toHaveBeenCalledTimes(3)
  f.setActiveSession(sessionId)
  f.sourceReads.mockImplementationOnce(async () => ({ ok: true, value: { items: [{
    snapshot_digest: pending.first_pending_digest, source: { workspace_id: 'other', session_id: sessionId },
  }] } } as never))
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledTimes(4) })
})

it('keeps the index available only while the Host read succeeds and ignores revoked membership', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  f.conversations.mockImplementationOnce(async () => ({ ok: false, errorCode: 'unavailable' } as never))
  f.refresh()
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable') })
  f.conversations.mockImplementationOnce(async () => { throw Error('offline') })
  f.refresh()
  await vi.waitFor(() => { expect(f.conversations).toHaveBeenCalledTimes(3) })
  expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable')
  f.refresh()
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  f.state.items.splice(0)
  b.openConversation(row)
  expect(f.openSession).not.toHaveBeenCalled()
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_membership_changed')
  await expect(b.restoreConversation(sessionId)).rejects.toThrow('collaboration_membership_changed')
})

it('rejects stale archive and restore authority before updating the visible index', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  f.conversations.mockImplementationOnce(async () => ({ ok: false, errorCode: 'offline' } as never))
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  for (const blocked of [
    { ...row, archived: true }, { ...row, pending_count: 1 }, { ...row, planning_count: 1 },
    { ...row, running_count: 1 }, { ...row, issue_count: 1 },
  ]) {
    f.conversations.mockImplementationOnce(async () => ({ ok: true, value: { items: [blocked], global_pending_count: 0 } }))
    await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  }
  f.archive.mockImplementationOnce(async () => ({ state: 'conflict' as never }))
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  f.archive.mockImplementationOnce(async () => ({ state: 'retry_required' as never }))
  await expect(b.restoreConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  f.conversations.mockImplementationOnce(async () => {
    f.state.items.splice(0)
    return { ok: true, value: { items: [row], global_pending_count: 0 } }
  })
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_membership_changed')
})

it('rechecks archive eligibility and handles Host replacement without optimistic state', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  f.using.mockResolvedValueOnce({ ok: false, error: { message: 'rename denied' } } as never)
  await expect(b.renameConversation(sessionId, 'Denied')).rejects.toThrow('rename denied')
  Reflect.deleteProperty(f.host, 'collaborationArchive')
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  await expect(b.restoreConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  Reflect.set(f.host, 'collaborationArchive', f.archive)
  f.state.dedicatedCollaborationSessionIds.splice(0)
  f.conversations.mockResolvedValueOnce({ ok: true, value: { items: [], global_pending_count: 0 } })
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  f.state.dedicatedCollaborationSessionIds.push(sessionId)
  f.conversations.mockResolvedValueOnce({ ok: true, value: { items: [], global_pending_count: 0 } })
  await expect(b.archiveConversation(sessionId)).resolves.toBeUndefined()
  expect(f.archive).toHaveBeenCalledWith({ workspace_id: workspaceId, session_id: sessionId, action: 'archive' })
  f.archive.mockImplementationOnce(async () => {
    Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
    return { state: 'archived' as const }
  })
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  Reflect.set(window, '__DSH_DESKTOP_HOST__', f.host)
  f.archive.mockImplementationOnce(async () => {
    Reflect.set(window, '__DSH_DESKTOP_HOST__', {})
    return { state: 'restored' as const }
  })
  await expect(b.restoreConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  Reflect.set(window, '__DSH_DESKTOP_HOST__', f.host)
})

it('keeps index state fail closed when refresh and archive reads race', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.conversations>>>()
  f.conversations.mockImplementationOnce(() => pending.promise)
  f.refresh()
  f.refresh()
  expect(f.conversations).toHaveBeenCalledTimes(2)
  pending.resolve({ ok: false, errorCode: 'offline' } as never)
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable') })
  await b.togglePin(sessionId, false)
  expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable')
  await expect(b.restoreConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  await b.archiveConversation(sessionId)
  expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable')
})

it('drops a late Host refresh after its sidebar owner has disposed', async () => {
  for (const mode of ['resolve', 'reject'] as const) {
    const f = registration(), b = f.bindings
    await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.conversations>>>()
    f.conversations.mockImplementationOnce(() => pending.promise)
    f.refresh()
    expect(f.conversations).toHaveBeenCalledTimes(2)
    cleanups.splice(0).forEach((cleanup) => { cleanup() })
    f.refresh()
    expect(f.conversations).toHaveBeenCalledTimes(2)
    if (mode === 'resolve') pending.resolve({ ok: false, errorCode: 'offline' } as never)
    else pending.reject(Error('offline'))
    await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  }
})

it('checks the fallback Workspace and avoids restoring into a stale visible index', async () => {
  const f = registration(), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  Reflect.deleteProperty(f.state, 'dedicatedCollaborationSessionIds')
  await b.archiveConversation(sessionId)
  f.conversations.mockResolvedValueOnce({ ok: true, value: { items: [{ ...row, workspace_id: '' }],
    global_pending_count: 0 } })
  await expect(b.archiveConversation(sessionId)).rejects.toThrow('collaboration_archive_unavailable')
  f.archive.mockImplementationOnce(async () => {
    f.conversations.mockResolvedValueOnce({ ok: false, errorCode: 'offline' } as never)
    f.refresh()
    await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable') })
    return { state: 'restored' as const }
  })
  await b.restoreConversation(sessionId)
  expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('unavailable')
})

it('reveals a verified pending original only after the active Session and membership still match', async () => {
  const f = registration(true), b = f.bindings
  await vi.waitFor(() => { expect(b.hooks.collaborationIndex.getSnapshot().state).toBe('ready') })
  const digest = 'a'.repeat(64)
  const pending = { ...row, pending_count: 1, first_pending_digest: digest }
  const original = { snapshot_digest: digest, source: { workspace_id: workspaceId,
    session_id: sessionId, source_message_id: 'message', source_revision: '1' },
  original_message: 'Find the result', timeline_position: null }
  const reveal = vi.spyOn(CollaborationResultsModel.prototype, 'revealOriginal')
  const refresh = vi.spyOn(CollaborationResultsModel.prototype, 'refresh')
  f.sourceReads.mockResolvedValueOnce({ ok: true, value: { items: [original] } } as never)
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledOnce() })
  expect(reveal).not.toHaveBeenCalled()
  f.setActiveSession(sessionId)
  f.sourceReads.mockResolvedValueOnce({ ok: true, value: { items: [original] } } as never)
  b.openConversation(pending)
  await vi.waitFor(() => { expect(reveal).toHaveBeenCalledTimes(2) })
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(f.release).toHaveBeenCalledTimes(2)
  reveal.mockImplementationOnce(() => false)
  f.sourceReads.mockResolvedValueOnce({ ok: true, value: { items: [original] } } as never)
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledTimes(3) })
  expect(reveal).toHaveBeenCalledTimes(3)
  reveal.mockImplementationOnce(() => true).mockImplementationOnce(() => false)
  f.sourceReads.mockResolvedValueOnce({ ok: true, value: { items: [original] } } as never)
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledTimes(4) })
  expect(reveal).toHaveBeenCalledTimes(5)
  f.sourceReads.mockRejectedValueOnce(Error('read failed'))
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledTimes(5) })
  f.sourceReads.mockImplementationOnce(async () => {
    f.state.items.splice(0)
    return { ok: true, value: { items: [original] } } as never
  })
  b.openConversation(pending)
  await vi.waitFor(() => { expect(f.release).toHaveBeenCalledTimes(6) })
  expect(reveal).toHaveBeenCalledTimes(5)
})
