// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CollaborationTimeline } from '../src/client/CollaborationTimeline.tsx'
import type { CollaborationResultGroup, CollaborationResultsSnapshot } from '../src/client/collaboration-results.ts'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const source = { workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session',
  source_message_id: 'message', source_revision: '1' }
const group = (id = 'a'): CollaborationResultGroup => ({ phase: 'ready',
  original: { source: { ...source, source_message_id: id }, snapshot_digest: id.repeat(64), original_message: `@Guide · Project ${id}`,
    timeline_position: { after_sequence: 0, local_order: id === 'a' ? '1' : '2' } }, replies: [{
    delivery_id: `reply-${id}`, invocation_id: id, delivery_state: 'pending', delivery_state_version: '1',
    source_locator: { ...source, source_message_id: id }, source_snapshot_digest: id.repeat(64), execution_state: 'succeeded',
    target_display_snapshot: { agent_name: `Guide ${id}`, project_name: 'Project' }, answer: `answer-${id}`,
  }],
})
function fixture(groups: CollaborationResultGroup[] = [group()]) {
  const state = createSnapshotStore<CollaborationResultsSnapshot>({ phase: 'ready', groups })
  const props: Parameters<typeof CollaborationTimeline>[0] = {
    ...dockRuntime(), t: dockTranslate,
    useSlarkResults: <T,>(selector: (value: CollaborationResultsSnapshot) => T) =>
      selector(useSyncExternalStore(listener => state.subscribe(listener), () => state.getSnapshot())),
    recordId: null,
    loadSources: vi.fn(async () => {}), loadReplies: vi.fn(async () => {}), executionAction: vi.fn(async () => {}),
  }
  function Records() {
    const snapshot = useSyncExternalStore(listener => state.subscribe(listener), () => state.getSnapshot())
    return <>
      <CollaborationTimeline {...props} />
      {snapshot.groups.filter(group => group.original.timeline_position != null).map(group =>
        <CollaborationTimeline key={group.original.snapshot_digest} {...props} recordId={group.original.snapshot_digest} />)}
    </>
  }
  const view = render(<Records />)
  onTestFinished(() => { view.unmount() })
  return { state, props, view }
}

