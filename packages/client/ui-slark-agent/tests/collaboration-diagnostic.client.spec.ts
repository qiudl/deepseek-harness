import { expect, it, onTestFinished, vi } from 'vitest'
import { CollaborationDiagnosticProjection, readCollaborationPlanningFailure } from '../src/client/collaboration-diagnostic.ts'

const original = { source: { workspace_id: 'workspace', session_id: 'session', source_message_id: 'message', source_revision: '1' },
  snapshot_digest: 'a'.repeat(64), original_message: '@Guide do work' }
const evidence = () => ({ root: { root_trace_id: 'b'.repeat(32), source_descriptor: {
  ...original.source, snapshot_digest: original.snapshot_digest } }, failures: [{
  reason: 'timeout', observed_at: '2026-10-19T00:00:00.000Z', source_digest: original.snapshot_digest, trace_id: 'b'.repeat(32),
}] })
const response = () => ({ ok: true, value: evidence() })
// A check-phase barrier drains all continuations of already resolved IPC promises without waiting on wall time.
const drain = () => new Promise<void>(resolve => setImmediate(resolve))
it('reads finite original observations, selects the newest and never exposes raw metadata', () => {
  const value = response()
  value.value.failures.push({ ...value.value.failures[0]!, reason: 'model_failure', observed_at: '2026-10-19T00:00:01.000Z' })
  value.value.failures.push({ ...value.value.failures[0]!, observed_at: '2026-10-18T00:00:01.000Z' })
  expect(readCollaborationPlanningFailure(value, original)).toEqual({ reason: 'model_failure', observedAt: '2026-10-19T00:00:01.000Z' })
  expect(readCollaborationPlanningFailure({ ok: true, value: { ...evidence(), failures: [] } }, original)).toBeUndefined()
  expect(readCollaborationPlanningFailure({ ok: false, errorCode: 'dsh_host_upgrade_required' }, original)).toBe('unsupported')
})
it.each(['null', 'array', 'not_ok', 'unavailable', 'source', 'digest', 'root_trace', 'failure_trace', 'failure_digest',
  'reason', 'time_type', 'time_format', 'time_range', 'time_date', 'failures_type', 'failures_bound'] as const)(
  'rejects %s instead of publishing a task state', (mode) => {
    const data = response(), value: Record<string, unknown> = data
    if (mode === 'source') data.value.root.source_descriptor.session_id = 'another'
    if (mode === 'digest') data.value.root.source_descriptor.snapshot_digest = 'c'.repeat(64)
    if (mode === 'root_trace') data.value.root.root_trace_id = '0'.repeat(32)
    if (mode === 'failure_trace') data.value.failures[0]!.trace_id = 'c'.repeat(32)
    if (mode === 'failure_digest') data.value.failures[0]!.source_digest = 'c'.repeat(64)
    if (mode === 'reason') data.value.failures[0]!.reason = 'private_error'
    if (mode === 'time_type') Object.assign(data.value.failures[0]!, { observed_at: 123 })
    if (mode === 'time_format') data.value.failures[0]!.observed_at = 'tomorrow'
    if (mode === 'time_range') data.value.failures[0]!.observed_at = '2026-13-19T00:00:00.000Z'
    if (mode === 'time_date') data.value.failures[0]!.observed_at = '2026-02-30T00:00:00.000Z'
    if (mode === 'failures_type') Object.assign(data.value, { failures: null })
    if (mode === 'failures_bound') data.value.failures = Array.from({ length: 9 }, () => data.value.failures[0]!)
    if (mode === 'not_ok') value.ok = 'yes'
    if (mode === 'unavailable') { value.ok = false; value.errorCode = 'unavailable' }
    expect(() => readCollaborationPlanningFailure(mode === 'null' ? null : mode === 'array' ? [] : value, original)).toThrow()
  })

