// @vitest-environment jsdom
/** REQ-20260930-0004: built Web composer and task dock against an external Desktop bridge fixture. */
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'
import { installRemoteCollaboration } from '../src/remote-collaboration.ts'
type WorkspaceRequest = { workspace_id: string
  operation: { kind: 'get' | 'apply' | 'projects' | 'agents'
    selected_project_ids?: readonly string[] } }

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/slark-agent-composer/natural-language.expected.txt')

installAssembledBootEnv()
afterEach(() => { window.dispatchEvent(new Event('pagehide')); Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__') })

it('clicking Send in root mode dispatches the frozen task and displays its reply without a panel action', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const workspace = '38c7c5cb-38fc-466f-9d92-89cc49f84051', trace = 'b'.repeat(32)
  type Source = { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }
  let original: { source: Source; snapshot_digest: string; original_message: string } | undefined
  let dispatched = false
  const submit = vi.fn(async (input: Source & { original_message: string }) => {
    const source = { workspace_id: input.workspace_id, session_id: input.session_id,
      source_message_id: input.source_message_id, source_revision: input.source_revision }
    original = { source, snapshot_digest: 'a'.repeat(64), original_message: input.original_message }
    return { ok: true, value: { source, submission_state: 'planning_recorded',
      root_task_id: 'bfb432fd-a2a2-4cbd-b1dc-4648c8944081', root_trace_id: trace } }
  })
  const execute = vi.fn(async (request: { action: string; source?: Source; previewId?: string; taskId?: string }) => {
    if (request.action === 'preview') {
      expect(request.source).toEqual(original?.source)
      return { ok: true, rootTraceId: trace, previewId: 'preview', executionEnabled: true,
        tasks: [{ taskId: 'task', question: 'check login', agentName: 'Guide', projectName: 'Product' }] }
    }
    expect(request).toEqual({ action: 'confirm', previewId: 'preview', taskId: 'task' })
    dispatched = true
    return { ok: true, status: 'recorded' }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', {
    collaborationScopeAvailable: true, collaborationPlanningAvailable: true, collaborationExecutionAvailable: false,
    collaborationSubmit: submit, collaborationRootExecution: execute,
    collaborationPending: async ({ source }: { source: Source }) => ({ ok: true,
      value: { source, plan: null, pending_items: [], frozen_task_count: 1 } }),
    collaborationDeliveries: async ({ source }: { source: Source }) => ({ ok: true, value: { deliveries: dispatched ? [{
      delivery_id: 'delivery', invocation_id: 'invocation', delivery_state: 'pending', delivery_state_version: '1',
      source_locator: source, source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded', invocation_state_version: '2',
      target_display_snapshot: { agent_name: 'Guide', project_name: 'Product' }, answer: 'Login checked.' }] : [] } }),
    collaborationWorkspace: async ({ workspace_id, operation }: WorkspaceRequest) => operation.kind === 'get'
      ? { ok: true, value: { workspace_id, version: '1', selected_project_ids: ['product'] } }
      : { ok: true, value: { items: [{ project_id: 'product', project_name: 'Product', agent_id: 'guide', agent_name: 'Guide',
        available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' }], next_cursor: null, scope_version: '1' } },
  })
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'], remote: { workspaceId: workspace } })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  remote.mock.unary('session/collaborationSources', () => ({ ok: true, value: { items: original ? [original] : [] } }))
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace action missing')
  fireEvent.click(start)
  const input = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (!element) throw Error('composer missing')
    return element
  }, { timeout: 10_000 })
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => '@Gui' } })
  fireEvent.mouseDown(await screen.findByRole('option', { name: /Guide · Product/ }, { timeout: 10_000 }))
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'check login' } })
  const send = await screen.findByRole('button', { name: 'Send message' })
  expect(send.hasAttribute('disabled')).toBe(false)
  fireEvent.click(send)
  await waitFor(() => { expect(input.textContent).toBe('') }, { timeout: 10_000 })
  await screen.findByText(`Tasks dispatched. Trace ID: ${trace}`)
  await screen.findByText('Login checked.', {}, { timeout: 10_000 })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls.map(([request]) => request.action)).toEqual(['preview', 'confirm'])
  expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  await expect([`original=${original?.original_message}`, 'planning-receipts=1', 'execution=preview,confirm',
    `notice=Tasks dispatched. Trace ID: ${trace}`, 'reply=Login checked.', 'ordinary-model-prompts=0', 'draft=empty',
  ].join('\n') + '\n').toMatchFileSnapshot(join(process.cwd(),
    'apps/web/tests/expected/slark-agent-composer/root-send.expected.txt'))
})