it('renders complete originals and target-qualified replies by stable record identity without another input', async () => {
  const a = group(), b = group('b'), f = fixture([{ ...a, replies: [] }, b])
  const original = screen.getAllByTestId('slark-timeline-original')[0]
  expect(f.view.container.textContent).toMatch(/@Guide · Project a.*@Guide · Project b.*answer-b/s)
  await act(async () => { f.state.set({ phase: 'ready', groups: [a, b] }) })
  expect(screen.getAllByTestId('slark-timeline-original')[0]).toBe(original)
  expect(f.view.container.textContent).toMatch(/answer-a.*@Guide · Project b.*answer-b/s)
  expect(f.view.container.querySelector('[data-row-id="slark-reply:reply-a"]')).toBeTruthy()
  expect(screen.getByText('Guide a · Project')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('shows the first Agent body in the original chat and replaces it with the final delivery', async () => {
  const a = group(), body = { source: a.original.source, sourceDigest: a.original.snapshot_digest, invocationId: 'a', taskId: 'task',
    seq: '1', fence: '1', text: '首段正文🙂', textDigest: 'e'.repeat(64), agentName: 'Guide', projectName: 'Project' }
  const f = fixture([{ ...a, replies: [], provisionalResponses: [body] }])
  expect(screen.getByTestId('slark-timeline-response').textContent).toContain(body.text)
  expect(screen.queryByRole('textbox')).toBeNull()
  await act(async () => { f.state.set({ phase: 'ready', groups: [{ ...a, replies: [], provisionalResponses: [{ ...body, seq: '2', text: '完整正文🙂' }] }] }) })
  expect(screen.queryByText(body.text)).toBeNull(); expect(screen.getByText('完整正文🙂')).toBeTruthy()
  await act(async () => { f.state.set({ phase: 'ready', groups: [a] }) })
  expect(screen.queryByTestId('slark-timeline-response')).toBeNull(); expect(screen.getByText('answer-a')).toBeTruthy()
})

it('labels legacy positions separately and excludes another Session without treating it as current chat', () => {
  const legacy = { ...group(), original: { ...group().original, timeline_position: null } }
  const foreign = { ...group('b'), original: { ...group('b').original, source: { ...source, session_id: 'foreign' } } }
  const f = fixture([legacy, foreign])
  expect(screen.getByRole('region', { name: zh['task.unpositionedHistory'] })).toBeTruthy()
  expect(f.view.container.textContent?.includes('@Guide · Project b')).toBe(false)
  expect(screen.getAllByTestId('slark-timeline-original')).toHaveLength(1)
})

it('shows an original group Source and its Agent result in the same Session without a Chat position', () => {
  const original = group(), messageId = '33333333-3333-4333-8333-333333333333'
  const groupSource = { ...original, original: { ...original.original,
    source: { ...original.original.source, source_message_id: messageId },
    timeline_position: null }, replies: original.replies.map(reply => ({ ...reply,
    source_locator: { ...reply.source_locator, source_message_id: messageId } })) }
  fixture([groupSource])
  const history = screen.getByRole('region', { name: zh['task.unpositionedHistory'] })
  expect(within(history).getByTestId('slark-timeline-original').textContent).toContain('@Guide · Project a')
  expect(within(history).getByTestId('slark-timeline-reply').textContent).toContain('answer-a')
})

it('keeps plain text complete and safe, renders pending questions and exposes distinct read/restricted states', async () => {
  const original = group(), answer = '<img src=x onerror=alert(1)>\n' + 'x'.repeat(128 * 1024 - 30)
  const f = fixture([{ ...original, replies: [{ ...original.replies[0]!, answer }], pending: [{
    pending_item_id: 'pending-1', revision: '1', reason: 'ambiguous', question: 'which part?',
    mentions: [{ mention_id: 'mention', agent_name: 'Guide', project_name: 'Project' },
      { mention_id: 'second', agent_name: 'Other', project_name: null }],
  }] }])
  expect(f.view.container.textContent?.includes(answer)).toBe(true)
  expect(f.view.container.querySelector('script, img')).toBeNull()
  expect(screen.getByText('which part?')).toBeTruthy()
  await act(async () => { f.state.set({ phase: 'error', groups: [], location: { snapshotDigest: 'a'.repeat(64), status: 'unavailable' } }) })
  expect(screen.getByText(zh['task.readUnavailable'])).toBeTruthy()
  expect(screen.getByText(zh['task.sourceUnavailable'])).toBeTruthy()
  for (const execution_state of ['indeterminate', 'failed', 'accepted', 'running']) {
    await act(async () => { f.state.set({ phase: 'ready', groups: [{ ...original, replies: [{
      ...original.replies[0]!, execution_state, target_display_snapshot: { agent_name: 'Guide', project_name: null },
    }] }] }) })
    expect(within(screen.getByTestId('slark-timeline-reply')).getByText(zh[execution_state === 'indeterminate'
      ? 'task.indeterminate' : execution_state === 'failed' ? 'task.failed' : 'task.background'])).toBeTruthy()
  }
  const { target_display_snapshot: _display, answer: _answer, ...restricted } = original.replies[0]!
  await act(async () => { f.state.set({ phase: 'ready', groups: [{ ...original, replies: [{
    ...restricted, delivery_state: 'restricted',
  }] }] }) })
  expect(screen.getByText(zh['task.restricted'])).toBeTruthy()
  for (const state of [{ ...original, phase: 'error' as const }, { ...original, pendingUnavailable: true },
    { ...original, replies: [], planningState: 'failed' }]) {
    await act(async () => { f.state.set({ phase: 'ready', groups: [state] }) })
    expect(screen.getByText(zh[state.planningState === 'failed' ? 'task.planningFailed' : 'task.readUnavailable'])).toBeTruthy()
  }
})

it('paginates Sources and replies independently and focuses a locator once without polling focus', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'), scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })
  const original = { ...group(), nextCursor: 'reply-a' }, f = fixture([original])
  await act(async () => { f.state.set({ phase: 'ready', groups: [original], nextCursor: 'a'.repeat(64),
    focus: { snapshotDigest: 'a'.repeat(64), sequence: 1 } }) })
  await waitFor(() => { expect(document.activeElement).toBe(screen.getByTestId('slark-timeline-original')) })
  expect(scroll).toHaveBeenCalledOnce()
  await act(async () => { screen.getByTestId('slark-timeline-more').click(); screen.getByTestId('slark-timeline-more-replies').click() })
  expect(f.props.loadSources).toHaveBeenCalledOnce()
  expect(f.props.loadReplies).toHaveBeenCalledWith('a'.repeat(64))
  await act(async () => { f.state.set({ ...f.state.getSnapshot(), phase: 'loading' }) })
  expect(scroll).toHaveBeenCalledOnce()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreMessages'] }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreResults'] }).disabled).toBe(false)
  await act(async () => { f.state.set({ ...f.state.getSnapshot(), historyReadPending: true }) })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreMessages'] }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreResults'] }).disabled).toBe(true)
  await act(async () => { f.state.set({ phase: 'ready', groups: [] }) })
  expect(screen.queryByTestId('slark-timeline-original')).toBeNull()
  expect(scroll).toHaveBeenCalledOnce()
})


