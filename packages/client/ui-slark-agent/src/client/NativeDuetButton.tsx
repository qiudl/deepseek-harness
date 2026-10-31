import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconMicrophoneOutlineRegular, MenuSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './NativeDuetButton.module.css'

type Props = PropsRuntime<'conversation.input.right'> & PropsLocale<'slarkAgent'> & {
  start?: (sessionId: string) => Promise<void>
  dictate?: (sessionId: string, signal: AbortSignal) => Promise<string | null>
}
/** Composer action for a native-owned call; unmounting never ends an accepted call.
 * @param props Current Session and the advertised native start capability.
 * @returns A compact voice button with localized uncertain-connection feedback.
 */
export function NativeDuetButton({ sessionId, start, dictate, inputActions, t }: Props) {
  const owner = useMemo(() => ({ active: false, busy: false, abort: new AbortController() }), [sessionId, start, dictate, inputActions])
  const [state, setState] = useState<{ owner: typeof owner; pending: boolean; notice?: 'call' | 'dictation' | 'changed'; retained?: string } | null>(null)
  const [menu, setMenu] = useState(false)
  const action = useRef<HTMLSpanElement>(null)
  useEffect(() => { if (menu) action.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus() }, [menu])
  useEffect(() => {
    owner.active = true; owner.abort = new AbortController(); setMenu(false)
    return () => { owner.active = false; owner.abort.abort() }
  }, [owner])
  const isActive = (): boolean => owner.active
  const begin = async (mode: 'call' | 'dictation'): Promise<void> => {
    if (!isActive() || owner.busy) return
    owner.busy = true; setMenu(false); setState({ owner, pending: true })
    let notice: 'call' | 'dictation' | 'changed' | undefined, retained: string | undefined
    try {
      if (mode === 'call') await start?.(sessionId)
      else {
        const insertion = inputActions.captureInsertion()
        const text = await dictate?.(sessionId, owner.abort.signal)
        if (isActive() && text && !inputActions.insertText(text, insertion)) { notice = 'changed'; retained = text }
      }
    } catch { notice = mode === 'call' ? 'call' : 'dictation' }
    finally {
      owner.busy = false
      if (isActive()) setState({ owner, pending: false, ...(notice ? { notice } : {}), ...(retained ? { retained } : {}) })
    }
  }
  return <span ref={action} className={css.action} onKeyDown={(event) => {
    if (event.key === 'Escape') { setMenu(false); action.current?.querySelector('button')?.focus() }
    if (menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }}
  onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false) }}>
    <button type="button" className={css.button} aria-label={t(dictate ? 'voice.menu' : 'duet.start')} title={t(dictate ? 'voice.menu' : 'duet.start')}
      aria-expanded={dictate ? menu : undefined} aria-haspopup={dictate ? 'menu' : undefined}
      disabled={state?.owner === owner && state.pending} onClick={() => { if (dictate) setMenu(!menu); else void begin('call') }} data-testid="native-duet-input">
      <IconMicrophoneOutlineRegular size={18} />
    </button>
    {menu && dictate && <MenuSurface compact className={css.menu} role="menu" aria-label={t('voice.menu')}>
      {start && <button type="button" className={css.menuItem} role="menuitem" onClick={() => { void begin('call') }} data-testid="native-voice-call">{t('voice.call')}</button>}
      <button type="button" className={css.menuItem} role="menuitem" onClick={() => { void begin('dictation') }} data-testid="native-voice-dictation">{t('voice.dictation')}</button>
    </MenuSurface>}
    {state?.owner === owner && state.notice && <span className={css.notice} role="status">
      {t(state.notice === 'call' ? 'duet.uncertain' : state.notice === 'changed' ? 'dictation.changed' : 'dictation.unavailable')}
      {state.retained && <span className={css.retained}>{state.retained}</span>}
    </span>}
  </span>
}