it('sends two scoped Agents from the built composer as one original message without opening a task form', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const workspace = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
  type Source = { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }
  type Input = Source & { original_message: string
    active_mentions: readonly {
      mention_id: string
      source_span: { source_message_id: string; source_revision: string; start: number; end: number }
      display_snapshot: { agent_name: string; project_name: string }
      binding: { kind: string; target: { project_id: string; agent_id: string }; capability_snapshot: string }
    }[] }
  const legacy = vi.fn()
  const submit = vi.fn(async (input: Input) => ({ ok: true, value: {
    source: { workspace_id: input.workspace_id, session_id: input.session_id,
      source_message_id: input.source_message_id, source_revision: input.source_revision },
    submission_state: 'accepted', invocation_id: 'batch-accepted',
  } }))
  const workspaceCall = async ({ workspace_id, operation }: WorkspaceRequest) => {
    if (operation.kind === 'get') return { ok: true,
      value: { workspace_id, version: '1', selected_project_ids: ['product', 'engineering'] } }
    return { ok: true, value: { items: [
      { project_id: 'product', project_name: 'Product', agent_id: 'guide', agent_name: 'Guide',
        available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' },
      { project_id: 'engineering', project_name: 'Engineering', agent_id: 'tester', agent_name: 'Tester',
        available: true, capability_snapshot: 'b'.repeat(64), reason_code: 'ready' },
    ], next_cursor: null, scope_version: '1' } }
  }
  await installRemoteCollaboration(async (path, init) => {
    if (String(path) === '/__collaboration__') return Response.json({ schema: 'dsh-remote-collaboration/v1',
      methods: ['workspace', 'submit', 'pending', 'deliveries'] })
    if (typeof init?.body !== 'string') throw Error('missing parent request')
    const rpc = JSON.parse(init.body) as { rpcId: string; method: string; payload: { args: { request: unknown } } }
    const value = rpc.method === 'collaboration/workspace' ? await workspaceCall(rpc.payload.args.request as WorkspaceRequest)
      : rpc.method === 'collaboration/submit' ? await submit(rpc.payload.args.request as Input)
        : rpc.method === 'collaboration/deliveries' ? { ok: true, value: { deliveries: [] } }
          : { ok: false, errorCode: 'collaboration_result_unavailable' }
    return Response.json({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } })
  })
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'], remote: { workspaceId: workspace } })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  remote.mock.unary('session/collaborationSources', { ok: true, value: { items: [] } })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace action missing')
  fireEvent.click(start)
  const input = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (!element) throw Error('composer missing')
    return element
  }, { timeout: 10_000 })
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => '@Gui' } })
  fireEvent.mouseDown(await screen.findByRole('option', { name: /Guide · Product/ }, { timeout: 10_000 }))
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'check login; @Tes' } })
  fireEvent.mouseDown(await screen.findByRole('option', { name: /Tester · Engineering/ }, { timeout: 10_000 }))
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'test the redirect' } })
  const original = '@Guide · Product check login; @Tester · Engineering test the redirect'
  await waitFor(() => { expect(input.textContent).toBe(original) })
  expect(input.querySelectorAll('[data-composer-chip="slark-agent"]')).toHaveLength(2)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(submit).toHaveBeenCalledTimes(1); expect(input.textContent).toBe('') }, { timeout: 10_000 })
  const sent = submit.mock.calls[0]?.[0]
  if (!sent) throw Error('original submission missing')
  expect(sent.original_message).toBe(original)
  expect(sent.workspace_id).toBe(workspace)
  expect(sent.active_mentions).toHaveLength(2)
  expect(new Set(sent.active_mentions.map(mention => mention.mention_id)).size).toBe(2)
  for (const mention of sent.active_mentions) {
    expect(mention.source_span.source_message_id).toBe(sent.source_message_id)
    expect(mention.source_span.source_revision).toBe(sent.source_revision)
    expect(sent.original_message.slice(mention.source_span.start, mention.source_span.end))
      .toBe(`@${mention.display_snapshot.agent_name} · ${mention.display_snapshot.project_name}`)
  }
  expect(legacy).not.toHaveBeenCalled()
  expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  const host: unknown = Reflect.get(window, '__DSH_DESKTOP_HOST__')
  if (host === null || typeof host !== 'object') throw Error('missing execution consumer')
  await expect([`parent-execution=${String(Reflect.get(host, 'collaborationExecutionAvailable'))}`, `original=${sent.original_message}`,
    ...sent.active_mentions.map(mention => `target=${mention.binding.target.project_id}/${mention.binding.target.agent_id}`),
    'shared-original-source=true', 'distinct-mention-ids=2', 'original-submissions=1', 'ordinary-model-prompts=0', 'draft=empty',
  ].join('\n') + '\n').toMatchFileSnapshot(join(process.cwd(),
    'apps/web/tests/expected/slark-agent-composer/multiple-agents.expected.txt'))
})

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

