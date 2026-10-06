// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { workspaceSnapshot, dockRuntime, dockTranslate } from './fixture-state.client.ts'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import type { CollaborationResultsBridge } from '../src/client/collaboration-results.ts'
import { CollaborationResultsDock } from '../src/client/CollaborationResultsDock.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const source = { workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session', source_message_id: 'message', source_revision: '1' }
function fixture(answer = '完整回复', workspace = false) {
  const original = { source, snapshot_digest: 'a'.repeat(64), original_message: '@Guide · Project 检查页面' }
  const item = { delivery_id: 'delivery', invocation_id: 'invocation', delivery_state: 'pending', delivery_state_version: '1', source_locator: source,
    source_snapshot_digest: original.snapshot_digest, execution_state: 'succeeded', invocation_state_version: '2',
    target_display_snapshot: { agent_name: '<script>Guide', project_name: 'Project' }, answer }
  const read = vi.fn<NonNullable<CollaborationResultsBridge['collaborationDeliveries']>>(async () => ({ ok: true, value: { deliveries: [item] } }))
  const bridge: CollaborationResultsBridge = { collaborationScopeAvailable: true, collaborationDeliveries: read }
  const readSources = vi.fn<ConstructorParameters<typeof CollaborationResultsModel>[3]>(async () =>
    ({ ok: true, value: { items: [original] } }))
  const model = new CollaborationResultsModel(SessionId('session'), { getSnapshot: () => workspaceSnapshot(source.workspace_id), subscribe: () => () => {} },
    { getSnapshot: () => 1, subscribe: () => () => {} }, readSources,
    () => bridge, workspace ? 'workspace' : 'session')
  onTestFinished(() => { model.dispose() })
  const props: Parameters<typeof CollaborationResultsDock>[0] = { ...dockRuntime(),
    useSlarkResults: <T,>(selector: (s: ReturnType<typeof model.getSnapshot>) => T) =>
      selector(useSyncExternalStore(model.subscribe, model.getSnapshot)), loadSources: () => model.loadSources(),
    consumptionAction: (digest, deliveryId, reconcile) => model.consumptionAction(digest, deliveryId, reconcile),
    executionAction: (digest, taskId, reconcile) => model.executionAction(digest, taskId, reconcile),
    loadReplies: (id: string) => model.loadReplies(id), t: dockTranslate }
  return { model, read, readSources, props, original, item, bridge }
}
it('labels workspace history separately from the current Session history', async () => {
  const f = fixture('完整回复', true), view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByText(zh['task.workspaceHistory'])
  expect(screen.queryByText(zh['task.collaborationHistory'])).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  view.unmount()
})
it('automatically displays the original message and complete plain text result without a task form', async () => {
  const prefix = '<img src=x onerror=alert(1)>\n'
  const answer = prefix + 'x'.repeat(128 * 1024 - prefix.length)
  const f = fixture(answer), view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByText(f.original.original_message)
  expect(screen.getByText('<script>Guide · Project')).toBeTruthy()
  expect(view.container.textContent?.includes(answer)).toBe(true)
  expect(view.container.querySelector('script, img')).toBeNull()
  expect(screen.getByText(zh['task.done'])).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(f.read).toHaveBeenCalledWith({ source, limit: 50 })
  view.unmount(); f.model.dispose()
})
it('a v2 admission event refreshes only its original Session and unmount removes the listener and timer', async () => {
  const f = fixture(), view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByText('完整回复')
  const before = f.read.mock.calls.length
  window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: { ...source, session_id: 'other' } }))
  await act(async () => {})
  expect(f.read).toHaveBeenCalledTimes(before)
  window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: source }))
  await waitFor(() => { expect(f.read).toHaveBeenCalledTimes(before + 1) })
  view.unmount(); const last = f.read.mock.calls.length
  window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: source }))
  await act(async () => {})
  expect(f.read).toHaveBeenCalledTimes(last); f.model.dispose()
})
it('waiting and indeterminate outcomes remain distinct from successful execution', async () => {
  const f = fixture()
  f.read.mockResolvedValueOnce({ ok: true, value: { deliveries: [] } })
  const view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByText(zh['task.awaitingResult'])
  expect(screen.queryByText(zh['task.done'])).toBeNull()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [{ ...f.item, execution_state: 'indeterminate', answer: undefined } as never] } })
  await act(async () => { await f.model.refresh() })
  expect(screen.getByText(zh['task.indeterminate'])).toBeTruthy()
  expect(screen.queryByText(zh['task.done'])).toBeNull()
  view.unmount(); f.model.dispose()
})

