/** Host-verified collaboration conversation index in the left sidebar. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { createCollaborationBrowserStore } from './collaboration-browser-store.ts'
import css from './CollaborationBrowser.module.css'

export interface ConversationRow {
  workspace_id: string
  session_id: string
  first_source_at: string
  last_activity_at: string
  source_count: number
  pending_count: number
  planning_count: number
  running_count: number
  issue_count: number
  first_pending_digest: string | null
  pinned: boolean
  archived: boolean
}
export interface ConversationIndex {
  state: 'loading' | 'ready' | 'unavailable'
  items: readonly ConversationRow[]
  global_pending_count: number
}
export interface BrowserInjected {
  hooks: { collaborationIndex: ObservableSnapshot<ConversationIndex> }
  openConversation(row: ConversationRow): void
  startConversation(workspaceId: string): void
  currentWorkspaceId(): string | undefined
  togglePin(sessionId: SessionId, pinned: boolean): Promise<void>
  renameConversation(sessionId: SessionId, title: string): Promise<void>
  archiveConversation(sessionId: SessionId): Promise<void>
  restoreConversation(sessionId: SessionId): Promise<void>
}

function hasActiveCollaboration(row: ConversationRow): boolean {
  return row.pending_count > 0 || row.planning_count > 0 || row.running_count > 0 || row.issue_count > 0
}

/** Read only the visible original Sessions; the list may contain up to 500 rows. */
function GroupStatus({ row, t }: { row: ConversationRow; t: PropsLocale<'slarkAgent'>['t'] }) {
  const element = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState<'preparing' | 'group_active'>()
  useEffect(() => {
    const host = window.__DSH_DESKTOP_HOST__
    if (!host?.collaborationGroupPreparation) return
    const lookupGroup = host.collaborationGroupPreparation.bind(host)
    let active = true, visible = false, busy = false
    let timer: number | undefined
    const stillActive = () => active
    const refresh = async () => {
      if (!active || !visible || busy) return
      if (window.__DSH_DESKTOP_HOST__ !== host) { setState(undefined); return }
      busy = true
      try {
        const result = await lookupGroup({ operation: 'lookup',
          workspace_id: row.workspace_id, session_id: row.session_id })
        if (stillActive() && window.__DSH_DESKTOP_HOST__ === host) {
          setState(result.state === 'preparing' || result.state === 'group_active' ? result.state : undefined)
        }
      } catch { if (stillActive()) setState(undefined) }
      finally { busy = false }
    }
    const show = () => {
      if (visible) return
      visible = true
      void refresh()
      timer = window.setInterval(() => { void refresh() }, 20_000)
    }
    const hide = () => {
      visible = false
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) show()
      else hide()
    }, { rootMargin: '100px' })
    if (observer && element.current) observer.observe(element.current)
    else show()
    return () => { active = false; hide(); observer?.disconnect() }
  }, [row.workspace_id, row.session_id])
  return <span ref={element} className={state === 'group_active' ? css.groupActive : state === 'preparing' ? css.groupPreparing : undefined}>
    {state === 'group_active' ? t('browser.groupActive') : state === 'preparing' ? t('browser.groupPreparing') : null}
  </span>
}

export function CollaborationBadge({ useCollaborationIndex, useWorkspaces, t }: PropsRuntime<'sidebar.collaboration.badge'> & PropsLocale<'slarkAgent'> & InjectFace<Pick<BrowserInjected, 'hooks'>>) {
  const index = useCollaborationIndex(value => value)
  const workspaces = useWorkspaces(value => value)
  if (index.state !== 'ready' || workspaces.phase !== 'ready') return <span className={css.unknownBadge} aria-label={t('browser.countUnavailable')}>—</span>
  const owned = new Set(workspaces.items.flatMap(workspace => workspace.sessionIds.map(id => `${workspace.workspaceId}\0${id}`)))
  const count = index.items.reduce((sum, row) => sum + (owned.has(`${row.workspace_id}\0${row.session_id}`) ? row.pending_count : 0), 0)
  return count > 0 ? <span className={css.badge} aria-label={t('browser.badge', { count })}>{count > 99 ? '99+' : count}</span> : null
}

export function CollaborationMobileTab({ active, open, useCollaborationIndex, useWorkspaces, t }:
  PropsRuntime<'shell.mobile.collaboration'> & PropsLocale<'slarkAgent'> & InjectFace<Pick<BrowserInjected, 'hooks'>>) {
  const index = useCollaborationIndex(value => value)
  const workspaces = useWorkspaces(value => value)
  const owned = new Set(workspaces.items.flatMap(workspace => workspace.sessionIds.map(id => `${workspace.workspaceId}\0${id}`)))
  const count = index.items.reduce((sum, row) => sum + (owned.has(`${row.workspace_id}\0${row.session_id}`) ? row.pending_count : 0), 0)
  return <button type="button" aria-current={active ? 'page' : undefined} onClick={open}>
    {t('browser.mobileTab')} {index.state !== 'ready' || workspaces.phase !== 'ready'
      ? <span className={css.unknownBadge} aria-label={t('browser.countUnavailable')}>—</span>
      : count > 0 && <span className={css.badge} aria-label={t('browser.badge', { count })}>{count > 99 ? '99+' : count}</span>}
  </button>
}