it('saves multiple Slark spaces in the built collaboration area and never invokes the legacy Agent entry', async () => {
  let selected: readonly string[] = [], version = 0
  const legacy = vi.fn()
  const bridge = vi.fn(async ({ workspace_id, operation }: WorkspaceRequest) => {
    if (operation.kind === 'apply') { selected = operation.selected_project_ids ?? []; version++ }
    if (operation.kind === 'get' || operation.kind === 'apply') return { ok: true,
      value: { workspace_id, version: String(version), selected_project_ids: selected } }
    if (operation.kind === 'projects') return { ok: true, value: { items: [
      { project_id: 'product', project_name: 'Product' }, { project_id: 'engineering', project_name: 'Engineering' },
    ], next_cursor: null } }
    return { ok: true, value: { items: selected.length ? [{ project_id: 'product', project_name: 'Product',
      agent_id: 'guide', agent_name: 'Guide', available: false, capability_snapshot: 'a'.repeat(64),
      reason_code: 'executor_unavailable' }] : [], next_cursor: null, scope_version: String(version) } }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { collaborationScopeAvailable: true, collaborationExecutionAvailable: false,
    collaborationWorkspace: bridge, enterpriseAgents: legacy, invokeEnterpriseAgent: legacy })
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'] })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace action missing')
  fireEvent.click(start)
  const panel = await screen.findByRole('region', { name: 'Slark collaboration' }, { timeout: 10_000 })
  fireEvent.click(within(panel).getByTestId('slark-scope-toggle'))
  fireEvent.click(await within(panel).findByRole('checkbox', { name: 'Product' }))
  fireEvent.click(within(panel).getByRole<HTMLInputElement>('checkbox', { name: 'Engineering' }))
  fireEvent.click(within(panel).getByTestId('slark-scope-apply'))
  await within(panel).findByText('Guide · Product')
  const observations = [
    `region=${panel.getAttribute('aria-label')}`,
    `selected=${selected.join(',')}`,
    `agent=${within(panel).getByText('Guide · Product').textContent}`,
    `availability=${within(panel).getByText('Read-only').textContent}`,
  ]
  fireEvent.click(within(panel).getByTestId('slark-scope-clear'))
  fireEvent.click(within(panel).getByTestId('slark-scope-cancel'))
  fireEvent.click(within(panel).getByTestId('slark-scope-toggle'))
  expect((within(panel).getByRole<HTMLInputElement>('checkbox', { name: 'Product' })).checked).toBe(true)
  expect(bridge.mock.calls.filter(([x]) => x.operation.kind === 'apply')).toHaveLength(1)
  observations.push(`cancel-retains=${selected.join(',')}`)
  const input = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
  if (!input) throw Error('composer missing')
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => '@Gui' } })
  await waitFor(() => { expect(input.textContent).toBe('@Gui') })
  await waitFor(() => { expect(screen.queryByRole('option', { name: /Guide · Product/ })).toBeNull() })
  expect(legacy).not.toHaveBeenCalled(); expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  observations.push(`legacy-calls=${legacy.mock.calls.length}`)
  expect(screen.queryByTestId('slark-collaboration-results')).toBeNull()
  expect(remote.mock.log.calls('session/collaborationSources')).toHaveLength(0)
  observations.push('history=unmounted', 'source-reads=0')
  await expect(observations.join('\n') + '\n').toMatchFileSnapshot(join(process.cwd(),
    'apps/web/tests/expected/slark-agent-composer/project-scope.expected.txt'))
})