it('restores the committed pending question automatically with no task form or accepted label', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  Reflect.set(f.bridge, 'collaborationPending', async () => ({ ok: true, value: { source,
    plan: { plan_id: 'plan', plan_revision: '3', state_version: '3', input_version: '1', planning_state: 'clarify', route_decision: 'collaboration' },
    frozen_task_count: 0, pending_items: [{ pending_item_id: 'pending', revision: '1', reason: 'task_ambiguous',
      question: '<script>请说明哪个登录问题？', mentions: [{ mention_id: 'guide', agent_name: 'Guide', project_name: 'Project' }] }] } }))
  const view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByText('<script>请说明哪个登录问题？')
  expect(screen.getByText('Guide · Project')).toBeTruthy()
  expect(screen.queryByText(zh['task.awaitingResult'])).toBeNull()
  expect(screen.queryByText(zh['task.done'])).toBeNull()
  expect(view.container.querySelector('script, input, textarea, form')).toBeNull()
  view.unmount(); f.model.dispose()
})

it.each([
  ['queued', '等待识别任务'],
  ['planning', '正在识别任务'],
  ['failed', '未能识别任务，原消息已保留'],
  ['cancelled', '已停止识别此消息'],
  ['unsupported', '此任务暂不支持自动分配，原消息已保留'],
  ['discuss', '此消息被识别为讨论，未分配协同任务'],
])('shows the current %s plan instead of a generic empty result', async (planning_state, message) => {
  const f = fixture()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  Reflect.set(f.bridge, 'collaborationPending', async () => ({ ok: true, value: { source,
    plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1',
      planning_state, route_decision: planning_state === 'discuss' ? 'local' : 'collaboration' },
    frozen_task_count: 0, pending_items: [] } }))
  const view = render(<CollaborationResultsDock {...f.props} />)
  try {
    await screen.findByText(message)
    expect(screen.queryByText(zh['task.awaitingResult'])).toBeNull()
    expect(screen.queryByText(zh['task.done'])).toBeNull()
    expect(view.container.querySelector('input, textarea, form')).toBeNull()
    expect(f.read).toHaveBeenCalledWith({ source, limit: 50 })
  } finally { view.unmount(); f.model.dispose() }
})

it('keeps completed replies visible and never labels a frozen plan as accepted execution', async () => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPending', async () => ({ ok: true, value: { source,
    plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1',
      planning_state: 'failed', route_decision: 'collaboration' }, frozen_task_count: 1, pending_items: [] } }))
  const view = render(<CollaborationResultsDock {...f.props} />)
  try {
    await screen.findByText('完整回复')
    expect(screen.getByText(zh['task.done'])).toBeTruthy()
    expect(screen.queryByText('未能识别任务，原消息已保留')).toBeNull()
    f.read.mockResolvedValue({ ok: true, value: { deliveries: [] } })
    Reflect.set(f.bridge, 'collaborationPending', async () => ({ ok: true, value: { source,
      plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1',
        planning_state: 'ready', route_decision: 'collaboration' }, frozen_task_count: 1, pending_items: [] } }))
    await act(async () => { await f.model.refresh() })
    expect(screen.getByText(zh['task.awaitingResult'])).toBeTruthy()
    expect(screen.queryByText(zh['task.done'])).toBeNull()
    expect(screen.queryByText(zh['submit.acceptedV2'])).toBeNull()
  } finally { view.unmount(); f.model.dispose() }
})

it('shows a failed status read without retaining a previous planning status', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  Reflect.set(f.bridge, 'collaborationPending', async () => ({ ok: false, errorCode: 'unavailable' }))
  const view = render(<CollaborationResultsDock {...f.props} />)
  try {
    await screen.findByText(zh['task.readUnavailable'])
    expect(screen.queryByText(zh['task.awaitingResult'])).toBeNull()
    expect(screen.queryByText(zh['task.done'])).toBeNull()
  } finally { view.unmount(); f.model.dispose() }
})

