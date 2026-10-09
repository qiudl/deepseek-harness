// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollaborationTrajectory } from '../src/client/CollaborationTrajectory.tsx'
import type { CollaborationResultsSnapshot } from '../src/client/collaboration-results.ts'
import { dockRuntime, dockTranslate } from './fixture-state.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '2', state_version: '3', state: 'active', intent_state: 'active' as const }
function snapshot(): CollaborationResultsSnapshot {
  return { phase: 'ready', executionAvailable: true, groups: [{
    original: { source: { workspace_id: 'workspace', session_id: 'session', source_message_id: 'original', source_revision: '1' },
      snapshot_digest: 'a'.repeat(64), original_message: '请分析并校验' }, phase: 'ready', replies: [],
    trace: { phase: 'ready', page: { root, coverage: 'partial', next_after_seq: 1,
      events: [{ event_id: 'event', root_seq: 1, task_revision: 1, type: 'execution_observed', phase: 'execution_succeeded',
        occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
        trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1,
          step_id: 'step', attempt_id: 'attempt', causation_id: 'cause' } }] } },
  }] }
}
function props(state: CollaborationResultsSnapshot): Parameters<typeof CollaborationTrajectory>[0] {
  return { ...dockRuntime(), useSlarkResults: select => select(state), t: dockTranslate,
    traceAction: vi.fn(async () => {}), traceEvidenceAction: vi.fn(async () => {}), loadSources: vi.fn(async () => {}),
    executionAction: vi.fn(async () => {}), loadReplies: vi.fn(async () => {}) }
}
it('shows root progress separately from remote success and exposes only readonly commands', () => {
  const p = props(snapshot())
  const view = render(<CollaborationTrajectory {...p} />)
  expect(screen.getByText(root.root_trace_id)).toBeTruthy()
  expect(view.container.textContent).toContain(zh['trace.active'])
  expect(view.container.textContent).toContain(zh['trace.succeeded'])
  expect(view.container.textContent).toContain(zh['trace.partial'])
  expect(view.container.textContent).not.toContain(zh['trace.rootSucceeded'])
  expect(view.container.textContent).toContain('attempt')
  fireEvent.click(screen.getByText(zh['trace.more']))
  expect(p.traceAction).toHaveBeenLastCalledWith('a'.repeat(64), true)
  fireEvent.click(screen.getByText(zh['trace.refresh']))
  expect(p.traceAction).toHaveBeenLastCalledWith('a'.repeat(64))
  expect(p.executionAction).not.toHaveBeenCalled()
})
it('shows unavailable history without retaining cloud identifiers and supports unloaded originals', () => {
  const s = snapshot(), p = props({ ...s, groups: [{ ...s.groups[0]!, trace: { phase: 'error' } }], nextCursor: 'older' })
  const view = render(<CollaborationTrajectory {...p} />)
  expect(screen.getByRole('status').textContent).toBe(zh['trace.unavailable'])
  expect(view.container.textContent).not.toContain(root.root_trace_id)
  fireEvent.click(screen.getByText(zh['task.moreMessages']))
  expect(p.loadSources).toHaveBeenCalledTimes(1)
  const { trace: _trace, ...unloaded } = s.groups[0]!
  view.rerender(<CollaborationTrajectory {...props({ ...s, groups: [unloaded] })} />)
  expect(screen.getByText(zh['trace.load'])).toBeTruthy()
})
it('omits unavailable features and empty Sources, and blocks duplicate reads while that trace loads', () => {
  const s = snapshot()
  const view = render(<CollaborationTrajectory {...props({ ...s, executionAvailable: false })} />)
  expect(view.container.childElementCount).toBe(0)
  view.rerender(<CollaborationTrajectory {...props({ ...s, groups: [] })} />)
  expect(view.container.childElementCount).toBe(0)
  view.rerender(<CollaborationTrajectory {...props({ ...s, groups: s.groups.map(g => ({ ...g, trace: { ...g.trace, phase: 'loading' } })) })} />)
  expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
})

