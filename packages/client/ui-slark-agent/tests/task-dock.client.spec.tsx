// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentTaskDock } from '../src/client/AgentTaskDock.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('reloads the original Session answer and removes it when authority is revoked', async () => {
  const item = { invocation_id: 'invocation-1', project_id: 'project-1',
    session_id: 'session-1', agent_name: 'Agent', project_name: 'Project',
    enterprise_name: 'Company', question: 'Original employee question', state: 'succeeded', answer: 'Private answer',
    failure_code: null, created_at: new Date().toISOString(), terminal_at: new Date().toISOString() }
  const list = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { items: [item], total: 1 } })
    .mockResolvedValue({ ok: true, value: { items: [{ ...item, state: 'revoked',
      question: null, answer: null, failure_code: 'authority_changed' }], total: 1 } })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  render(<AgentTaskDock {...props} />)
  expect(await screen.findByText('Private answer')).toBeTruthy()
  expect(screen.getByText('Original employee question')).toBeTruthy()
  window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted', { detail: 'session-1' }))
  await waitFor(() => { expect(screen.queryByText('Private answer')).toBeNull() })
  expect(screen.queryByText('Original employee question')).toBeNull()
  expect(list).toHaveBeenCalledWith({ session_id: 'session-1' })
})

it('shows waiting, background, and failed tasks after refresh', async () => {
  const created = new Date(Date.now() - 130_000).toISOString()
  const base = { invocation_id: 'invocation-1', project_id: 'project-1',
    session_id: 'session-1', agent_name: 'Agent', project_name: 'Project',
    enterprise_name: 'Company', question: 'Original employee question', state: 'accepted', answer: null,
    failure_code: null, created_at: new Date().toISOString(), terminal_at: null }
  const list = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { items: [base], total: 1 } })
    .mockResolvedValueOnce({ ok: true, value: { items: [{ ...base, state: 'running',
      created_at: created }], total: 1 } })
    .mockResolvedValue({ ok: true, value: { items: [{ ...base, state: 'failed' }], total: 1 } })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  let tick: (() => void) | undefined
  const actualSetInterval = window.setInterval.bind(window)
  const interval = vi.spyOn(window, 'setInterval').mockImplementation((fn, delay, ...args) => {
    if (delay === 3_000) {
      tick = fn as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }
    return actualSetInterval(fn, delay, ...args) as unknown as ReturnType<typeof setInterval>
  })
  const clear = vi.spyOn(window, 'clearInterval')
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  const view = render(<AgentTaskDock {...props} />)
  expect(await screen.findByText(/task.waiting/)).toBeTruthy()
  expect(screen.getByText('Original employee question')).toBeTruthy()
  if (!tick) throw new Error('task timer was not installed')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
  await act(async () => { tick?.() })
  clock.mockRestore()
  expect(await screen.findByText(/task.background/)).toBeTruthy()
  window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted', { detail: 'other-session' }))
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { tick?.() })
  expect(await screen.findByText(/task.failed/)).toBeTruthy()
  view.unmount()
  expect(clear).toHaveBeenCalledWith(1)
  interval.mockRestore()
  clear.mockRestore()
})

it('keeps one request in flight and ignores late responses after unmount', async () => {
  let resolve!: (value: unknown) => void
  const list = vi.fn(() => new Promise((resolveFn) => { resolve = resolveFn }))
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  const view = render(<AgentTaskDock {...props} />)
  window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted', { detail: 'session-1' }))
  expect(list).toHaveBeenCalledTimes(1)
  view.unmount()
  await act(async () => { resolve({ ok: true, value: { items: [], total: 0 } }) })
  let reject!: (reason: Error) => void
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations:
    () => new Promise((_resolve, rejectFn) => { reject = rejectFn }) })
  const second = render(<AgentTaskDock {...props} />)
  second.unmount()
  await act(async () => { reject(new Error('late failure')) })
})

it('clears tasks when the list fails or the Desktop bridge is unavailable', async () => {
  const item = { invocation_id: 'invocation-1', project_id: 'project-1',
    session_id: 'session-1', agent_name: 'Agent', project_name: 'Project',
    enterprise_name: 'Company', question: 'Original employee question', state: 'succeeded', answer: 'Private answer',
    failure_code: null, created_at: new Date().toISOString(), terminal_at: null }
  const list = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { items: [item], total: 1 } })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ ok: false, errorCode: 'revoked' })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  render(<AgentTaskDock {...props} />)
  expect(await screen.findByText('Private answer')).toBeTruthy()
  expect(screen.getByText('Original employee question')).toBeTruthy()
  await act(async () => { window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted',
    { detail: 'session-1' })) })
  expect(screen.queryByText('Private answer')).toBeNull()
  await act(async () => { window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted',
    { detail: 'session-1' })) })
  expect(list).toHaveBeenCalledTimes(3)
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
  await act(async () => { window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted',
    { detail: 'session-1' })) })
  expect(screen.queryByText('Private answer')).toBeNull()
})


it('restores the exact multiline question from the server after reopening the session', async () => {
  const question = '第一行 <script>\n  第二行 & 原文'
  const item = { invocation_id: 'invocation-1', project_id: 'project-1',
    session_id: 'session-1', agent_name: 'Agent', project_name: 'Project',
    enterprise_name: 'Company', question, state: 'succeeded', answer: 'Done',
    failure_code: null, created_at: new Date().toISOString(), terminal_at: null }
  const list = vi.fn().mockResolvedValue({ ok: true, value: { items: [item], total: 1 } })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  const first = render(<AgentTaskDock {...props} />)
  await screen.findByText('Done')
  first.unmount()
  const reopened = render(<AgentTaskDock {...props} />)
  await screen.findByText('Done')
  const original = screen.getByText((_text, element) => element?.textContent === question)
  expect(original.textContent).toBe(question)
  expect(original.style.whiteSpace).toBe('pre-wrap')
  expect(reopened.container.querySelector('script')).toBeNull()
  expect(list).toHaveBeenCalledTimes(2)
})
