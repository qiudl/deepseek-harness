/** Original-Session collaboration results; plain text replies never submit a new chat turn. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollaborationResultsModel } from './collaboration-results.ts'
import css from './CollaborationResultsDock.module.css'

/** The registrant owns the readonly model and passes commands through its apply closure. */
export interface CollaborationResultsInjected {
  hooks: { slarkResults: CollaborationResultsModel }
  loadSources(): Promise<void>
  loadReplies(snapshotDigest: string): Promise<void>
}
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & SlotInjectFace<CollaborationResultsInjected>

/**
 * Display each original message and its readable task results in this Session.
 * @param props - Framework result hook, readonly paging commands and locale copy.
 * @returns a task region with complete plain text replies, or no region when no records exist.
 */
export function CollaborationResultsDock({ useSlarkResults, loadSources, loadReplies, t }: Props) {
  const state = useSlarkResults(value => value)
  if (state.groups.length === 0 && state.phase !== 'error') return null
  return <section className={css.panel} aria-label={t('task.collaborationHistory')} data-testid="slark-collaboration-results">
    <strong>{t('task.collaborationHistory')}</strong>
    {state.phase === 'error' && <p role="status">{t('task.readUnavailable')}</p>}
    <div className={css.records}>
      {state.groups.map(group => <article className={css.message} key={group.original.snapshot_digest}>
        <small>{t('task.question')}</small>
        <div className={css.text}>{group.original.original_message}</div>
        {group.phase === 'error' ? <p role="status">{t('task.readUnavailable')}</p>
          : group.replies.length === 0 && <p role="status">{t('task.awaitingResult')}</p>}
        {group.replies.map(reply => <div className={css.reply} key={reply.delivery_id}>
          {reply.target_display_snapshot && <strong>{reply.target_display_snapshot.agent_name}
            {reply.target_display_snapshot.project_name !== null && <> · {reply.target_display_snapshot.project_name}</>}</strong>}
          <small>{t(reply.delivery_state === 'restricted' ? 'task.restricted'
            : reply.execution_state === 'succeeded' ? 'task.done'
              : reply.execution_state === 'indeterminate' ? 'task.indeterminate' : 'task.failed')}</small>
          {reply.answer !== undefined && <div className={css.text}>{reply.answer}</div>}
        </div>)}
        {group.nextCursor && <Button size="sm" disabled={state.phase === 'loading'}
          data-testid="slark-collaboration-results-more"
          onClick={() => { void loadReplies(group.original.snapshot_digest) }}>{t('task.moreResults')}</Button>}
      </article>)}
    </div>
    {state.nextCursor && <Button size="sm" disabled={state.phase === 'loading'}
      data-testid="slark-collaboration-messages-more"
      onClick={() => { void loadSources() }}>{t('task.moreMessages')}</Button>}
  </section>
}
