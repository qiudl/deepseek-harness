// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentTaskDock } from '../src/client/AgentTaskDock.tsx'

afterEach(() => { cleanup(); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('reloads the original Session answer and removes it when authority is revoked', async () => {
  const item = { invocation_id: 'invocation-1', project_id: 'project-1',
    session_id: 'session-1', agent_name: 'Agent', project_name: 'Project',
    enterprise_name: 'Company', state: 'succeeded', answer: 'Private answer',
    failure_code: null, created_at: new Date().toISOString(), terminal_at: new Date().toISOString() }
  const list = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { items: [item], total: 1 } })
    .mockResolvedValue({ ok: true, value: { items: [{ ...item, state: 'revoked',
      answer: null, failure_code: 'authority_changed' }], total: 1 } })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { enterpriseAgentInvocations: list })
  const props = { sessionId: 'session-1' as SessionId,
    t: (key: string) => key } as unknown as Parameters<typeof AgentTaskDock>[0]
  render(<AgentTaskDock {...props} />)
  expect(await screen.findByText('Private answer')).toBeTruthy()
  window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted', { detail: 'session-1' }))
  await waitFor(() => { expect(screen.queryByText('Private answer')).toBeNull() })
  expect(list).toHaveBeenCalledWith({ session_id: 'session-1' })
})