function fixture() {
  let now = 0, current = true
  const held: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const read = vi.fn(() => { const entry = Promise.withResolvers<unknown>(); held.push(entry); return entry.promise })
  const changed = vi.fn()
  const projection = new CollaborationDiagnosticProjection(read, () => current, changed, () => now)
  onTestFinished(async () => { projection.stop(); held.forEach((entry) =>{  entry.resolve(response()) }); await drain() })
  return { projection, read, changed, held, advance: (ms = 30_000) => { now += ms }, revoke: () => { current = false } }
}
it('waits for long planning, retains facts through refresh and rate-limits reads without a new timer', async () => {
  const f = fixture()
  expect(f.projection.observe(original, true)).toBeUndefined()
  expect(f.read).not.toHaveBeenCalled()
  f.advance()
  f.projection.observe(original, true)
  f.projection.observe(original, true)
  expect(f.read).toHaveBeenCalledOnce()
  f.held[0]!.resolve(response()); await drain()
  expect(f.changed).toHaveBeenCalledOnce()
  expect(f.projection.observe(original, true)).toEqual({ reason: 'timeout', observedAt: '2026-10-19T00:00:00.000Z' })
  expect(f.read).toHaveBeenCalledOnce()
  f.advance(); f.projection.observe(original, true)
  f.held[1]!.resolve(response()); await drain()
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(f.changed).toHaveBeenCalledOnce()
  expect(f.projection.observe(original, false)).toBeUndefined()
})
it.each(['empty', 'malformed', 'rejected', 'unsupported'] as const)('keeps %s diagnostic reads separate from execution and safe retry', async (mode) => {
  const f = fixture(); f.projection.observe(original, true); f.advance(); f.projection.observe(original, true)
  if (mode === 'rejected') f.held[0]!.reject(Error('private'))
  else f.held[0]!.resolve(mode === 'empty' ? { ok: true, value: { ...evidence(), failures: [] } }
    : mode === 'unsupported' ? { ok: false, errorCode: 'dsh_host_upgrade_required' } : { ok: true })
  await drain()
  expect(f.changed).not.toHaveBeenCalled()
  expect(f.projection.observe(original, true)).toBeUndefined()
  f.advance(); f.projection.observe(original, true)
  expect(f.read).toHaveBeenCalledTimes(mode === 'unsupported' ? 1 : 2)
})
it.each(['removed', 'output', 'revoked', 'stop'] as const)('discards a late diagnostic after %s', async (mode) => {
  const f = fixture(); f.projection.observe(original, true); f.advance(); f.projection.observe(original, true)
  if (mode === 'removed') f.projection.retain(new Set())
  if (mode === 'output') f.projection.observe(original, false)
  if (mode === 'revoked') f.revoke()
  if (mode === 'stop') f.projection.stop()
  f.held[0]!.resolve(response()); await drain()
  expect(f.changed).not.toHaveBeenCalled()
})
it('bounds concurrent underlying IPC calls even when cancellation is not cooperative', async () => {
  const f = fixture(), second = { ...original, snapshot_digest: 'c'.repeat(64) }, third = { ...original, snapshot_digest: 'd'.repeat(64) }
  for (const row of [original, second, third]) f.projection.observe(row, true)
  f.advance()
  for (const row of [original, second, third]) f.projection.observe(row, true)
  expect(f.read).toHaveBeenCalledTimes(2)
  f.projection.retain(new Set([third.snapshot_digest]))
  await drain()
  f.projection.observe(third, true)
  expect(f.read).toHaveBeenCalledTimes(2)
  f.held[0]!.resolve(response()); f.held[1]!.resolve(response()); await drain()
  f.projection.observe(third, true)
  expect(f.read).toHaveBeenCalledTimes(3)
})

it('discards a read if its synchronous bridge call closes the owning view before awaiting IPC', async () => {
  let now = 0
  const changed = vi.fn()
  const projection = new CollaborationDiagnosticProjection(async () => {
    projection.stop()
    return response()
  }, () => true, changed, () => now)
  onTestFinished(async () => { projection.stop(); await drain() })
  projection.observe(original, true); now = 30_000; projection.observe(original, true)
  await drain()
  expect(changed).not.toHaveBeenCalled()
})

it('retains observations during unknown planning metadata without starting another read', async () => {
  const f = fixture()
  expect(f.projection.observe(original, undefined)).toBeUndefined()
  f.projection.observe(original, true); f.advance()
  expect(f.projection.observe(original, undefined)).toBeUndefined()
  expect(f.read).not.toHaveBeenCalled()
  f.projection.observe(original, true)
  f.held[0]!.resolve(response()); await drain()
  f.advance()
  expect(f.projection.observe(original, undefined)).toEqual({ reason: 'timeout', observedAt: '2026-10-19T00:00:00.000Z' })
  expect(f.read).toHaveBeenCalledOnce()
  f.projection.observe(original, true)
  expect(f.read).toHaveBeenCalledTimes(2)
})