it('asks a natural question in the built composer and accepts a plain clarification without another @ or a task form', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const workspace = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
  type Source = { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }
  type Input = Source & { original_message: string; active_mentions: readonly unknown[] }
  let original: Input | undefined, completed = false
  const legacy = vi.fn()
  const submit = vi.fn(async (input: Input) => {
    original = input
    return { ok: false, errorCode: 'pending', reconciliationRequired: true }
  })
  const clarify = vi.fn(async (input: { source: Source; reply_input: Input }) => {
    completed = true
    return { ok: true, value: { source: input.source, submission_state: 'accepted', invocation_id: 'clarified' } }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { collaborationScopeAvailable: true, collaborationExecutionAvailable: true,
    collaborationWorkspace: async ({ workspace_id, operation }: WorkspaceRequest) => {
      if (operation.kind === 'get') return { ok: true, value: { workspace_id, version: '1', selected_project_ids: ['product'] } }
      return { ok: true, value: { items: [{ project_id: 'product', project_name: 'Product', agent_id: 'guide', agent_name: 'Guide',
        available: true, capability_snapshot: 'a'.repeat(64), reason_code: 'ready' }], next_cursor: null, scope_version: '1' } }
    },
    collaborationSubmit: submit, collaborationClarify: clarify,
    collaborationPending: async ({ source }: { source: Source }) => ({ ok: true, value: { source,
      plan: { plan_id: 'pending-plan', plan_revision: '3', state_version: '3', input_version: '1',
        planning_state: completed ? 'ready' : 'clarify', route_decision: 'collaboration' },
      frozen_task_count: completed ? 1 : 0, pending_items: completed ? [] : [{ pending_item_id: 'pending', revision: '1', reason: 'task_ambiguous',
        question: 'Which login problem should I check?', mentions: [{ mention_id: 'guide', agent_name: 'Guide', project_name: 'Product' }] }] } }),
    collaborationDeliveries: async () => ({ ok: true, value: { deliveries: [] } }),
    enterpriseAgents: legacy, invokeEnterpriseAgent: legacy,
  })
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'], remote: { workspaceId: workspace } })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  remote.mock.unary('session/collaborationSources', () => ({ ok: true, value: { items: original ? [{
    source: { workspace_id: original.workspace_id, session_id: original.session_id,
      source_message_id: original.source_message_id, source_revision: original.source_revision },
    snapshot_digest: 'a'.repeat(64), original_message: original.original_message }] : [] } }))
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace action missing')
  fireEvent.click(start)
  const input = await waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]')
    if (!element) throw Error('composer missing')
    return element
  }, { timeout: 10_000 })
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => '@Gui' } })
  fireEvent.mouseDown(await screen.findByRole('option', { name: /Guide · Product/ }, { timeout: 10_000 }))
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'please check login' } })
  await waitFor(() => { expect(input.textContent).toContain('@Guide · Product') })
  fireEvent.keyDown(input, { key: 'Enter' })
  const question = await screen.findByText('Guide · Product Which login problem should I check?', { exact: true }, { timeout: 10_000 })
  await waitFor(() => { expect(input.textContent).toBe('') })
  const observations = [`question=${question.textContent}`, `original=${original?.original_message}`]
  fireEvent.paste(input, { clipboardData: { items: [], getData: () => 'Please check the redirect to the home page.' } })
  await waitFor(() => { expect(input.textContent).toBe('Please check the redirect to the home page.') })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => { expect(clarify).toHaveBeenCalledTimes(1); expect(input.textContent).toBe('') }, { timeout: 10_000 })
  const reply = clarify.mock.calls[0]![0]
  expect(reply.source.source_message_id).toBe(original?.source_message_id)
  expect(reply.reply_input.active_mentions).toEqual([])
  expect(reply.reply_input.source_message_id).toMatch(/^clarify-[a-f0-9]{64}$/u)
  expect(legacy).not.toHaveBeenCalled(); expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  observations.push(`reply=${reply.reply_input.original_message}`, 'new-active-mentions=0', 'original-submissions=1',
    'clarification-submissions=1', 'ordinary-model-prompts=0', 'draft=empty')
  await expect(observations.join('\n') + '\n').toMatchFileSnapshot(join(process.cwd(),
    'apps/web/tests/expected/slark-agent-composer/clarification.expected.txt'))
})

