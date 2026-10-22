/** REQ-20261020-0010: Bot members of the current original Session group. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import css from './GroupChatDock.module.css'

type Member = {
  member_id: string
  actor_kind: 'human' | 'bot' | 'slark_agent' | 'system'
  actor_ref: string
  role: 'owner' | 'member'
  cycle: number
  joined_seq: number
  sources: ('manual' | 'personal_proxy')[]
}
type Snapshot = {
  state: 'snapshot'
  group_id: string
  membership_version: number
  last_seq: number
  members: Member[]
}
type Receipt = {
  state: 'recorded'
  operation: 'join' | 'leave' | 'proxy_attach' | 'proxy_revoke'
  member_id: string
  membership_version: number
  seq: number
}
export type GroupMemberCommand =
  | { operation: 'inflight'
    workspace_id: string
    session_id: string
    member_id: string
    after_delivery_id: string
    limit: number }
  | { operation: 'bots'
    workspace_id: string
    session_id: string
    after_bot_id: string
    limit: number }
  | { operation: 'proxy_status'
    workspace_id: string
    session_id: string }
  | { operation: 'proxy_select'
    workspace_id: string
    session_id: string
    request_id: string
    expected_binding_epoch: number
    bot_id: string }
  | { operation: 'proxy_replace'
    workspace_id: string
    session_id: string
    request_id: string
    expected_binding_epoch: number
    bot_id: string }
  | { operation: 'proxy_unbind'
    workspace_id: string
    session_id: string
    request_id: string
    expected_binding_epoch: number }
  | { operation: 'proxy_attach'
    workspace_id: string
    session_id: string
    request_id: string
    expected_membership_version: number
    bot_id: string
    binding_id: string
    binding_epoch: number }
  | { operation: 'status'; workspace_id: string; session_id: string }
  | { operation: 'receipt'; workspace_id: string; session_id: string; request_id: string }
  | {
    operation: 'join'
    workspace_id: string
    session_id: string
    request_id: string
    expected_membership_version: number
    bot_id: string
  }
  | {
    operation: 'leave'
    workspace_id: string
    session_id: string
    request_id: string
    expected_membership_version: number
    member_id: string
  }
export type GroupMemberReply = Snapshot | Receipt |
  { state: 'inflight'
    member_id: string
    member_cycle: number
    deliveries: { delivery_id: string
      message_seq: number
      payload_digest: string
      state: 'pending_reconciliation' }[]
    next_cursor: string | null } |
  { state: 'bot_roster'
    bots: { bot_id: string
      actor_ref: string
      display_name: string }[]
    next_cursor: string | null } |
  { state: 'proxy_binding'
    binding_id: string | null
    binding_epoch: number
    bot_ref: string | null
    binding_state: 'unbound' | 'active' | 'transferring' | 'needs_reselection' } |
  { state: 'proxy_bound'
    binding_id: string
    binding_epoch: number
    bot_ref: string } |
  { state: 'proxy_changed'
    operation: 'replace' | 'unbind'
    binding_id: string
    binding_epoch: number
    bot_ref: string | null
    binding_state: 'transferring' | 'unbound' } |
  { state: 'missing' | 'conflict' | 'retry_required' }
export interface GroupMemberBridge {
  collaborationGroupMembers?(command: GroupMemberCommand): Promise<GroupMemberReply>
}
type Host = GroupMemberBridge
type Change = Extract<GroupMemberCommand, { operation: 'join' | 'leave' | 'proxy_attach' }>
type Props = PropsLocale<'slarkAgent'> & {
  host: Host
  workspaceId: string
  sessionId: SessionId
  groupId: string
}
const botIdPattern = /^[A-Za-z0-9_-]{1,200}$/u

export function GroupMemberDock({ host, workspaceId, sessionId, groupId, t }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [botId, setBotId] = useState('')
  const [roster, setRoster] = useState<Extract<GroupMemberReply, { state: 'bot_roster' }> | null>(null)
  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterUnavailable, setRosterUnavailable] = useState(false)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyUnavailable, setProxyUnavailable] = useState(false)
  const [proxyLabel, setProxyLabel] = useState<string | null>(null)
  const [proxyHandoffPending, setProxyHandoffPending] = useState(false)
  const [proxyNeedsReselection, setProxyNeedsReselection] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [removalPending, setRemovalPending] = useState(false)
  const [removalNeedsDecision, setRemovalNeedsDecision] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Change | null>(null)
  const change = useRef<((command: Change) => Promise<void>) | null>(null)
  const pendingRef = useRef<Change | null>(null)
  const snapshotRef = useRef<Snapshot | null>(null)
  const botIdRef = useRef('')
  const rosterLoad = useRef<((after: string) => Promise<void>) | null>(null)
  const proxySelect = useRef<(() => Promise<void>) | null>(null)
  const proxyUnbind = useRef<(() => Promise<void>) | null>(null)
  const proxyRequestId = useRef<string | null>(null)
  const unbindRequestId = useRef<string | null>(null)
  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useEffect(() => { botIdRef.current = botId }, [botId])
  useEffect(() => {
    setSnapshot(null); setBotId(''); setUnavailable(false); setBusy(false); setPending(null)
    setRemovalPending(false); setRemovalNeedsDecision(false)
    snapshotRef.current = null; botIdRef.current = ''
    setRoster(null); setRosterBusy(false); setRosterUnavailable(false)
    setProxyBusy(false); setProxyUnavailable(false); setProxyLabel(null)
    setProxyHandoffPending(false); setProxyNeedsReselection(false)
    proxyRequestId.current = null; unbindRequestId.current = null
    pendingRef.current = null
    if (!host.collaborationGroupMembers) return
    let disposed = false, inFlight = false, inFlightChange = false
    let proxyInFlight = false, proxyStatusInFlight = false, proxyStatusVersion = 0
    const current = () => !disposed && window.__DSH_DESKTOP_HOST__ === host
    const loadProxyStatus = async () => {
      if (!current() || proxyInFlight || proxyStatusInFlight || !host.collaborationGroupMembers) return
      proxyStatusInFlight = true
      const version = proxyStatusVersion
      try {
        const result = await host.collaborationGroupMembers({ operation: 'proxy_status',
          workspace_id: workspaceId, session_id: sessionId })
        if (!current() || version !== proxyStatusVersion || result.state !== 'proxy_binding') return
        setProxyLabel(result.bot_ref)
        setProxyHandoffPending(result.binding_state === 'transferring')
        setProxyNeedsReselection(result.binding_state === 'needs_reselection')
      } catch { /* A missing Bot capability does not hide the group. Actions report their own errors. */ }
      finally { proxyStatusInFlight = false }
    }
    const load = async () => {
      if (!current() || inFlight || !host.collaborationGroupMembers) return
      inFlight = true
      try {
        const result = await host.collaborationGroupMembers({ operation: 'status',
          workspace_id: workspaceId, session_id: sessionId })
        if (!current()) return
        if (result.state !== 'snapshot' || result.group_id !== groupId) {
          setUnavailable(true); return
        }
        setSnapshot(result); setUnavailable(false)
        void loadProxyStatus()
      } catch { if (current()) setUnavailable(true) }
      finally { inFlight = false }
    }
    let rosterInFlight = false
    rosterLoad.current = async (after) => {
      /* v8 ignore next -- picker controls are disabled in flight and unmounted with the Host. */
      if (!current() || rosterInFlight || !host.collaborationGroupMembers) return
      rosterInFlight = true; setRosterBusy(true); setRosterUnavailable(false)
      try {
        const result = await host.collaborationGroupMembers({ operation: 'bots',
          workspace_id: workspaceId, session_id: sessionId, after_bot_id: after, limit: 50 })
        if (!current()) return
        if (result.state !== 'bot_roster') { setRosterUnavailable(true); return }
        setRoster(result)
      } catch { if (current()) setRosterUnavailable(true) }
      finally { rosterInFlight = false; if (current()) setRosterBusy(false) }
    }
    change.current = async (command) => {
      /* v8 ignore next -- action controls are disabled during a change and removed with the Host. */
      if (!current() || !host.collaborationGroupMembers || inFlightChange) return
      inFlightChange = true
      pendingRef.current = command; setPending(command); setBusy(true); setUnavailable(false)
      try {
        const result = await host.collaborationGroupMembers(command)
        if (!current()) return
        if (result.state === 'recorded' && result.operation === command.operation) {
          pendingRef.current = null; setPending(null)
          if (command.operation === 'join') setBotId('')
          await load()
        } else if (result.state === 'conflict') {
          pendingRef.current = null; setPending(null); setUnavailable(true)
          await load()
        } else setUnavailable(true)
      } catch { if (current()) setUnavailable(true) }
      finally { inFlightChange = false; if (current()) setBusy(false) }
    }
    proxySelect.current = async () => {
      /* v8 ignore next -- the proxy button requires a snapshot, valid Bot and no pending command. */
      if (!current() || proxyInFlight || !host.collaborationGroupMembers ||
        !snapshotRef.current || !botIdPattern.test(botIdRef.current) || pendingRef.current) return
      proxyInFlight = true; proxyStatusVersion++; setProxyBusy(true); setProxyUnavailable(false)
      try {
        const selected = botIdRef.current
        const status = await host.collaborationGroupMembers({ operation: 'proxy_status',
          workspace_id: workspaceId, session_id: sessionId })
        if (!current() || status.state !== 'proxy_binding') {
          if (current()) setProxyUnavailable(true)
          return
        }
        setProxyLabel(status.bot_ref)
        setProxyHandoffPending(status.binding_state === 'transferring')
        setProxyNeedsReselection(status.binding_state === 'needs_reselection')
        if (status.binding_state === 'active' && status.bot_ref === `deepseek-bot:${selected}` &&
          snapshotRef.current.members.some(member => member.actor_ref === status.bot_ref &&
            member.sources.includes('personal_proxy'))) return
        let binding: { binding_id: string; binding_epoch: number; bot_ref: string } | null = null
        if (status.binding_state === 'active' && status.bot_ref === `deepseek-bot:${selected}`
          && status.binding_id) binding = { binding_id: status.binding_id,
          binding_epoch: status.binding_epoch, bot_ref: status.bot_ref }
        else if (status.binding_state === 'unbound') {
          const requestId = proxyRequestId.current ?? randomUUID()
          proxyRequestId.current = requestId
          const result = await host.collaborationGroupMembers({ operation: 'proxy_select',
            workspace_id: workspaceId, session_id: sessionId, request_id: requestId,
            expected_binding_epoch: status.binding_epoch, bot_id: selected })
          if (!current() || result.state !== 'proxy_bound' ||
            result.bot_ref !== `deepseek-bot:${selected}`) {
            if (current()) setProxyUnavailable(true)
            return
          }
          binding = result; proxyRequestId.current = null; setProxyLabel(result.bot_ref)
          setProxyNeedsReselection(false)
        } else if (status.binding_state === 'active' ||
          status.binding_state === 'needs_reselection') {
          const requestId = proxyRequestId.current ?? randomUUID()
          proxyRequestId.current = requestId
          const result = await host.collaborationGroupMembers({ operation: 'proxy_replace',
            workspace_id: workspaceId, session_id: sessionId, request_id: requestId,
            expected_binding_epoch: status.binding_epoch, bot_id: selected })
          if (!current() || result.state !== 'proxy_changed' ||
            result.operation !== 'replace' || result.bot_ref !== `deepseek-bot:${selected}`) {
            if (current()) setProxyUnavailable(true)
            return
          }
          proxyRequestId.current = null; setProxyLabel(result.bot_ref)
          setProxyHandoffPending(true); setProxyNeedsReselection(false)
          return
        }
        const currentSnapshot = snapshotRef.current
        // The snapshot can disappear while the async Bot selection is in progress.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- A pending request can outlive the original snapshot.
        if (!binding || !currentSnapshot) { setProxyUnavailable(true); return }
        void change.current?.({ operation: 'proxy_attach', workspace_id: workspaceId,
          session_id: sessionId, request_id: randomUUID(),
          expected_membership_version: currentSnapshot.membership_version,
          bot_id: selected, binding_id: binding.binding_id,
          binding_epoch: binding.binding_epoch })
      } catch { if (current()) setProxyUnavailable(true) }
      finally { proxyInFlight = false; if (current()) setProxyBusy(false) }
    }
    proxyUnbind.current = async () => {
      /* v8 ignore next -- the unbind button is disabled while a proxy command is active. */
      if (!current() || proxyInFlight || !host.collaborationGroupMembers) return
      proxyInFlight = true; proxyStatusVersion++; setProxyBusy(true); setProxyUnavailable(false)
      try {
        const status = await host.collaborationGroupMembers({ operation: 'proxy_status',
          workspace_id: workspaceId, session_id: sessionId })
        if (!current() || status.state !== 'proxy_binding') {
          if (current()) setProxyUnavailable(true)
          return
        }
        if (status.binding_state === 'unbound') {
          setProxyLabel(null); setProxyHandoffPending(false); setProxyNeedsReselection(false); return
        }
        if (status.binding_state !== 'active') { setProxyUnavailable(true); return }
        const requestId = unbindRequestId.current ?? randomUUID()
        unbindRequestId.current = requestId
        const result = await host.collaborationGroupMembers({ operation: 'proxy_unbind',
          workspace_id: workspaceId, session_id: sessionId, request_id: requestId,
          expected_binding_epoch: status.binding_epoch })
        if (!current() || result.state !== 'proxy_changed' || result.operation !== 'unbind' ||
          result.bot_ref !== null) {
          if (current()) setProxyUnavailable(true)
          return
        }
        unbindRequestId.current = null; setProxyLabel(null); setProxyHandoffPending(true)
        setProxyNeedsReselection(false)
      } catch { if (current()) setProxyUnavailable(true) }
      finally { proxyInFlight = false; if (current()) setProxyBusy(false) }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 20_000)
    return () => { disposed = true; window.clearInterval(timer)
      change.current = null; rosterLoad.current = null; proxySelect.current = null
      proxyUnbind.current = null }
  }, [host, workspaceId, sessionId, groupId])
  const add = () => {
    /* v8 ignore next -- the Add button is disabled until a snapshot and valid Bot ID exist and while a change is pending. */
    if (!snapshot || !botIdPattern.test(botId) || pendingRef.current) return
    void change.current?.({ operation: 'join', workspace_id: workspaceId, session_id: sessionId,
      request_id: randomUUID(), expected_membership_version: snapshot.membership_version,
      bot_id: botId })
  }
  const remove = async (memberId: string) => {
    /* v8 ignore next -- Remove buttons render only from a snapshot and are disabled while a change is pending. */
    if (!snapshot || pendingRef.current || removalPending || !host.collaborationGroupMembers ||
      window.__DSH_DESKTOP_HOST__ !== host) return
    setRemovalPending(true); setRemovalNeedsDecision(false)
    try {
      const inventory = await host.collaborationGroupMembers({ operation: 'inflight',
        workspace_id: workspaceId, session_id: sessionId, member_id: memberId,
        after_delivery_id: '', limit: 100 })
      if (window.__DSH_DESKTOP_HOST__ !== host) return
      if (inventory.state !== 'inflight' || inventory.member_id !== memberId) {
        setUnavailable(true); return
      }
      if (inventory.deliveries.length || inventory.next_cursor !== null) {
        setRemovalNeedsDecision(true); return
      }
    } catch { if (window.__DSH_DESKTOP_HOST__ === host) setUnavailable(true); return }
    finally { if (window.__DSH_DESKTOP_HOST__ === host) setRemovalPending(false) }
    const currentSnapshot = snapshotRef.current
    if (!currentSnapshot?.members.some(member => member.member_id === memberId &&
      member.sources.includes('manual'))) { setUnavailable(true); return }
    void change.current?.({ operation: 'leave', workspace_id: workspaceId, session_id: sessionId,
      request_id: randomUUID(), expected_membership_version: currentSnapshot.membership_version,
      member_id: memberId })
  }
  if (!host.collaborationGroupMembers) return null
  return <section className={css.members} aria-label={t('group.members')}>
    <strong>{t('group.members')}</strong>
    {snapshot?.members.map(member => <div className={css.member} key={member.member_id}>
      <span>{member.actor_ref}</span>
      {member.sources.includes('personal_proxy') && <small>{t('group.personalProxy')}</small>}
      {member.actor_kind === 'bot' && member.sources.includes('manual') &&
        <button type="button" disabled={busy || !!pending || removalPending}
          onClick={() => { void remove(member.member_id) }}>
          {t('group.removeBot')}
        </button>}
    </div>)}
    <div className={css.memberAdd}>
      <label htmlFor="slark-group-bot-id">{t('group.botId')}</label>
      <input id="slark-group-bot-id" value={botId} maxLength={200}
        onChange={(event) => { setBotId(event.target.value) }} />
      <button type="button" disabled={rosterBusy}
        onClick={() => { void rosterLoad.current?.('') }}>{t('group.chooseBot')}</button>
      <button type="button" disabled={busy || !!pending || !botIdPattern.test(botId)}
        onClick={add}>{t('group.addBot')}</button>
      <button type="button" disabled={busy || proxyBusy || !!pending || !botIdPattern.test(botId)}
        onClick={() => { void proxySelect.current?.() }}>{t('group.makeProxy')}</button>
      <button type="button" disabled={busy || proxyBusy || !!pending}
        onClick={() => { void proxyUnbind.current?.() }}>{t('group.unbindProxy')}</button>
    </div>
    {roster && <div className={css.memberAdd}>
      {roster.bots.map(bot => <button key={bot.bot_id} type="button"
        onClick={() => { setBotId(bot.bot_id) }}>{bot.display_name}</button>)}
      {roster.next_cursor && <button type="button" disabled={rosterBusy}
        onClick={() => { void rosterLoad.current?.(roster.next_cursor as string) }}>
        {t('group.moreBots')}</button>}
    </div>}
    {rosterUnavailable && <p role="status">{t('group.botRosterUnavailable')}</p>}
    {proxyLabel && <p>{t('group.personalProxy')}: {proxyLabel}</p>}
    {proxyHandoffPending && <p role="status">{t('group.proxyHandoffPending')}</p>}
    {proxyNeedsReselection && <p role="status">{t('group.proxyNeedsReselection')}</p>}
    {proxyUnavailable && <p role="status">{t('group.proxyUnavailable')}</p>}
    {unavailable && <p role="status">{t('group.memberUnavailable')}</p>}
    {removalNeedsDecision && <p role="status">{t('group.pendingWorkDecision')}</p>}
    {pending && <button type="button" disabled={busy}
      onClick={() => { void change.current?.(pending) }}>{t('group.retryMemberChange')}</button>}
  </section>
}
