/** Independent Source originals and Agent replies inside the ordinary Chat flow. */
import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollaborationResultsInjected } from './CollaborationResultsDock.tsx'
import { planningStatus } from './CollaborationResultsDock.tsx'
import type { CollaborationResultGroup } from './collaboration-results.ts'
import css from './CollaborationTimeline.module.css'

type Props = PropsRuntime<'conversation.chat.timeline'> & PropsLocale<'slarkAgent'> & SlotInjectFace<CollaborationResultsInjected>

/**
 * Present authorized collaboration records alongside ordinary rows, without another input or task form.
 * @param props - Current Session display rows, readonly result model, paging and locale commands.
 * @returns Merged history with original Source and delivery identities, or the ordinary rows alone.
 */
export function CollaborationTimeline({ recordId, sessionId, useSlarkResults, loadSources, loadReplies, t }: Props) {
  const state = useSlarkResults(value => value)
  const originals = useRef(new Map<string, HTMLElement>())
  const focusDigest = state.focus?.snapshotDigest, focusSequence = state.focus?.sequence
  useEffect(() => {
    if (!focusDigest || (recordId !== null && recordId !== focusDigest)) return
    const node = originals.current.get(focusDigest)
    if (!node) return
    node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'nearest' })
  }, [focusDigest, focusSequence, recordId])
  const groups = state.groups.filter(group => group.original.source.session_id === sessionId)
  const legacy = groups.filter(group => group.original.timeline_position == null)
  const original = (group: CollaborationResultGroup) => <SourceRecord key={group.original.snapshot_digest}
    group={group} t={t} loadReplies={loadReplies} busy={state.phase === 'loading'}
    bind={(node) => {
      if (node) originals.current.set(group.original.snapshot_digest, node)
      else originals.current.delete(group.original.snapshot_digest)
    }} />
  if (recordId !== null) {
    const group = groups.find(group => group.original.snapshot_digest === recordId)
    return group ? original(group) : null
  }
  return <>
    {state.phase === 'error' && <p role="status">{t('task.readUnavailable')}</p>}
    {state.location?.status === 'unavailable' && <p role="status">{t('task.sourceUnavailable')}</p>}
    {state.nextCursor && <div className={css.earlier}>
      <Button size="sm" disabled={state.phase === 'loading'} data-testid="slark-timeline-more"
        onClick={() => { void loadSources() }}>{t('task.moreMessages')}</Button>
    </div>}
    {legacy.length > 0 && <section className={css.legacy} aria-label={t('task.unpositionedHistory')}>
      <small>{t('task.unpositionedHistory')}</small>{legacy.map(original)}
    </section>}
  </>
}

function SourceRecord({ group, t, loadReplies, busy, bind }: {
  group: CollaborationResultGroup
  t: Props['t']
  loadReplies: Props['loadReplies']
  busy: boolean
  bind: (node: HTMLElement | null) => void
}) {
  const digest = group.original.snapshot_digest
  return <>
    <article className={css.original} ref={bind} tabIndex={-1} data-testid="slark-timeline-original"
      data-source-digest={digest} data-row-id={`slark-source:${digest}`}>
      <small>{t('task.question')}</small><div className={css.text}>{group.original.original_message}</div>
    </article>
    {group.phase === 'error' || group.pendingUnavailable ? <p role="status">{t('task.readUnavailable')}</p>
      : group.replies.length === 0 && !group.pending?.length && <p className={css.status} role="status">
        {t(planningStatus[group.planningState ?? ''] ?? 'task.awaitingResult')}</p>}
    {group.pending?.map(item => <article key={item.pending_item_id} className={css.reply}
      data-row-id={`slark-clarification:${digest}:${item.pending_item_id}`}>
      <strong>{item.mentions.map(mention => `${mention.agent_name}${mention.project_name === null ? '' : ` · ${mention.project_name}`}`).join(', ')}</strong>
      <div className={css.text}>{item.question}</div>
    </article>)}
    {group.replies.map(reply => <article key={reply.delivery_id} className={css.reply} data-testid="slark-timeline-reply"
      data-row-id={`slark-reply:${reply.delivery_id}`}>
      {reply.target_display_snapshot && <strong>{reply.target_display_snapshot.agent_name}
        {reply.target_display_snapshot.project_name !== null && <> · {reply.target_display_snapshot.project_name}</>}</strong>}
      <small>{t(reply.delivery_state === 'restricted' ? 'task.restricted'
        : reply.execution_state === 'succeeded' ? 'task.done'
          : reply.execution_state === 'indeterminate' ? 'task.indeterminate' : 'task.failed')}</small>
      {reply.answer !== undefined && <div className={css.text}>{reply.answer}</div>}
    </article>)}
    {group.nextCursor && <Button size="sm" disabled={busy} data-testid="slark-timeline-more-replies"
      onClick={() => { void loadReplies(digest) }}>{t('task.moreResults')}</Button>}
  </>
}
