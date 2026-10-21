/** Original Session group ledger beneath the existing chat history and composer. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GroupMessageReply } from './collaboration-group-input.ts'
import css from './GroupChatDock.module.css'

type Host = NonNullable<Window['__DSH_DESKTOP_HOST__']>
type Message = Extract<GroupMessageReply, { state: 'page' }>['items'][number]
type Snapshot = {
  state: 'missing' | 'preparing' | 'active' | 'unavailable'
  workspaceId: string | undefined
  items: readonly Message[]
  hasMore: boolean
  loading: boolean
  readFailed: boolean
}
const empty: Snapshot = { state: 'missing', workspaceId: undefined, items: [], hasMore: false, loading: false, readFailed: false }
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & {
  sessionId: SessionId
  host: Host
  workspaceId: () => string | undefined
  subscribeWorkspace?: (listener: () => void) => () => void
}
const noSubscription = () => () => {}

export function GroupChatDock({ sessionId, host, workspaceId, subscribeWorkspace = noSubscription, t }: Props) {
  const selectedWorkspace = useSyncExternalStore(subscribeWorkspace, workspaceId, workspaceId)
  const [snapshot, setSnapshot] = useState<Snapshot>(empty)
  const loadMore = useRef<(() => void) | null>(null)
  useEffect(() => {
    setSnapshot(empty)
    let disposed = false, groupId: string | undefined, cursor = 0, hasMore = false, busy = false
    let items: readonly Message[] = []
    const current = () => !disposed && window.__DSH_DESKTOP_HOST__ === host && workspaceId() === selectedWorkspace
      && !!selectedWorkspace
    const publish = (state: Snapshot['state'], loading = false, readFailed = false) => {
      if (current()) setSnapshot({ state, workspaceId: selectedWorkspace, items, hasMore, loading, readFailed })
    }
    const page = async () => {
      const workspace = workspaceId()
      if (!current() || !workspace || !groupId || busy || !host.collaborationGroupMessages) return
      const expectedGroupId = groupId
      busy = true
      publish('active', true)
      try {
        const result = await host.collaborationGroupMessages({ operation: 'page',
          workspace_id: workspace, session_id: sessionId, after_seq: cursor, limit: 50 })
        if (!current() || groupId !== expectedGroupId || workspaceId() !== workspace) return
        if (result.state !== 'page') { publish('active', false, true); return }
        items = [...items, ...result.items]
        cursor = result.next_seq
        hasMore = result.has_more
        publish('active')
      } catch { publish('active', false, true) }
      finally { busy = false }
    }
    loadMore.current = () => { void page() }
    const refresh = async () => {
      const workspace = workspaceId()
      if (!current() || !workspace || !host.collaborationGroupPreparation) return
      try {
        const result = await host.collaborationGroupPreparation({ operation: 'lookup',
          workspace_id: workspace, session_id: sessionId })
        if (!current() || workspaceId() !== workspace) return
        if (result.state === 'missing') { groupId = undefined; items = []; publish('missing'); return }
        if (result.state === 'preparing') { groupId = undefined; cursor = 0; items = []; publish('preparing'); return }
        if (result.state !== 'group_active') { publish('unavailable'); return }
        if (groupId !== result.group_id) {
          groupId = result.group_id; cursor = 0; hasMore = true; items = []
          publish('active')
          await page()
        } else if (!hasMore) await page()
      } catch { publish('unavailable') }
    }
    const onRecorded = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail
      if (detail && typeof detail === 'object' && 'session_id' in detail &&
        detail.session_id === sessionId && 'workspace_id' in detail && detail.workspace_id === workspaceId()) {
        void page()
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 20_000)
    window.addEventListener('dsh-slark-group-message-recorded', onRecorded)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('dsh-slark-group-message-recorded', onRecorded)
    }
  }, [host, sessionId, workspaceId, selectedWorkspace])
  if (snapshot.state === 'missing' || snapshot.workspaceId !== selectedWorkspace ||
    window.__DSH_DESKTOP_HOST__ !== host) return null
  return <section className={css.panel} aria-label={t('group.title')}>
    <strong>{t('group.title')}</strong>
    {snapshot.state === 'preparing' && <p role="status">{t('group.preparing')}</p>}
    {snapshot.state === 'unavailable' && <p role="status">{t('group.readUnavailable')}</p>}
    {snapshot.state === 'active' && <>
      {snapshot.items.length === 0 && !snapshot.loading && <p>{t('group.empty')}</p>}
      {snapshot.items.map(item => <article key={item.id} className={css.message}>
        <strong>{item.actor_kind === 'human' ? t('group.human') : item.actor_ref}</strong>
        <p>{item.body}</p>
      </article>)}
      {snapshot.readFailed && <p role="status">{t('group.readUnavailable')}</p>}
      {snapshot.hasMore && <button type="button" disabled={snapshot.loading}
        onClick={() => { loadMore.current?.() }}>{t('group.loadMore')}</button>}
    </>}
  </section>
}
