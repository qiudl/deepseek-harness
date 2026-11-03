/** Original Session group ledger beneath the existing chat history and composer. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { GroupMessageReply } from './collaboration-group-input.ts'
import type { CollaborationResultGroup, CollaborationResultsModel } from './collaboration-results.ts'
import { GroupMemberDock } from './GroupMemberDock.tsx'
import css from './GroupChatDock.module.css'

type Host = NonNullable<Window['__DSH_DESKTOP_HOST__']>
type Message = Extract<GroupMessageReply, { state: 'page' }>['items'][number]
type RecordedPending = { requestId: string; digest: string }
type Snapshot = {
  state: 'missing' | 'preparing' | 'active' | 'unavailable'
  workspaceId: string | undefined
  groupId: string | undefined
  items: readonly Message[]
  hasMore: boolean
  loading: boolean
  readFailed: boolean
}
const empty: Snapshot = { state: 'missing', workspaceId: undefined, groupId: undefined,
  items: [], hasMore: false, loading: false, readFailed: false }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha256 = /^[a-f0-9]{64}$/u
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & {
  sessionId: SessionId
  host: Host
  workspaceId: () => string | undefined
  subscribeWorkspace?: (listener: () => void) => () => void
  resultsModel?: Pick<CollaborationResultsModel, 'subscribe' | 'getSnapshot'>
}
const noSubscription = () => () => {}
const noResults = () => undefined
const messageTime = (value: number) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function GroupChatDock({ sessionId, host, workspaceId, subscribeWorkspace = noSubscription,
  resultsModel, t }: Props) {
  const selectedWorkspace = useSyncExternalStore(subscribeWorkspace, workspaceId, workspaceId)
  const results = useSyncExternalStore(resultsModel?.subscribe ?? noSubscription,
    resultsModel?.getSnapshot ?? noResults, resultsModel?.getSnapshot ?? noResults)
  const workByMessage = new Map(results?.groups.filter(group =>
    group.original.source.session_id === sessionId && group.original.source.workspace_id === selectedWorkspace)
    .map(group => [group.original.source.source_message_id, group] as const) ?? [])
  const [snapshot, setSnapshot] = useState<Snapshot>(empty)
  const [recordedPending, setRecordedPending] = useState<RecordedPending | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [activating, setActivating] = useState(false)
  const [activationFailed, setActivationFailed] = useState(false)
  const loadMore = useRef<(() => void) | null>(null)
  const recoverPending = useRef<((pending: RecordedPending) => Promise<void>) | null>(null)
  const activate = useRef<(() => Promise<void>) | null>(null)
  useEffect(() => {
    setSnapshot(empty)
    setRecordedPending(null)
    setRecovering(false)
    setActivating(false)
    setActivationFailed(false)
    let disposed = false, groupId: string | undefined, preparedGroupId: string | undefined
    let activationRequestId: string | undefined, activationBusy = false, cursor = 0, hasMore = false, busy = false
    let items: readonly Message[] = []
    const current = () => !disposed && window.__DSH_DESKTOP_HOST__ === host && workspaceId() === selectedWorkspace
      && !!selectedWorkspace
    const publish = (state: Snapshot['state'], loading = false, readFailed = false) => {
      if (current()) setSnapshot({ state, workspaceId: selectedWorkspace, groupId,
        items, hasMore, loading, readFailed })
    }
    const checkPending = async () => {
      const workspace = workspaceId(), expectedGroupId = groupId
      if (!current() || !workspace || !expectedGroupId || !host.collaborationGroupMessages) return
      try {
        const status = await host.collaborationGroupMessages({ operation: 'pending_status',
          workspace_id: workspace, session_id: sessionId, group_id: expectedGroupId })
        if (!current() || groupId !== expectedGroupId) return
        if (status.state !== 'pending_status' || !uuid.test(status.request_id) ||
          !sha256.test(status.digest)) { setRecordedPending(null); return }
        const receipt = await host.collaborationGroupMessages({ operation: 'receipt',
          workspace_id: workspace, session_id: sessionId, request_id: status.request_id })
        if (!current() || groupId !== expectedGroupId) return
        setRecordedPending(receipt.state === 'recorded'
          ? { requestId: status.request_id, digest: status.digest } : null)
      } catch { if (current() && groupId === expectedGroupId) setRecordedPending(null) }
    }
    recoverPending.current = async (pending) => {
      const workspace = workspaceId(), expectedGroupId = groupId
      if (!current() || !workspace || !expectedGroupId || !host.collaborationGroupMessages) return
      setRecovering(true)
      try {
        const status = await host.collaborationGroupMessages({ operation: 'pending_status',
          workspace_id: workspace, session_id: sessionId, group_id: expectedGroupId })
        if (!current() || groupId !== expectedGroupId || status.state !== 'pending_status' ||
          status.request_id !== pending.requestId || status.digest !== pending.digest) return
        const receipt = await host.collaborationGroupMessages({ operation: 'receipt',
          workspace_id: workspace, session_id: sessionId, request_id: pending.requestId })
        if (!current() || groupId !== expectedGroupId || receipt.state !== 'recorded') return
        const acknowledged = await host.collaborationGroupMessages({ operation: 'pending_ack',
          workspace_id: workspace, session_id: sessionId, group_id: expectedGroupId,
          request_id: pending.requestId, digest: pending.digest })
        if (current() && groupId === expectedGroupId && acknowledged.state === 'acknowledged')
          setRecordedPending(null)
      } catch { /* Keep the pending key for another explicit recovery attempt. */ }
      finally { if (current() && groupId === expectedGroupId) setRecovering(false) }
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
        if (result.state === 'missing') {
          groupId = undefined; preparedGroupId = undefined; activationRequestId = undefined
          setActivationFailed(false)
          items = []; publish('missing'); return
        }
        if (result.state === 'preparing') {
          if (preparedGroupId !== result.group_id) {
            activationRequestId = undefined
            setActivationFailed(false)
          }
          groupId = undefined; preparedGroupId = result.group_id; cursor = 0; items = []
          publish('preparing'); return
        }
        if (result.state !== 'group_active') { publish('unavailable'); return }
        preparedGroupId = undefined
        setActivationFailed(false)
        if (groupId !== result.group_id) {
          groupId = result.group_id; cursor = 0; hasMore = true; items = []
          setRecordedPending(null)
          publish('active')
          await page()
        } else if (!hasMore) await page()
        await checkPending()
      } catch { publish('unavailable') }
    }
    activate.current = async () => {
      const workspace = workspaceId(), expectedGroupId = preparedGroupId
      if (!current() || !workspace || !expectedGroupId || !host.collaborationGroupActivation || activationBusy) return
      activationRequestId ??= randomUUID()
      activationBusy = true
      setActivating(true)
      setActivationFailed(false)
      try {
        const result = await host.collaborationGroupActivation({ request_id: activationRequestId,
          workspace_id: workspace, session_id: sessionId })
        if (!current() || preparedGroupId !== expectedGroupId) return
        if (result.state !== 'group_active' || result.group_id !== expectedGroupId) {
          setActivationFailed(true); return
        }
        await refresh()
      } catch { if (current() && preparedGroupId === expectedGroupId) setActivationFailed(true) }
      finally { activationBusy = false; if (current()) setActivating(false) }
    }
    const onRecorded = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail
      if (detail && typeof detail === 'object' && 'session_id' in detail &&
        detail.session_id === sessionId && 'workspace_id' in detail && detail.workspace_id === workspaceId()) {
        void page()
        void checkPending()
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
    {snapshot.state === 'preparing' && <>
      <p role="status">{t('group.preparing')}</p>
      {host.collaborationGroupActivation && <button type="button" disabled={activating}
        onClick={() => { void activate.current?.() }}>{t('group.activate')}</button>}
      {activationFailed && <p role="status">{t('group.activationFailed')}</p>}
    </>}
    {snapshot.state === 'unavailable' && <p role="status">{t('group.readUnavailable')}</p>}
    {snapshot.state === 'active' && <>
      {snapshot.workspaceId && snapshot.groupId && <GroupMemberDock host={host}
        workspaceId={snapshot.workspaceId} sessionId={sessionId} groupId={snapshot.groupId} t={t} />}
      {recordedPending && <div className={css.recovery} role="status">
        <p>{t('group.pendingRecorded')}</p>
        <button type="button" disabled={recovering}
          onClick={() => { void recoverPending.current?.(recordedPending) }}>
          {t('group.confirmDraftCleared')}
        </button>
      </div>}
      {snapshot.items.length === 0 && !snapshot.loading && <p>{t('group.empty')}</p>}
      {snapshot.items.map((item) => {
        const time = messageTime(item.created_at)
        const group = workByMessage.get(item.id)
        return <article key={item.id} className={css.message} data-group-message-id={item.id}>
          <header className={css.messageHeader}>
            <strong>{item.actor_kind === 'human' ? t('group.human')
              : item.actor_kind === 'system' && item.actor_ref === 'slark-agent-result'
                ? t('group.agentStatus') : item.actor_ref}</strong>
            {time && <time dateTime={time.toISOString()}>{time.toLocaleString()}</time>}
          </header>
          <p>{item.body}</p>
          {group && <GroupWorkResult group={group} t={t} />}
        </article>
      })}
      {snapshot.readFailed && <p role="status">{t('group.readUnavailable')}</p>}
      {snapshot.hasMore && <button type="button" disabled={snapshot.loading}
        onClick={() => { loadMore.current?.() }}>{t('group.loadMore')}</button>}
    </>}
  </section>
}