it('separates assignment, clarification and completed result without adding another composer', () => {
  const a = group()
  fixture([{ ...a, pending: [{ pending_item_id: 'pending', revision: '1', reason: 'question',
    question: 'Which layout should I use?', mentions: [{ mention_id: 'mention', agent_name: 'Designer', project_name: 'Project' }] }] }])
  expect(screen.getByTestId('slark-timeline-assignment').textContent).toContain('Guide a')
  expect(screen.getByTestId('slark-timeline-assignment').textContent).toContain('Designer')
  const pending = screen.getByTestId('slark-timeline-pending')
  expect(pending.textContent).toContain('Which layout should I use?')
  expect(pending.textContent).toContain(zh['task.replyInChat'])
  expect(screen.getByTestId('slark-timeline-reply').textContent).toContain('answer-a')
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('shows accepted work as waiting and unsubmitted plans separately from completed deliveries', () => {
  fixture([{ ...group(), replies: [], execution: { phase: 'ready', enabled: true,
    tasks: [{ taskId: 'waiting', agentName: 'Writer', projectName: 'Project', question: 'Draft copy' },
      { taskId: 'planned', agentName: 'Reviewer', projectName: 'Project', question: 'Review copy' }],
    outcomes: { waiting: 'recorded' } } }])
  const assignment = screen.getByTestId('slark-timeline-assignment')
  expect(within(assignment).getByText(zh['task.waiting'])).toBeTruthy()
  expect(within(assignment).getByText(zh['task.planned'])).toBeTruthy()
  expect(within(assignment).queryByText(zh['task.done'])).toBeNull()
})

it('keeps distinct tasks visible when their Agent display names match', () => {
  fixture([{ ...group(), replies: [], execution: { phase: 'ready', enabled: true,
    tasks: [{ taskId: 'first', agentName: 'Guide', projectName: 'Project', question: 'First task' },
      { taskId: 'second', agentName: 'Guide', projectName: 'Project', question: 'Second task' }] },
  provisionalResponses: [{ source, sourceDigest: 'a'.repeat(64), invocationId: 'invocation', taskId: 'first',
    seq: '1', fence: 'fence', text: 'Working', textDigest: 'b'.repeat(64), agentName: 'Guide', projectName: 'Project' }] }])
  const assignment = screen.getByTestId('slark-timeline-assignment')
  expect(within(assignment).getAllByText('Guide')).toHaveLength(2)
  expect(within(assignment).getByText('Second task')).toBeTruthy()
})

it('replaces provisional assignments by delivery identity and keeps uncertain tasks distinct', () => {
  const a = group(), body = { source, sourceDigest: a.original.snapshot_digest, invocationId: 'a', taskId: 'done',
    seq: '1', fence: 'fence', text: 'Working', textDigest: 'b'.repeat(64), agentName: 'Earlier reply', projectName: 'Project' }
  fixture([{ ...a, replies: [{ ...a.replies[0]!, task_id: 'done' }],
    provisionalResponses: [body, { ...body, invocationId: 'live', taskId: 'live', agentName: 'Live reply' }],
    execution: { phase: 'ready', tasks: [
      { taskId: 'done', agentName: 'Earlier completed task', projectName: 'Project', question: 'Done' },
      { taskId: 'live', agentName: 'Earlier live task', projectName: 'Project', question: 'Live' },
      { taskId: 'uncertain', agentName: 'Uncertain task', projectName: 'Project', question: 'Check original receipt' },
    ], outcomes: { uncertain: 'uncertain' } } }])
  const assignment = within(screen.getByTestId('slark-timeline-assignment'))
  expect(assignment.getByText('Guide a')).toBeTruthy()
  expect(assignment.getByText('Live reply')).toBeTruthy()
  expect(assignment.getByText('Uncertain task')).toBeTruthy()
  expect(assignment.queryByText('Earlier reply')).toBeNull()
  expect(assignment.queryByText('Earlier completed task')).toBeNull()
  expect(assignment.queryByText('Earlier live task')).toBeNull()
  expect(assignment.getByText(zh['execution.uncertain'])).toBeTruthy()
})

it('shows a retained local planning failure without declaring the task terminal or adding retry controls', async () => {
  const a = { ...group(), replies: [], planningState: 'planning', planningFailure: {
    reason: 'timeout' as const, observedAt: '2026-10-19T00:00:00.000Z' } }
  const f = fixture([a])
  expect(screen.getByText(/本机识别任务曾失败/).textContent).toContain(zh['task.planningFailure.timeout'])
  expect(screen.getByText(a.original.original_message)).toBeTruthy()
  expect(screen.queryByText(zh['task.planning'])).toBeNull()
  expect(screen.queryByText(zh['task.planningFailed'])).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /重试|retry/i })).toBeNull()
  await act(async () => { f.state.set({ phase: 'ready', groups: [{ ...a, replies: group().replies }] }) })
  expect(screen.queryByText(/本机识别任务曾失败/)).toBeNull()
  expect(screen.getByText('answer-a')).toBeTruthy()
})
