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
export type GroupMemberReply = Snapshot | Receipt | { state: 'missing' | 'conflict' | 'retry_required' }
export interface GroupMemberBridge {
  collaborationGroupMembers?(command: GroupMemberCommand): Promise<GroupMemberReply>
}
type Host = GroupMemberBridge
type Change = Extract<GroupMemberCommand, { operation: 'join' | 'leave' }>
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
  const [unavailable, setUnavailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Change | null>(null)
  const change = useRef<((command: Change) => Promise<void>) | null>(null)
  const pendingRef = useRef<Change | null>(null)
  useEffect(() => {
    setSnapshot(null); setBotId(''); setUnavailable(false); setBusy(false); setPending(null)
    pendingRef.current = null
    if (!host.collaborationGroupMembers) return
    let disposed = false, inFlight = false, inFlightChange = false
    const current = () => !disposed && window.__DSH_DESKTOP_HOST__ === host
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
      } catch { if (current()) setUnavailable(true) }
      finally { inFlight = false }
    }
    change.current = async (command) => {
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
    void load()
    const timer = window.setInterval(() => { void load() }, 20_000)
    return () => { disposed = true; window.clearInterval(timer); change.current = null }
  }, [host, workspaceId, sessionId, groupId])
  const add = () => {
    /* v8 ignore next -- the Add button is disabled until a snapshot and valid Bot ID exist and while a change is pending. */
    if (!snapshot || !botIdPattern.test(botId) || pendingRef.current) return
    void change.current?.({ operation: 'join', workspace_id: workspaceId, session_id: sessionId,
      request_id: randomUUID(), expected_membership_version: snapshot.membership_version,
      bot_id: botId })
  }
  const remove = (memberId: string) => {
    /* v8 ignore next -- Remove buttons render only from a snapshot and are disabled while a change is pending. */
    if (!snapshot || pendingRef.current) return
    void change.current?.({ operation: 'leave', workspace_id: workspaceId, session_id: sessionId,
      request_id: randomUUID(), expected_membership_version: snapshot.membership_version,
      member_id: memberId })
  }
  if (!host.collaborationGroupMembers) return null
  return <section className={css.members} aria-label={t('group.members')}>
    <strong>{t('group.members')}</strong>
    {snapshot?.members.map(member => <div className={css.member} key={member.member_id}>
      <span>{member.actor_ref}</span>
      {member.sources.includes('personal_proxy') && <small>{t('group.personalProxy')}</small>}
      {member.actor_kind === 'bot' && member.sources.includes('manual') &&
        <button type="button" disabled={busy || !!pending} onClick={() => { remove(member.member_id) }}>
          {t('group.removeBot')}
        </button>}
    </div>)}
    <div className={css.memberAdd}>
      <label htmlFor="slark-group-bot-id">{t('group.botId')}</label>
      <input id="slark-group-bot-id" value={botId} maxLength={200}
        onChange={(event) => { setBotId(event.target.value) }} />
      <button type="button" disabled={busy || !!pending || !botIdPattern.test(botId)}
        onClick={add}>{t('group.addBot')}</button>
    </div>
    {unavailable && <p role="status">{t('group.memberUnavailable')}</p>}
    {pending && <button type="button" disabled={busy}
      onClick={() => { void change.current?.(pending) }}>{t('group.retryMemberChange')}</button>}
  </section>
}