it('disables paging during a slow result read and appends only that original message', async () => {
  const f = fixture()
  f.read.mockResolvedValueOnce({ ok: true, value: { deliveries: [f.item], next_cursor: f.item.delivery_id } })
  let release: (() => void) | undefined, active: Promise<void> | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  f.props.loadReplies = (digest) => { active = f.model.loadReplies(digest); return active }
  onTestFinished(async () => { release?.(); await active })
  const view = render(<CollaborationResultsDock {...f.props} />)
  onTestFinished(() => { view.unmount() })
  await screen.findByText('完整回复')
  f.read.mockImplementationOnce(async () => {
    await held
    return { ok: true, value: { deliveries: [{ ...f.item, delivery_id: 'delivery2', answer: '第二个任务回复' }] } }
  })
  const before = f.read.mock.calls.length
  await act(async () => { screen.getByTestId('slark-collaboration-results-more').click() })
  expect(f.read).toHaveBeenCalledWith({ source, limit: 50, after_delivery_id: f.item.delivery_id })
  expect(screen.getByTestId<HTMLButtonElement>('slark-collaboration-results-more').disabled).toBe(true)
  await act(async () => { screen.getByTestId('slark-collaboration-results-more').click() })
  expect(f.read).toHaveBeenCalledTimes(before + 1)
  if (!release || !active) throw Error('result read did not start')
  await act(async () => { release?.(); await active })
  expect(screen.getByText('第二个任务回复')).toBeTruthy()
  expect(screen.getByText('完整回复')).toBeTruthy()
  expect(screen.queryByTestId('slark-collaboration-results-more')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it.each([false, true])('loads more history from its Source cursor without a new chat submission (workspace %s)', async (workspace) => {
  const f = fixture('完整回复', workspace), older = { ...f.original, snapshot_digest: 'b'.repeat(64),
    source: { ...source, source_message_id: 'older' }, original_message: '@Guide · Project 之前的任务' }
  f.readSources.mockImplementation(async cursor => ({ ok: true,
    value: cursor ? { items: [older] } : { items: [f.original], next_cursor: f.original.snapshot_digest } }))
  f.read.mockImplementation(async request => ({ ok: true, value: { deliveries: [{ ...f.item,
    source_locator: request.source, source_snapshot_digest: request.source.source_message_id === 'older' ? older.snapshot_digest : f.original.snapshot_digest,
    answer: request.source.source_message_id === 'older' ? '之前的回复' : '完整回复' }] } }))
  const view = render(<CollaborationResultsDock {...f.props} />)
  onTestFinished(() => { view.unmount() })
  await screen.findByText('完整回复')
  expect(screen.getByText(zh[workspace ? 'task.moreWorkspaceMessages' : 'task.moreMessages'])).toBeTruthy()
  await act(async () => { screen.getByTestId('slark-collaboration-messages-more').click() })
  expect(f.readSources).toHaveBeenLastCalledWith(f.original.snapshot_digest, expect.any(AbortSignal), SessionId('session'))
  expect(screen.getByText(older.original_message)).toBeTruthy()
  expect(screen.getByText('之前的回复')).toBeTruthy()
  expect(screen.getByText('完整回复')).toBeTruthy()
  expect(screen.queryByTestId('slark-collaboration-messages-more')).toBeNull()
})

it('renders restricted and failed results without restoring private names or a missing project label', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [
    { delivery_id: 'restricted', invocation_id: 'invocation', delivery_state: 'restricted', delivery_state_version: '1',
      source_locator: source, source_snapshot_digest: f.original.snapshot_digest },
    { ...f.item, delivery_id: 'failed', execution_state: 'failed', target_display_snapshot: { agent_name: 'Guide', project_name: null }, answer: '执行失败说明' },
  ] } })
  f.bridge.collaborationPending = async () => ({ ok: true, value: { source,
    plan: { plan_id: 'plan', plan_revision: '1', state_version: '1', input_version: '1', planning_state: 'clarify', route_decision: 'collaboration' },
    frozen_task_count: 0,
    pending_items: [{ pending_item_id: 'pending', revision: '1', reason: 'task_ambiguous', question: '请说明任务',
      mentions: [{ mention_id: 'guide', agent_name: 'Guide', project_name: null }] }] } })
  const view = render(<CollaborationResultsDock {...f.props} />)
  onTestFinished(() => { view.unmount() })
  await screen.findByText(zh['task.restricted'])
  expect(screen.getByText(zh['task.failed'])).toBeTruthy()
  expect(screen.getByText('执行失败说明')).toBeTruthy()
  expect(screen.getAllByText('Guide')).toHaveLength(2)
  expect(screen.queryByText('<script>Guide · Project')).toBeNull()
  expect(view.container.textContent).not.toContain(' · null')
})

it('shows Source and reply transport failures in the original collaboration region', async () => {
  const f = fixture(), view = render(<CollaborationResultsDock {...f.props} />)
  onTestFinished(() => { view.unmount() })
  await screen.findByText('完整回复')
  f.read.mockResolvedValue({ ok: false, errorCode: 'unavailable' })
  await act(async () => { await f.model.refresh() })
  expect(screen.getByText(f.original.original_message)).toBeTruthy()
  expect(screen.getByText(zh['task.readUnavailable'])).toBeTruthy()
  f.readSources.mockResolvedValue({ ok: false })
  await act(async () => { await f.model.refresh() })
  expect(screen.queryByText(f.original.original_message)).toBeNull()
  expect(screen.getByText(zh['task.readUnavailable'])).toBeTruthy()
})