it('reads original-root collaboration history from the built Trajectory tab without executing work', async () => {
  const workspace = '38c7c5cb-38fc-466f-9d92-89cc49f84051'
  const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '2', state_version: '3', state: 'active', intent_state: 'active' }
  const trace = vi.fn(async (request: { action: string; cursor: { evidence?: { event_id: string } } }) => {
    if (request.action !== 'trace') throw Error('history must not execute')
    return { ok: true, value: { root, coverage: 'partial', next_after_seq: null,
      events: [{ event_id: 'settlement', root_seq: 1, task_revision: 1, type: 'execution_observed', phase: 'execution_succeeded',
        occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
        trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1, attempt_id: 'attempt' } }],
      ...(request.cursor.evidence ? { execution: { event_id: 'settlement', attempt_id: 'attempt', state: 'succeeded',
        digest: 'a'.repeat(64), next_after_sequence: null, provider_visibility: 'boundary_only',
        events: [{ sequence: 1, observedAt: 1791331200000, type: 'file.completed', runtimeId: 'file-proof', success: true }] } } : {}) } }
  })
  Reflect.set(window, '__DSH_DESKTOP_HOST__', { collaborationScopeAvailable: true, collaborationPlanningAvailable: true,
    collaborationExecutionAvailable: false, collaborationRootExecution: trace,
    collaborationDeliveries: async () => ({ ok: true, value: { deliveries: [] } }),
    collaborationWorkspace: async () => ({ ok: true, value: { workspace_id: workspace, version: '1', selected_project_ids: [] } }),
  })
  const remote = mountAssembledApp({ exclude: ['@deepseek-ai/dsh-client-ui-settings-models'], remote: { workspaceId: workspace } })
  remote.mock.unary('fileReferences/list', { ok: true, value: [] })
  remote.mock.unary('sessionReferenceResolver/candidates', { ok: true, value: [] })
  remote.mock.unary('session/collaborationSources', (input: unknown) => {
    if (!input || typeof input !== 'object') throw Error('request missing')
    const request: unknown = Reflect.get(input, 'request')
    if (!request || typeof request !== 'object') throw Error('session request missing')
    const sessionId: unknown = Reflect.get(request, 'sessionId')
    if (typeof sessionId !== 'string') throw Error('session missing')
    return { ok: true, value: { items: [{ source: { workspace_id: workspace, session_id: sessionId,
      source_message_id: 'original', source_revision: '1' }, snapshot_digest: 'a'.repeat(64), original_message: 'Check the recorded file operation' }] } }
  })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (!start) throw Error('fixture Workspace action missing')
  fireEvent.click(start)
  await waitFor(() => { expect(remote.mock.log.calls('session/collaborationSources').length).toBeGreaterThan(0) })
  await screen.findByText('Check the recorded file operation', {}, { timeout: 10_000 })
  fireEvent.click(await screen.findByRole('tab', { name: 'Trajectory' }, { timeout: 10_000 }))
  const panel = await screen.findByTestId('slark-collaboration-trajectory', {}, { timeout: 10_000 })
  fireEvent.click(within(panel).getByTestId('slark-trace-load'))
  await within(panel).findByText(root.root_trace_id)
  expect(panel.textContent).toContain('Original task in progress')
  expect(panel.textContent).toContain('Remote execution succeeded')
  fireEvent.click(within(panel).getByTestId('slark-trace-execution'))
  await within(panel).findByText('file-proof')
  expect(panel.textContent).toContain('2026-10-07T00:00:00.000Z')
  expect(remote.mock.log.calls('session/prompt')).toHaveLength(0)
  expect(trace.mock.calls.every(([request]) => request.action === 'trace')).toBe(true)
  await expect([`trace=${root.root_trace_id}`, 'root=active', 'execution=succeeded', 'revision=2', 'runtime=file.completed',
    'provider-visibility=boundary-only', 'ordinary-model-prompts=0', 'commands=trace-only'].join('\n') + '\n')
    .toMatchFileSnapshot(join(process.cwd(), 'apps/web/tests/expected/slark-agent-composer/trajectory.expected.txt'))
})
