/** Main persists the Session draft independently of this status presentation. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import css from './DraftPersistence.module.css'

/** Session-owned save status and explicit recovery action. */
export interface DraftPersistenceInjected {
  hooks: { draftPersistence: ObservableSnapshot<{ failed: boolean; retrying: boolean }> }
  retryDraft(): Promise<void>
}
type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & InjectFace<DraftPersistenceInjected>
/** Keep the editable composer visible while a durable save needs attention. */
export function DraftPersistence({ useDraftPersistence, retryDraft, t }: Props) {
  const { failed, retrying } = useDraftPersistence(value => value)
  return failed ? <div role="status" className={css.notice} data-testid="slark-draft-unsaved">
    <p>{t('draft.unsaved')}</p>
    <button type="button" data-testid="slark-draft-retry" disabled={retrying}
      onClick={() => { void retryDraft() }}>{t(retrying ? 'draft.retrying' : 'draft.retry')}</button>
  </div> : null
}
