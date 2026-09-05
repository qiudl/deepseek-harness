import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { LocalComputerSelection, LocalComputerTargets } from './api.ts'
import { SelectionConflictError } from './api.ts'
import css from './LocalComputerControl.module.css'

export interface LocalComputerInjected {
  listTargets: () => Promise<LocalComputerTargets>
  selectTarget: (grantId: string, publicationVersion: number) => Promise<LocalComputerSelection>
  reload: () => void
}

type Props = Pick<PropsRuntime<'sidebar.footer.action'>, 'wide'> & LocalComputerInjected

function selectedLabel(state: LocalComputerTargets | null): string {
  const selected = state?.items.find(item => item.grantId === state.selectedGrantId)
  return selected?.computerLabel ?? selected?.displayCode ?? '未选择本地电脑'
}

/** Render current local-computer status and an explicit CAS target picker. */
export function LocalComputerControl({ wide, listTargets, selectTarget, reload }: Props) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LocalComputerTargets | null>(null)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(false)
  const refreshSequence = useRef(0)
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const next = await listTargets()
      if (!mounted.current || sequence !== refreshSequence.current) return
      setState(next)
      setCandidate(current => next.items.some(item => item.grantId === current)
        ? current
        : next.selectedGrantId)
      setMessage('')
    } catch {
      if (!mounted.current || sequence !== refreshSequence.current) return
      setMessage('暂时无法读取本地电脑状态')
    }
  }, [listTargets])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15_000)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      refreshSequence.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const choose = async () => {
    /* v8 ignore next -- the confirmation button is disabled for every guarded state */
    if (candidate === null || state === null || busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await selectTarget(candidate, state.publicationVersion)
      if (!mounted.current) return
      setState(result)
      if (result.reloadRequired) reload()
      else setOpen(false)
    } catch (error: unknown) {
      if (error instanceof SelectionConflictError) {
        await refresh()
        if (!mounted.current) return
        setMessage('选择已在其他页面变化，请重新确认')
      } else if (mounted.current) {
        setMessage('切换失败，请稍后重试')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const label = selectedLabel(state)
  const trigger = (
    <button
      type="button"
      className={`${css.trigger} ${wide ? css.wide : css.rail}`}
      aria-label={`本地电脑：${label}`}
      onClick={() => { setOpen(true); void refresh() }}
    >
      <span className={css.computer} aria-hidden="true"><span /></span>
      {wide ? <span className={css.summary}><strong>本地电脑</strong><small>{label}</small></span> : null}
      {wide && state?.selectionRequired ? <span className={css.required}>需选择</span> : null}
    </button>
  )

  return (
    <>
      <Tooltip label={`本地电脑：${label}`} delayMs={500} disabled={wide}>{trigger}</Tooltip>
      <Modal
        open={open}
        onClose={() => { if (!busy) setOpen(false) }}
        title="选择本地电脑"
        closeLabel="关闭"
        description="文件操作只会访问所选电脑中已授权的工作区。"
        footer={<><Button variant="outline" onClick={() => { setOpen(false) }} disabled={busy}>取消</Button><Button variant="primary" onClick={() => { void choose() }} disabled={candidate === null || busy}>{busy ? '切换中…' : '确认切换'}</Button></>}
      >
        <div className={css.list} role="radiogroup" aria-label="可用本地电脑">
          {state?.items.map((item) => {
            const title = item.computerLabel ?? item.displayCode ?? '本地电脑'
            return (
              <label key={item.grantId} className={`${css.option} ${candidate === item.grantId ? css.selected : ''}`}>
                <input type="radio" name="slark-local-computer" checked={candidate === item.grantId} onChange={() => { setCandidate(item.grantId) }} />
                <span><strong>{title}</strong><small>{item.workspaceAlias} · {item.mode === 'read_write' ? '可读写' : '只读'}</small></span>
              </label>
            )
          })}
          {state?.items.length === 0 ? <p className={css.empty}>暂无已授权且在线的本地电脑，请先在 Slark Desktop 完成授权。</p> : null}
          {state === null && message === '' ? <p className={css.empty}>正在读取…</p> : null}
        </div>
        {message ? <p className={css.error} role="status">{message}</p> : null}
      </Modal>
    </>
  )
}
