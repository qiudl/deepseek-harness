// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { workspaceSnapshot, dockRuntime, dockTranslate } from './fixture-state.client.ts'
import { CollaborationResultsModel } from '../src/client/collaboration-results.ts'
import { CollaborationResultsDock } from '../src/client/CollaborationResultsDock.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const source = { workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session', source_message_id: 'message', source_revision: '1' }
function fixture(answer = '完整回复') {
  const original = { source, snapshot_digest: 'a'.repeat(64), original_message: '@Guide · Project 检查页面' }
  const item = { delivery_id: 'delivery', invocation_id: 'invocation', delivery_state: 'pending', delivery_state_version: '1', source_locator: source,
    source_snapshot_digest: original.snapshot_digest, execution_state: 'succeeded', invocation_state_version: '2',
    target_display_snapshot: { agent_name: '<script>Guide', project_name: 'Project' }, answer }
  const read = vi.fn(async () => ({ ok: true as const, value: { deliveries: [item] } }))
  const bridge = { collaborationScopeAvailable: true, collaborationDeliveries: read }
  const model = new CollaborationResultsModel('session' as never, { getSnapshot: () => workspaceSnapshot(source.workspace_id), subscribe: () => () => {} },
    { getSnapshot: () => 1, subscribe: () => () => {} }, async () => ({ ok: true, value: { items: [original] } }),
    () => bridge)
  const props: Parameters<typeof CollaborationResultsDock>[0] = { ...dockRuntime(),
    useSlarkResults: <T,>(selector: (s: ReturnType<typeof model.getSnapshot>) => T) =>
      selector(useSyncExternalStore(model.subscribe, model.getSnapshot)), loadSources: () => model.loadSources(),
    loadReplies: (id: string) => model.loadReplies(id), t: dockTranslate }
  return { model, read, props, original, item, bridge }
}
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
