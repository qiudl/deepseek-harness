/** Authenticated Desktop browser action for an explicitly confirmed Session takeover. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './LocalSessionTakeover.module.css'

type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'conversation'>
type ControlState = { outcome: string; claim?: { kind: string; epoch: number } }

async function controlRpc(endpoint: string, args: Record<string, unknown>): Promise<ControlState> {
  const response = await fetch(`/api/session/${endpoint}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `local-control-${Date.now()}-${Math.random()}`,
      method: `session/${endpoint}`, payload: { args } }),
  })
  if (response.status === 404) throw new Error('desktop session control unsupported')
  if (!response.ok) throw new Error('desktop session control unavailable')
  const body = await response.json() as {
    result?: { ok: boolean; value?: ControlState }
  }
  if (!body.result?.ok || !body.result.value) throw new Error('desktop session control failed')
  return body.result.value
}

/** Shown only when this Desktop Profile reports an active remote owner. */
export function LocalSessionTakeover({ sessionId, t }: Props) {
  const [epoch, setEpoch] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let unsupported = false
    setEpoch(null)
    const refresh = () => {
      if (unsupported) return
      void controlRpc('localControlStatus', { sessionId }).then((state) => {
        if (!active) return
        setEpoch(state.outcome === 'held_elsewhere' && state.claim?.kind === 'remote'
          && Number.isSafeInteger(state.claim.epoch) ? state.claim.epoch : null)
      }).catch((error: unknown) => {
        if (!active) return
        setEpoch(null)
        if (error instanceof Error && error.message === 'desktop session control unsupported') {
          unsupported = true
          window.clearInterval(timer)
        }
      })
    }
    const timer = window.setInterval(refresh, 3_000)
    refresh()
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId])
  if (epoch === null && !failed) return null
  return (
    <span className={css.root}>
      {epoch !== null && (
        <button type="button" className={css.trigger} disabled={busy}
          onClick={() => {
            if (busy) return
            setBusy(true)
            setFailed(false)
            void controlRpc('localControlStatus', { sessionId }).then((state) => {
              const observed = state.claim
              if (state.outcome !== 'held_elsewhere' || observed?.kind !== 'remote'
                || !Number.isSafeInteger(observed.epoch)) return
              if (!window.confirm(t('control.confirmTakeover'))) return
              return controlRpc('localControlTakeover', { sessionId, expectedEpoch: observed.epoch })
                .then((next) => {
                  if (next.outcome !== 'controlled' || next.claim?.kind !== 'local') {
                    throw new Error('desktop session control takeover refused')
                  }
                  setEpoch(null)
                })
            }).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
          }}>
          {t('control.remoteHeld')}
        </button>
      )}
      {failed && <span role="alert" className={css.error}>{t('control.takeoverFailed')}</span>}
    </span>
  )
}
