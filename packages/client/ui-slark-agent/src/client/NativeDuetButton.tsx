import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconMicrophoneOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeDuetButton.module.css'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<'slarkAgent'> & {
  start: (sessionId: string) => Promise<void>
}
/** Composer action for a native-owned call; unmounting never ends an accepted call.
 * @param props Current Session and the advertised native start capability.
 * @returns A compact voice button with localized uncertain-connection feedback.
 */
export function NativeDuetButton({ sessionId, start, t }: Props) {
  const owner = useMemo(() => ({ active: false, busy: false }), [sessionId, start])
  const [state, setState] = useState<{ owner: typeof owner; pending: boolean; failed: boolean } | null>(null)
  useEffect(() => { owner.active = true; return () => { owner.active = false } }, [owner])
  const isActive = (): boolean => owner.active
  const begin = async (): Promise<void> => {
    if (!isActive() || owner.busy) return
    owner.busy = true; setState({ owner, pending: true, failed: false })
    let failed = false
    try { await start(sessionId) } catch { failed = true }
    finally {
      owner.busy = false
      if (isActive()) setState({ owner, pending: false, failed })
    }
  }
  return <span className={css.action}>
    <button type="button" className={css.button} aria-label={t('duet.start')} title={t('duet.start')}
      disabled={state?.owner === owner && state.pending} onClick={() => { void begin() }} data-testid="native-duet-input">
      <IconMicrophoneOutlineRegular size={18} />
    </button>
    {state?.owner === owner && state.failed && <span className={css.notice} role="status">{t('duet.uncertain')}</span>}
  </span>
}