export function CollaborationBrowser({ useCollaborationIndex, useSessions, useWorkspaces,
  openConversation, startConversation, currentWorkspaceId, togglePin, renameConversation,
  archiveConversation, restoreConversation, useStore, actions, t }:
  PropsRuntime<'sidebar.collaboration'> & PropsLocale<'slarkAgent'> & InjectFace<BrowserInjected>
  & PropsStore<ReturnType<typeof createCollaborationBrowserStore>>) {
  const index = useCollaborationIndex(value => value)
  const sessions = useSessions(value => value)
  const workspacesState = useWorkspaces(value => value)
  const workspaces = workspacesState.items
  const { query, scope: savedScope, scrollTop } = useStore(value => value)
  const [initialScope] = useState(() => currentWorkspaceId() ?? 'all')
  const scope = savedScope ?? initialScope
  const [editing, setEditing] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [archiving, setArchiving] = useState<string | null>(null)
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [workspaceRequired, setWorkspaceRequired] = useState(false)
  const start = (): void => {
    const workspaceId = scope === 'all' ? currentWorkspaceId() : scope
    if (!workspaceId || !workspaces.some(item => item.workspaceId === workspaceId)) {
      setWorkspaceRequired(true)
      return
    }
    setWorkspaceRequired(false)
    startConversation(workspaceId)
  }
  const run = async (action: () => Promise<void>, done: () => void): Promise<void> => {
    setBusy(true); setActionError(false)
    try { await action(); done() } catch { setActionError(true) } finally { setBusy(false) }
  }
  const workspaceNames = useMemo(() => new Map(workspaces.map(row => [row.workspaceId, row.title])), [workspaces])
  const displayItems = useMemo(() => {
    const owned = new Set(workspaces.flatMap(workspace => workspace.sessionIds.map(id => `${workspace.workspaceId}\0${id}`)))
    const items = index.items.filter(item => owned.has(`${item.workspace_id}\0${item.session_id}`))
    const indexed = new Set(items.map(item => item.session_id))
    for (const sessionId of workspacesState.dedicatedCollaborationSessionIds ?? []) {
      if (indexed.has(sessionId)) continue
      const workspace = workspaces.find(item => item.sessionIds.includes(sessionId))
      const session = sessions.byId[sessionId]
      if (!workspace || !session) continue
      const updated = String(session.updatedAt)
      items.push({ workspace_id: workspace.workspaceId, session_id: sessionId,
        first_source_at: updated, last_activity_at: updated, source_count: 0,
        pending_count: 0, planning_count: 0, running_count: 0, issue_count: 0,
        first_pending_digest: null, pinned: workspacesState.pinnedSessionIds.includes(sessionId),
        archived: workspacesState.archivedSessionIds.includes(sessionId) })
    }
    return items
  }, [index.items, sessions, workspaces, workspacesState])
  const visiblePendingCount = displayItems.reduce((sum, item) => sum + item.pending_count, 0)
  const groups = useMemo(() => {
    const pending: ConversationRow[] = [], recent: ConversationRow[] = [], archived: ConversationRow[] = []
    for (const item of displayItems) {
      if (scope !== 'all' && scope !== item.workspace_id) continue
      if (item.archived && !hasActiveCollaboration(item) && !query.trim()) continue
      const title = sessions.byId[item.session_id as SessionId]?.displayTitle ?? item.session_id
      if (query && !`${title} ${workspaceNames.get(item.workspace_id as WorkspaceId) ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
      if (item.archived && !hasActiveCollaboration(item)) archived.push(item)
      else if (item.pending_count > 0) pending.push(item)
      else recent.push(item)
    }
    const sort = (a: ConversationRow, b: ConversationRow) => Number(b.pinned) - Number(a.pinned)
      || (BigInt(b.last_activity_at) > BigInt(a.last_activity_at) ? 1 : BigInt(b.last_activity_at) < BigInt(a.last_activity_at) ? -1 : 0)
    return [pending.sort(sort), recent.sort(sort), archived.sort(sort)] as const
  }, [displayItems, sessions, workspaceNames, query, scope])
  const headings = [t('browser.pending'), t('browser.recent'), t('browser.archived')] as const
  return <section ref={(element) => { if (element) element.scrollTop = scrollTop }} className={css.root} aria-label={t('browser.title')}
    onScroll={(event) => { actions.setScrollTop(event.currentTarget.scrollTop) }}>
    <div className={css.top}><strong>{t('browser.title')}</strong><button type="button" onClick={start}>{t('browser.new')}</button></div>
    <select className={css.scope} value={scope} onChange={(event) => { actions.setScope(event.target.value); setWorkspaceRequired(false) }} aria-label={t('browser.scope')}>
      <option value="all">{t('browser.all', { count: index.state === 'ready' && workspacesState.phase === 'ready' ? visiblePendingCount : '—' })}</option>
      {workspaces.map((workspace) => {
        const count = index.state === 'ready' && workspacesState.phase === 'ready'
          ? displayItems.filter(item => item.workspace_id === workspace.workspaceId)
            .reduce((sum, item) => sum + item.pending_count, 0) : '—'
        return <option key={workspace.workspaceId} value={workspace.workspaceId}>{t('browser.workspace', { name: workspace.title, count })}</option>
      })}
    </select>
    {workspaceRequired && <p className={css.note} role="alert">{t('browser.chooseWorkspace')}</p>}
    <input className={css.search} type="search" value={query} onChange={(event) => { actions.setQuery(event.target.value) }} placeholder={t('browser.search')} aria-label={t('browser.search')} />
    {actionError && <p className={css.note} role="alert">{t('browser.actionFailed')}</p>}
    {(index.state === 'loading' || workspacesState.phase !== 'ready') && <p className={css.note}>{t('browser.loading')}</p>}
    {index.state === 'unavailable' && <p className={css.note}>{t('browser.unavailable')}</p>}
    {groups.every(group => group.length === 0) && index.state === 'ready' && workspacesState.phase === 'ready'
      && <p className={css.note}>{t(query ? 'browser.noMatch' : 'browser.empty')}</p>}
    {groups.map((group, i) => group.length > 0 && <div key={headings[i]} className={css.group}>
      <div className={css.groupTitle}>{headings[i]} <span>{group.length}</span></div>
      {group.map((item) => {
        const session = sessions.byId[item.session_id as SessionId]
        const id = item.session_id as SessionId
        return <div className={css.rowShell} key={`${item.workspace_id}:${item.session_id}`}>
          <button type="button" className={css.row} disabled={item.archived} onClick={() => { openConversation(item) }}>
            <span className={css.rowTitle}>{item.pinned ? '◆ ' : ''}{session?.displayTitle ?? t('browser.untitled')}</span>
            <span className={css.rowMeta}>{workspaceNames.get(item.workspace_id as WorkspaceId) ?? t('browser.workspaceFallback')} · {
              item.source_count === 0 ? t('browser.draftHint') : t('browser.sources', { count: item.source_count })}</span>
            <GroupStatus row={item} t={t} />
            {item.archived && <span className={css.running}>{t(hasActiveCollaboration(item) ? 'browser.archiveNeedsRestore' : 'browser.archived')}</span>}
            {item.pending_count > 0 && <span className={css.pending}>{t('browser.pendingItems', { count: item.pending_count })}</span>}
            {item.issue_count > 0 && <span className={css.pending}>{t('browser.issueItems', { count: item.issue_count })}</span>}
            {!item.archived && item.source_count > 0 && !hasActiveCollaboration(item)
              && <span className={css.rowMeta}>{t('browser.completed')}</span>}
            {item.pending_count === 0 && (item.planning_count > 0 || item.running_count > 0)
              && <span className={css.running}>{t('browser.agentRunning')}</span>}
          </button>
          <div className={css.actions}>
            {item.archived ? <button type="button" disabled={busy} onClick={() => { void run(() => restoreConversation(id), () => {}) }}>
              {t('browser.restore')}</button> : <>
              <button type="button" disabled={busy} onClick={() => { void run(() => togglePin(id, item.pinned), () => {}) }}>
                {t(item.pinned ? 'browser.unpin' : 'browser.pin')}</button>
              <button type="button" disabled={busy} onClick={() => { setEditing(item.session_id); setDraftTitle(session?.displayTitle ?? '') }}>
                {t('browser.rename')}</button>
              <button type="button" disabled={busy || item.pending_count > 0 || item.planning_count > 0 || item.running_count > 0 || item.issue_count > 0}
                title={item.pending_count > 0 || item.planning_count > 0 || item.running_count > 0 || item.issue_count > 0 ? t('browser.archiveUnavailable') : undefined}
                onClick={() => { setArchiving(item.session_id) }}>{t('browser.archive')}</button>
            </>}
          </div>
          {editing === item.session_id && <form className={css.inlineForm} onSubmit={(event) => {
            event.preventDefault()
            if (draftTitle.trim()) void run(() => renameConversation(id, draftTitle.trim()), () => { setEditing(null) })
          }}>
            <input autoFocus value={draftTitle} onChange={(event) => { setDraftTitle(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null) }} aria-label={t('browser.rename')} />
            <button type="submit" disabled={busy || !draftTitle.trim()}>{t('browser.save')}</button>
            <button type="button" onClick={() => { setEditing(null) }}>{t('browser.cancel')}</button>
          </form>}
          {archiving === item.session_id && <div className={css.inlineForm} role="group" aria-label={t('browser.archive')}>
            <span>{t('browser.archiveConfirm')}</span>
            <button type="button" disabled={busy} onClick={() => { void run(() => archiveConversation(id), () => { setArchiving(null) }) }}>{t('browser.archive')}</button>
            <button type="button" onClick={() => { setArchiving(null) }}>{t('browser.cancel')}</button>
          </div>}
        </div>
      })}
    </div>)}
  </section>
}
