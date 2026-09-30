/** Session-bound employee Agent task strip, backed by Slark's durable invocation list. */
import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAgentInvocation } from './index.ts'

type Props = PropsRuntime<'conversation.input.dock'> & PropsLocale<'slarkAgent'> & {
  sessionId: SessionId
}

/** Results remain in their original Session and are reloaded after a page restart. */
export function AgentTaskDock({ sessionId, t }: Props) {
  const [items, setItems] = useState<readonly DesktopAgentInvocation[]>([])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let active = true
    let pending = false
    const load = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const result = await window.__DSH_DESKTOP_HOST__?.enterpriseAgentInvocations?.({ session_id: sessionId })
        if (active) setItems(result?.ok ? result.value.items : [])
      } catch {
        if (active) setItems([])
      } finally { pending = false }
    }
    void load()
    const refresh = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === sessionId) void load()
    }
    window.addEventListener('dsh-slark-agent-admitted', refresh)
    const timer = window.setInterval(() => { setNow(Date.now()); void load() }, 3_000)
    return () => { active = false; window.clearInterval(timer)
      window.removeEventListener('dsh-slark-agent-admitted', refresh) }
  }, [sessionId])
  if (items.length === 0) return null
  return <section aria-label={t('task.title')} style={{ border: '1px solid #aaa', borderRadius: 8,
    padding: 10, maxHeight: 240, overflow: 'auto', flexShrink: 0,
    background: 'var(--surface, #fff)' }}>
    <strong>{t('task.title')}</strong>
    {items.map((item) => {
      const old = now - Date.parse(item.created_at) >= 120_000
      return <div key={item.invocation_id} style={{ borderTop: '1px solid #ddd', marginTop: 8, paddingTop: 8 }}>
        <div><strong>{item.agent_name}</strong> · {item.enterprise_name} / {item.project_name}</div>
        <small>{item.invocation_id} · {item.state === 'succeeded' ? t('task.done')
          : item.state === 'accepted' || item.state === 'running'
            ? old ? t('task.background') : t('task.waiting') : t('task.failed')}</small>
        {item.question != null && <div style={{ marginTop: 6 }}>
          <strong>{t('task.question')}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{item.question}</div>
        </div>}
        {item.answer !== null && <div style={{ marginTop: 6 }}>
          <strong>{t('task.answer')}</strong>
          <div style={{ whiteSpace: 'pre-wrap' }}>{item.answer}</div>
        </div>}
      </div>
    })}
  </section>
}