it('keeps revoked intent visible and labels unsupported phases without claiming completion', () => {
  const s = snapshot(), g = s.groups[0]!, page = g.trace!.page!
  const p = props({ ...s, groups: [{ ...g, trace: { phase: 'ready', page: { ...page,
    root: { ...page.root, state: 'future-state', intent_state: 'revoked' },
    events: page.events.map(e => ({ ...e, phase: 'future-phase' })),
  } } }] })
  render(<CollaborationTrajectory {...p} />)
  expect(screen.getByText(zh['trace.intentRevoked'])).toBeTruthy()
  expect(screen.getAllByText(new RegExp(zh['trace.unknown']))).toHaveLength(2)
})

it('expands persisted execution details and pages observations without executing work', () => {
  const s = snapshot(), g = s.groups[0]!, trace = g.trace!
  const execution = { eventId: 'event', phase: 'ready' as const, page: { event_id: 'event', attempt_id: 'attempt',
    state: 'succeeded', digest: 'a'.repeat(64), provider_visibility: 'boundary_only' as const, next_after_sequence: 20,
    events: [{ sequence: 1, observedAt: 1791331200000, type: 'tool.completed', runtimeId: 'tool', success: true },
      { sequence: 2, observedAt: 1791331200000, type: 'error', success: false },
      { sequence: 3, observedAt: 1791331200000, type: 'future' }] } }
  const p = props({ ...s, groups: [{ ...g, trace: { ...trace, execution } }] })
  const view = render(<CollaborationTrajectory {...p} />)
  expect(screen.getByText(zh['trace.providerBoundary'])).toBeTruthy()
  expect(view.container.textContent).toContain(zh['trace.toolCompleted'])
  expect(view.container.textContent).toContain(zh['trace.observationSucceeded'])
  expect(view.container.textContent).toContain(zh['trace.observationFailed'])
  fireEvent.click(screen.getByText(zh['trace.executionDetails']))
  expect(p.traceEvidenceAction).toHaveBeenLastCalledWith('a'.repeat(64), 'event')
  fireEvent.click(screen.getByText(zh['trace.moreExecution']))
  expect(p.traceEvidenceAction).toHaveBeenLastCalledWith('a'.repeat(64), 'event', true)
  expect(p.executionAction).not.toHaveBeenCalled()
  view.rerender(<CollaborationTrajectory {...props({ ...s, groups: [{ ...g, trace: { ...trace,
    execution: { ...execution, page: { ...execution.page, events: [], next_after_sequence: null } } } }] })} />)
  expect(screen.getByText(zh['trace.noEvidence'])).toBeTruthy()
})

it('shows committed original reply while keeping root progress partial and active', () => {
  const state = snapshot()
  const group = state.groups[0]!
  const page = group.trace!.page!
  const next = { ...state, groups: [{ ...group, trace: { ...group.trace!, page: { ...page,
    events: page.events.map(event => ({ ...event, phase: 'assistant_message_committed' })) } } }] }
  const view = render(<CollaborationTrajectory {...props(next)} />)
  expect(view.container.textContent).toContain(zh['trace.assistantCommitted'])
  expect(screen.getByText(zh['trace.partial'])).toBeTruthy()
  expect(screen.queryByText(zh['trace.rootSucceeded'])).toBeNull()
})

it('keeps manual trajectory reads available during background result refresh', () => {
  const state = snapshot()
  const p = props({ ...state, phase: 'loading' })
  render(<CollaborationTrajectory {...p} />)
  for (const id of ['slark-trace-load', 'slark-trace-more', 'slark-trace-execution']) {
    const button = screen.getByTestId(id)
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
  }
  expect(p.traceAction).toHaveBeenCalledTimes(2)
  expect(p.traceEvidenceAction).toHaveBeenCalledTimes(1)
})