function GroupWorkResult({ group, t }: { group: CollaborationResultGroup; t: Props['t'] }) {
  if (group.phase === 'error' || group.pendingUnavailable)
    return <p className={css.workStatus} role="status">{t('task.readUnavailable')}</p>
  const tasks = group.execution?.tasks ?? []
  if (!tasks.length && !group.replies.length && !group.pending?.length && !group.provisionalResponses?.length)
    return <p className={css.workStatus} role="status">{t('task.awaitingResult')}</p>
  return <section className={css.work} aria-label={t('task.assignment')}>
    <strong>{t('task.assignment')}</strong>
    <small className={css.workStatus}>{t('group.ownerOnlyResult')}</small>
    {tasks.map((task) => {
      const reply = group.replies.find(item => item.task_id === task.taskId)
      const outcome = group.execution?.outcomes?.[task.taskId]
      return <div key={task.taskId} className={css.workTask} data-task-id={task.taskId}>
        <strong>{task.agentName}</strong>
        <small>{reply?.execution_state === 'succeeded' ? t('task.done')
          : reply?.execution_state === 'indeterminate' ? t('task.indeterminate')
            : reply?.execution_state === 'accepted' || reply?.execution_state === 'running' ? t('task.background')
              : reply ? t('task.failed') : outcome === 'recorded' ? t('task.waiting') : t('task.planned')}</small>
        {reply?.answer !== undefined && <p>{reply.answer}</p>}
      </div>
    })}
    {group.pending?.map(item => <p key={item.pending_item_id}>{t('task.needsReply')}: {item.question}</p>)}
    {group.provisionalResponses?.filter(item => !tasks.some(task => task.taskId === item.taskId))
      .map(item => <p key={item.invocationId}>{item.agentName}: {item.text}</p>)}
    {group.replies.filter(item => item.answer !== undefined && !tasks.some(task => task.taskId === item.task_id))
      .map(item => <p key={item.delivery_id}>{item.target_display_snapshot?.agent_name ?? t('task.assignment')}: {item.answer}</p>)}
  </section>
}
