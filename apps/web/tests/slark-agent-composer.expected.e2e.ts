// @vitest-environment jsdom
/** REQ-20260930-0004: built Web composer and task dock against an external Desktop bridge fixture. */
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/slark-agent-composer/natural-language.expected.txt')

installAssembledBootEnv()
afterEach(() => { Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('shows the project space, retries an edited inline task, and renders its reply in the originating Session', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const agent = { assignment_id: 'assignment-1', project_id: 'project-1', agent_id: 'agent-1',
    enterprise_id: 'enterprise-1', enterprise_name: 'Company', project_name: 'qiu-slark',
    name: 'Guide', publication_version: 2 }
  type InvocationInput = { session_id: string; logical_key: string; question: string }
  let accepted: InvocationInput | undefined
  const invoke = vi.fn(async (input: InvocationInput) => {
    if (!accepted) {
      accepted = input
      return { ok: false, errorCode: 'offline' }
    }
    accepted = input
    return { ok: true, value: { invocation_id: 'invocation-1', state: 'accepted' } }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {
    enterpriseAgents: async () => ({ ok: true, invocationAvailable: true, items: [agent] }),
    invokeEnterpriseAgent: invoke,
    enterpriseAgentInvocations: async ({ session_id }: { session_id: string }) => ({ ok: true,
      value: { total: invoke.mock.calls.length > 1 ? 1 : 0,
        items: invoke.mock.calls.length > 1 && accepted?.session_id === session_id ? [{
          invocation_id: 'invocation-1', project_id: agent.project_id, session_id,
          agent_name: agent.name, project_name: agent.project_name, enterprise_name: agent.enterprise_name,
          state: 'succeeded', question: accepted.question, answer: 'Login checked.', failure_code: null,
          created_at: '2026-10-02T00:00:00Z', terminal_at: '2026-10-02T00:00:01Z',
        }] : [] } }),
  })
  // Provider onboarding needs Host settings absent from this Desktop fixture; retain the actual composer and reference sources.
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'] })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace new-session action missing')
  fireEvent.click(start)
  const input = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (!element) throw Error('composer missing')
    return element
  }, { timeout: 10_000 })
  // jsdom has no editable beforeinput; paste drives the mounted editor at its actual caret.
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'Please @Gui' } })
  const option = await screen.findByRole('option', { name: /Guide · qiu-slark/ }, { timeout: 10_000 })
  expect(option.textContent).toContain('Company / qiu-slark')
  fireEvent.mouseDown(option)
  const chip = await waitFor(() => {
    const element = input.querySelector('[data-composer-chip="slark-agent"]')
    if (!element) throw Error('Agent chip missing')
    expect(element.textContent).toBe('@Guide · qiu-slark')
    return element
  })
  const observations = [`chip=${chip.textContent}`]
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'check login' } })
  await waitFor(() => { expect(input.textContent).toBe('Please @Guide · qiu-slark check login') })
  fireEvent.keyDown(input, { key: 'Enter' })
  const error = await waitFor(() => {
    const element = screen.queryAllByRole('alert').find(candidate =>
      candidate.textContent === 'Slark Agent invocation is unavailable. Try again later.')
    if (!element) throw Error('Slark submit error missing')
    return element
  }, { timeout: 10_000 })
  observations.push(`error=${error.textContent}`, `retained=${input.textContent}`)
  expect(invoke).toHaveBeenCalledTimes(1)
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => ' and suggest a fix' } })
  await waitFor(() => { expect(input.textContent).toContain('and suggest a fix') })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(input.textContent).toBe('') }, { timeout: 10_000 })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(invoke.mock.calls[0]?.[0].logical_key).not.toBe(invoke.mock.calls[1]?.[0].logical_key)
  const dock = await screen.findByRole('region', { name: 'Agent tasks' }, { timeout: 10_000 })
  expect(within(dock).getByText('Login checked.')).toBeDefined()
  expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  observations.push(`question=${accepted?.question}`, `reply=${dock.textContent}`, 'ordinary-model-prompts=0', 'draft=empty')
  await expect(observations.join('\n') + '\n').toMatchFileSnapshot(EXPECTED)
})
