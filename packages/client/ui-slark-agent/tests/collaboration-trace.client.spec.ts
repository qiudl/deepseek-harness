import { expect, it } from 'vitest'
import { readCollaborationTracePage, readCollaborationExecutionEvidence } from '../src/client/collaboration-trace.ts'

function response() {
  const root = { root_task_id: 'root', root_trace_id: 'b'.repeat(32), task_revision: '2', state_version: '3', state: 'active', intent_state: 'active' }
  const event = { event_id: 'event', root_seq: 1, task_revision: 1, type: 'execution_observed', phase: 'execution_succeeded',
    occurred_at: '2026-10-07T00:00:00.000Z', recorded_at: '2026-10-07T00:00:00.000Z',
    trace_context: { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, task_revision: 1 } }
  return { ok: true, value: { root, events: [event], next_after_seq: null, coverage: 'partial' } }
}
it('keeps durable root and step evidence without requiring optional causation fields', () => {
  const r = response()
  expect(readCollaborationTracePage(r, 0).events[0]?.trace_context).toEqual(r.value.events[0]?.trace_context)
  Object.assign(r.value.events[0]!.trace_context, { causation_id: 'original-event' })
  expect(readCollaborationTracePage(r, 0).events[0]?.trace_context.causation_id).toBe('original-event')
  r.value.root.intent_state = 'revoked'
  expect(readCollaborationTracePage(r, 0).root.intent_state).toBe('revoked')
})
it('rejects malformed envelopes, private payload overflow, swapped roots and regressing versions', () => {
  for (const value of [null, [], false, { ok: false }, { ...response(), ok: false }, { body: 'x'.repeat(800 * 1024) }]) {
    expect(() => readCollaborationTracePage(value, 0)).toThrow()
  }
  const mutate: ((r: ReturnType<typeof response>) => void)[] = [
    (r) => { r.value.coverage = 'full' },
    (r) => { r.value.root.root_trace_id = '0'.repeat(32) },
    (r) => { r.value.root.root_task_id = '' },
    (r) => { r.value.root.state_version = '0' },
    (r) => { r.value.root.state_version = '9223372036854775808' },
    (r) => { r.value.root.intent_state = 'unknown' },
    (r) => { r.value.root.state = 'unknown' },
    (r) => { r.value.events[0]!.root_seq = 0 },
    (r) => { r.value.events[0]!.task_revision = 3 },
    (r) => { r.value.events[0]!.trace_context.root_task_id = 'other' },
    (r) => { r.value.events[0]!.trace_context.root_trace_id = 'c'.repeat(32) },
    (r) => { r.value.events[0]!.trace_context.task_revision = 2 },
    (r) => { r.value.events[0]!.occurred_at = 'invalid' },
    (r) => { r.value.events[0]!.recorded_at = '2026-10-07' },
    (r) => { r.value.events.push(r.value.events[0]!) },
    (r) => { r.value.events = Array.from({ length: 21 }, () => r.value.events[0]!) },
    (r) => { Object.assign(r.value, { next_after_seq: 1 }) },
    (r) => { Object.assign(r.value, { next_after_seq: -1 }) },
  ]
  for (const change of mutate) { const r = response(); change(r); expect(() => readCollaborationTracePage(r, 0)).toThrow() }
  const prior = readCollaborationTracePage(response(), 0)
  for (const patch of [{ root_task_id: 'other' }, { root_trace_id: 'c'.repeat(32) }, { task_revision: '1' }, { state_version: '2' }]) {
    const r = response(); Object.assign(r.value.root, patch)
    expect(() => readCollaborationTracePage(r, 0, prior)).toThrow()
  }
})

function evidence() {
  return { ...response(), value: { ...response().value, execution: {
    event_id: 'event', attempt_id: 'attempt', state: 'succeeded', digest: 'a'.repeat(64),
    events: [{ sequence: 1, observedAt: 1791331200000, type: 'tool.completed', runtimeId: 'tool', success: true }],
    next_after_sequence: null, provider_visibility: 'boundary_only',
  } } }
}
it('reads immutable runtime observations separately from cloud audit sequences', () => {
  const r = evidence(), first = readCollaborationExecutionEvidence(r, 'event', 0)
  expect(first.events).toEqual(r.value.execution.events)
  expect(readCollaborationExecutionEvidence(r, 'event', 0, first)).toEqual(first)
  const empty = { ...r, value: { ...r.value, execution: { ...r.value.execution, digest: null, events: [] } } }
  expect(readCollaborationExecutionEvidence(empty, 'event', 0).events).toEqual([])
  const full = { ...r, value: { ...r.value, execution: { ...r.value.execution,
    events: Array.from({ length: 20 }, (_, n) => ({ sequence: n + 1, observedAt: 0, type: 'session.started' })), next_after_sequence: 20 } } }
  expect(readCollaborationExecutionEvidence(full, 'event', 0).next_after_sequence).toBe(20)
  const next = { ...r, value: { ...r.value, execution: { ...r.value.execution,
    events: [{ sequence: 21, observedAt: 0, type: 'error', success: false }] } } }
  expect(readCollaborationExecutionEvidence(next, 'event', 20, first).events[0]?.success).toBe(false)
})
it('rejects evidence substitution, invalid observations and inconsistent pagination', () => {
  const patches = [
    { event_id: 'other' }, { provider_visibility: 'full' }, { digest: '' }, { attempt_id: '' }, { state: 'running' },
    { events: null }, { events: Array(21).fill({}) }, { next_after_sequence: 1 }, { next_after_sequence: 2 },
    { digest: null }, { digest: null, events: [], next_after_sequence: 1 },
  ]
  const r = evidence()
  for (const patch of patches) expect(() => readCollaborationExecutionEvidence({ ...r, value: { ...r.value,
    execution: { ...r.value.execution, ...patch } } }, 'event', 0)).toThrow()
  for (const patch of [{ sequence: 2 }, { observedAt: -1 }, { observedAt: 'now' }, { observedAt: 1.1 }, { observedAt: 8640000000000001 },
    { type: 'private' }, { success: 'true' }, { runtimeId: '' }]) {
    expect(() => readCollaborationExecutionEvidence({ ...r, value: { ...r.value, execution: { ...r.value.execution,
      events: [{ ...r.value.execution.events[0], ...patch }] } } }, 'event', 0)).toThrow()
  }
  const prior = readCollaborationExecutionEvidence(r, 'event', 0)
  for (const patch of [{ attempt_id: 'other' }, { digest: 'b'.repeat(64) }, { state: 'failed' }]) {
    expect(() => readCollaborationExecutionEvidence({ ...r, value: { ...r.value,
      execution: { ...r.value.execution, ...patch } } }, 'event', 0, prior)).toThrow()
  }
})
