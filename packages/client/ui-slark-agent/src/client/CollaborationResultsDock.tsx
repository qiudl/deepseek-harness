/** Original-Session collaboration results; plain text replies never submit a new chat turn. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollaborationResultsModel } from './collaboration-results.ts'
import type { zh } from './locales.ts'
import css from './CollaborationResultsDock.module.css'

/** The registrant owns the readonly model and passes commands through its apply closure. */
export interface CollaborationResultsInjected {
  hooks: { slarkResults: CollaborationResultsModel }
  traceEvidenceAction?(digest: string, eventId: string, more?: boolean): Promise<void>
  traceAction?(digest: string, more?: boolean): Promise<void>
  consumptionAction?(digest: string, deliveryId: string, reconcile?: boolean): Promise<void>
  executionAction(digest: string, taskId?: string, reconcile?: boolean): Promise<void>
  loadSources(): Promise<void>
  loadReplies(snapshotDigest: string): Promise<void>
}
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & SlotInjectFace<CollaborationResultsInjected>
const planningStatus: Partial<Record<string, keyof typeof zh>> = {
  queued: 'task.planningQueued',
  planning: 'task.planning',
  failed: 'task.planningFailed',
  cancelled: 'task.planningCancelled',
  unsupported: 'task.planningUnsupported',
  discuss: 'task.planningDiscussion',
}

/**
 * Display each original message and its readable task results in this Session.
 * @param props - Framework result hook, readonly paging commands and locale copy.
 * @returns a task region with complete plain text replies, or no region when no records exist.
 */
export function CollaborationResultsDock({ useSlarkResults, loadSources, loadReplies, executionAction, consumptionAction, t }: Props) {
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
          : group.replies.length === 0 && !group.pending?.length && !group.pendingUnavailable &&
            <p role="status">{t(planningStatus[group.planningState ?? ''] ?? 'task.awaitingResult')}</p>}
        {group.pendingUnavailable && <p role="status">{t('task.readUnavailable')}</p>}
        {group.pending?.map(item => <div className={css.reply} key={item.pending_item_id}>
          <strong>{item.mentions.map(mention => `${mention.agent_name}${mention.project_name === null ? '' : ` · ${mention.project_name}`}`).join(', ')}</strong>
          <div className={css.text}>{item.question}</div>
        </div>)}
        {state.executionAvailable && <div className={css.reply}>
          <Button size="sm" data-testid="slark-execution-preview" disabled={group.execution?.phase === 'loading' ||
            Object.values(group.execution?.outcomes ?? {}).includes('sending')}
          onClick={() => { void executionAction(group.original.snapshot_digest) }}>{t('execution.preview')}</Button>
          {group.execution?.phase === 'error' && <p role="status">{t('task.readUnavailable')}</p>}
          {group.execution?.phase === 'ready' && !group.execution.enabled && <p role="status">{t('execution.disabled')}</p>}
          {group.execution?.rootTraceId && <p>{t('execution.trace')} <code>{group.execution.rootTraceId}</code></p>}
          {group.execution?.tasks?.map((task) => {
            const outcome = group.execution?.outcomes?.[task.taskId]
            return <div key={task.taskId} data-testid="slark-execution-task">
              <strong>{task.agentName} · {task.projectName}</strong>
              <div className={css.text}>{task.question}</div>
              {outcome && <p role="status">{t(`execution.${outcome}`)}</p>}
              <Button size="sm" data-testid="slark-execution-confirm" disabled={!group.execution?.enabled || !!outcome && outcome !== 'not_admitted'}
                onClick={() => { void executionAction(group.original.snapshot_digest, task.taskId) }}>{t('execution.confirm')}</Button>
              {(outcome === 'uncertain' || outcome === 'recorded') && <Button size="sm" data-testid="slark-execution-reconcile"
                onClick={() => { void executionAction(group.original.snapshot_digest, task.taskId, true) }}>{t('execution.reconcile')}</Button>}
            </div>
          })}
        </div>}
        {group.replies.map((reply) => {
          const consumption = group.execution?.consumptions?.[reply.delivery_id]
          return <div className={css.reply} key={reply.delivery_id}>
            {reply.target_display_snapshot && <strong>{reply.target_display_snapshot.agent_name}
              {reply.target_display_snapshot.project_name !== null && <> · {reply.target_display_snapshot.project_name}</>}</strong>}
            <small>{t(reply.delivery_state === 'restricted' ? 'task.restricted'
              : reply.execution_state === 'succeeded' ? 'task.done'
                : reply.execution_state === 'indeterminate' ? 'task.indeterminate' : 'task.failed')}</small>
            {reply.answer !== undefined && <div className={css.text}>{reply.answer}</div>}
            {reply.task_id && group.execution?.tasks?.some(task => task.taskId === reply.task_id) && reply.delivery_state !== 'restricted' && <div>
              {consumption && <p role="status">{t(`consumption.${consumption}`)}</p>}
              <Button size="sm" data-testid="slark-consumption-start" disabled={!group.execution.enabled || group.execution.consumptions?.[reply.delivery_id] !== undefined}
                onClick={() => { void consumptionAction?.(group.original.snapshot_digest, reply.delivery_id) }}>{t('consumption.start')}</Button>
              {group.execution.consumptions?.[reply.delivery_id] && <Button size="sm" data-testid="slark-consumption-status" disabled={group.execution.consumptions[reply.delivery_id] === 'sending'}
                onClick={() => { void consumptionAction?.(group.original.snapshot_digest, reply.delivery_id, true) }}>{t('consumption.status')}</Button>}
            </div>}
          </div>
        })}
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
