// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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

it('labels legacy positions separately and excludes another Session without treating it as current chat', () => {
  const legacy = { ...group(), original: { ...group().original, timeline_position: null } }
  const foreign = { ...group('b'), original: { ...group('b').original, source: { ...source, session_id: 'foreign' } } }
  const f = fixture([legacy, foreign])
  expect(screen.getByRole('region', { name: zh['task.unpositionedHistory'] })).toBeTruthy()
  expect(f.view.container.textContent?.includes('@Guide · Project b')).toBe(false)
  expect(screen.getAllByTestId('slark-timeline-original')).toHaveLength(1)
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
  for (const execution_state of ['indeterminate', 'failed']) {
    await act(async () => { f.state.set({ phase: 'ready', groups: [{ ...original, replies: [{
      ...original.replies[0]!, execution_state, target_display_snapshot: { agent_name: 'Guide', project_name: null },
    }] }] }) })
    expect(screen.getByText(zh[execution_state === 'indeterminate' ? 'task.indeterminate' : 'task.failed'])).toBeTruthy()
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
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreMessages'] }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['task.moreResults'] }).disabled).toBe(true)
  await act(async () => { f.state.set({ ...f.state.getSnapshot(), phase: 'ready', groups: [] }) })
  expect(screen.queryByTestId('slark-timeline-original')).toBeNull()
  expect(scroll).toHaveBeenCalledOnce()
})