it('previews concrete work, confirms only on click, and checks uncertainty without resubmitting', async () => {
  const f = fixture()
  f.read.mockResolvedValue({ ok: true, value: { deliveries: [] } })
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  const execute = vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async request =>
    request.action === 'preview' ? { ok: true, previewId: 'preview', rootTraceId: 'b'.repeat(32), executionEnabled: true,
      tasks: [{ taskId: 'task', question: '<script>具体任务', agentName: 'Guide', projectName: 'Project' }] }
      : request.action === 'confirm' ? { ok: false } : { ok: true, status: 'recorded' })
  f.bridge.collaborationRootExecution = execute
  const view = render(<CollaborationResultsDock {...f.props} />)
  await screen.findByTestId('slark-execution-preview')
  expect(execute).not.toHaveBeenCalled()
  await act(async () => { screen.getByTestId('slark-execution-preview').click() })
  expect(screen.getByText('<script>具体任务')).toBeTruthy()
  expect(view.container.querySelector('script')).toBeNull()
  expect(execute).toHaveBeenCalledWith({ action: 'preview', source })
  expect(screen.queryByText(zh['execution.recorded'])).toBeNull()
  await act(async () => { screen.getByTestId('slark-execution-confirm').click() })
  expect(execute).toHaveBeenLastCalledWith({ action:'confirm',previewId:'preview',taskId:'task' })
  expect(screen.getByText(zh['execution.uncertain'])).toBeTruthy()
  expect(screen.getByTestId('slark-execution-confirm').hasAttribute('disabled')).toBe(true)
  await act(async () => { screen.getByTestId('slark-execution-reconcile').click() })
  expect(execute).toHaveBeenLastCalledWith({ action:'reconcile',previewId:'preview',taskId:'task' })
  expect(screen.getByText(zh['execution.recorded'])).toBeTruthy()
  expect(screen.queryByText(zh['task.done'])).toBeNull()
  await act(async () => { await f.model.refresh() })
  expect(execute).toHaveBeenCalledTimes(3)
  view.unmount()
})

it('consumes a displayed original result only once and keeps consumption distinct from continuation', async () => {
  const f=fixture()
  Reflect.set(f.item,'task_id','task')
  Reflect.set(f.bridge,'collaborationPlanningAvailable',true)
  const command=vi.fn<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>(async request =>
    request.action === 'preview' ? { ok:true,previewId:'p',rootTraceId:'b'.repeat(32),executionEnabled:true,tasks:[{ taskId:'task',question:'Work',agentName:'Guide',projectName:'Project' }] }
      : { ok:true,rootTraceId:'b'.repeat(32),consumptionAcknowledged:true,status:'context_applied',continuationObserved:request.action==='consumption-status' })
  f.bridge.collaborationRootExecution=command
  render(<CollaborationResultsDock {...f.props} />)
  await screen.findByTestId('slark-execution-preview')
  await act(async()=>{screen.getByTestId('slark-execution-preview').click()})
  await act(async()=>{screen.getByTestId('slark-consumption-start').click()})
  expect(command.mock.calls.at(-1)?.[0]).toEqual({ action:'consume',previewId:'p',taskId:'task',deliveryId:'delivery' })
  expect(screen.getByText(zh['consumption.context_applied'])).toBeTruthy()
  const count=command.mock.calls.length
  await act(async()=>{screen.getByTestId('slark-consumption-start').click();await f.model.refresh()})
  expect(command).toHaveBeenCalledTimes(count)
  await act(async()=>{screen.getByTestId('slark-consumption-status').click()})
  expect(command.mock.calls.at(-1)?.[0]).toMatchObject({ action:'consumption-status' })
  expect(screen.getByText(zh['consumption.continued'])).toBeTruthy()
})

it.each(['unavailable', 'disabled'] as const)('shows %s execution without enabling a confirmation', async (mode) => {
  const f = fixture()
  Reflect.set(f.bridge, 'collaborationPlanningAvailable', true)
  f.bridge.collaborationRootExecution = async () => mode === 'unavailable' ? { ok: false }
    : { ok: true, previewId: 'preview', rootTraceId: 'b'.repeat(32), executionEnabled: false,
      tasks: [{ taskId: 'task', question: 'Work', agentName: 'Guide', projectName: 'Project' }] }
  render(<CollaborationResultsDock {...f.props} />)
  await screen.findByTestId('slark-execution-preview')
  await act(async () => { screen.getByTestId('slark-execution-preview').click() })
  expect(screen.getByText(zh[mode === 'disabled' ? 'execution.disabled' : 'task.readUnavailable'])).toBeTruthy()
  if (mode === 'disabled') expect(screen.getByTestId('slark-execution-confirm').hasAttribute('disabled')).toBe(true)
  else expect(screen.queryByTestId('slark-execution-confirm')).toBeNull()
})
