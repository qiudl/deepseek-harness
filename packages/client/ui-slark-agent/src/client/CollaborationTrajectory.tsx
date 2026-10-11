/** Original-Session cloud audit history inside the Trajectory tab. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SlotInjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CollaborationResultsInjected } from './CollaborationResultsDock.tsx'
import type { zh } from './locales.ts'
import css from './CollaborationResultsDock.module.css'

const phases = new Map<string, keyof typeof zh>([
  ['root_accepted', 'trace.accepted'], ['revision_created', 'trace.revised'], ['root_state_changed', 'trace.stateChanged'],
  ['execution_admitted', 'trace.admitted'], ['consumer_authorized', 'trace.consumer'], ['context_applied', 'trace.consumed'],
  ['assistant_message_committed', 'trace.assistantCommitted'],
  ['receipt_received', 'trace.receiptReceived'], ['reconciliation_started', 'trace.reconciliationStarted'],
  ['reconciliation_resolved', 'trace.reconciliationResolved'], ['reconciliation_needs_review', 'trace.reconciliationNeedsReview'],
  ['execution_succeeded', 'trace.succeeded'], ['execution_failed', 'trace.failed'], ['execution_cancelled', 'trace.cancelled'],
  ['execution_revoked', 'trace.revoked'], ['execution_indeterminate', 'trace.indeterminate'],
  ['delivery_local_committed', 'trace.delivered'], ['delivery_rendered', 'trace.rendered'],
])
const states = new Map<string, keyof typeof zh>([
  ['active', 'trace.active'], ['waiting_input', 'trace.waitingInput'], ['waiting_host', 'trace.waitingHost'],
  ['reconciling', 'trace.reconciling'], ['succeeded', 'trace.rootSucceeded'], ['failed', 'trace.rootFailed'], ['cancelled', 'trace.rootCancelled'],
])
const runtimeEvents = new Map<string, keyof typeof zh>([
  ['session.started', 'trace.runtimeStarted'], ['session.completed', 'trace.runtimeCompleted'],
  ['tool.started', 'trace.toolStarted'], ['tool.completed', 'trace.toolCompleted'],
  ['file.started', 'trace.fileStarted'], ['file.completed', 'trace.fileCompleted'], ['error', 'trace.runtimeError'],
])
const terminalPhases = new Set(['execution_succeeded', 'execution_failed', 'execution_cancelled', 'execution_revoked', 'execution_indeterminate'])
type Props = PropsRuntime<'conversation.trajectory.external'> & PropsLocale<'slarkAgent'> & SlotInjectFace<CollaborationResultsInjected>
/** Render audited stages independently of ordinary Session tools and assistant replies.
 * @param props - Session-bound readonly history and paging commands.
 * @returns A bounded audit region, or nothing when no original collaboration message exists.
 */
export function CollaborationTrajectory({ useSlarkResults, traceAction, traceEvidenceAction, loadSources, t }: Props) {
  const state = useSlarkResults(value => value)
  if (!state.executionAvailable || state.groups.length === 0) return null
  return <section className={css.panel} aria-label={t('trace.title')} data-testid="slark-collaboration-trajectory">
    <strong>{t('trace.title')}</strong>
    <div className={css.records}>
      {state.groups.map(group => <article className={css.message} key={group.original.snapshot_digest}>
        <div className={css.text}>{group.original.original_message}</div>
        <Button data-testid="slark-trace-load" size="sm" disabled={group.trace?.phase === 'loading' || group.trace?.execution?.phase === 'loading'}
          onClick={() => { void traceAction?.(group.original.snapshot_digest) }}>{t(group.trace ? 'trace.refresh' : 'trace.load')}</Button>
        {group.trace?.phase === 'error' && <p role="status">{t('trace.unavailable')}</p>}
        {group.trace?.page && <>
          <p className={css.text}>{t('execution.trace')} <code>{group.trace.page.root.root_trace_id}</code></p>
          <p>{t(states.get(group.trace.page.root.state) ?? 'trace.unknown')} · {t('trace.revision')} {group.trace.page.root.task_revision}</p>
          {group.trace.page.root.intent_state === 'revoked' && <p role="status">{t('trace.intentRevoked')}</p>}
          <p role="status">{t('trace.partial')}</p>
          <ol className={css.traceEvents}>
            {group.trace.page.events.map(event => <li key={event.event_id}>
              <details>
                <summary>{t(phases.get(event.phase) ?? 'trace.unknown')} · <time dateTime={event.occurred_at}>{event.occurred_at}</time></summary>
                <dl className={css.traceDetails}>
                  <dt>{t('trace.revision')}</dt><dd>{event.task_revision}</dd>
                  <dt>{t('trace.event')}</dt><dd>{event.event_id}</dd>
                  {event.trace_context.step_id && <><dt>{t('trace.step')}</dt><dd>{event.trace_context.step_id}</dd></>}
                  {event.trace_context.attempt_id && <><dt>{t('trace.attempt')}</dt><dd>{event.trace_context.attempt_id}</dd></>}
                  {event.trace_context.causation_id && <><dt>{t('trace.cause')}</dt><dd>{event.trace_context.causation_id}</dd></>}
                </dl>
                {terminalPhases.has(event.phase) && <Button data-testid="slark-trace-execution" size="sm" disabled={group.trace?.execution?.phase === 'loading' || group.trace?.phase === 'loading'}
                  onClick={() => { void traceEvidenceAction?.(group.original.snapshot_digest, event.event_id) }}>{t('trace.executionDetails')}</Button>}
                {group.trace?.execution?.eventId === event.event_id && group.trace.execution.page && <>
                  <p>{t('trace.providerBoundary')}</p>
                  {group.trace.execution.page.events.length === 0 && <p>{t('trace.noEvidence')}</p>}
                  <ol>
                    {group.trace.execution.page.events.map(item => <li key={item.sequence}>
                      {t(runtimeEvents.get(item.type) ?? 'trace.unknown')} · <time dateTime={new Date(item.observedAt).toISOString()}>{new Date(item.observedAt).toISOString()}</time>
                      {item.runtimeId && <> · <code>{item.runtimeId}</code></>}
                      {item.success !== undefined && <> · {t(item.success ? 'trace.observationSucceeded' : 'trace.observationFailed')}</>}
                    </li>)}
                  </ol>
                  {group.trace.execution.page.next_after_sequence !== null && <Button data-testid="slark-trace-execution-more" size="sm" disabled={group.trace.execution.phase === 'loading' || group.trace.phase === 'loading'}
                    onClick={() => { void traceEvidenceAction?.(group.original.snapshot_digest, event.event_id, true) }}>{t('trace.moreExecution')}</Button>}
                </>}
              </details>
            </li>)}
          </ol>
          {group.trace.page.next_after_seq !== null && <Button data-testid="slark-trace-more" size="sm" disabled={group.trace.phase === 'loading' || group.trace.execution?.phase === 'loading'}
            onClick={() => { void traceAction?.(group.original.snapshot_digest, true) }}>{t('trace.more')}</Button>}
        </>}
      </article>)}
      {state.nextCursor && <Button data-testid="slark-trace-sources-more" size="sm" disabled={state.phase === 'loading'} onClick={() => { void loadSources() }}>{t('task.moreMessages')}</Button>}
    </div>
  </section>
}
