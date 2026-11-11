/** Actual worker run/claim ownership, independent of HTTP arrival order. */
import { expect, it } from 'vitest'
import type { PairedTaskTargetAdmission } from '@deepseek-ai/dsh-api-session-controller/host/paired-task-target-journal'
import { DesktopTaskTargetRuns } from '../src/desktop-task-target-runs.ts'

const admission: PairedTaskTargetAdmission = Object.freeze({ itemId: 'item', projectionId: 'projection', logicalKey: 'logical',
  admissionId: 'admission', consumeIntentId: 'intent', readyDirectiveDigest: 'ready', readyJson: '{}', challengeJson: '{}',
  state: 'claimed', sourceReceiptJson: '{}', sourceConsumeReceiptDigest: 'receipt', messageId: 'message', turn: 1, step: 1 })
function fixture() {
  const lifetime = new AbortController(), request = new AbortController(), execution = new AbortController()
  const accepted = Promise.withResolvers<PairedTaskTargetAdmission>(), completion = Promise.withResolvers<PairedTaskTargetAdmission>()
  const runs = new DesktopTaskTargetRuns(lifetime.signal)
  let starts = 0, original: AbortSignal | undefined
  const start = (signal: AbortSignal) => {
    starts++; original = signal; return { accepted: accepted.promise, completion: completion.promise }
  }
  return { runs, lifetime, request, execution, accepted, completion, start, starts: () => starts, original: () => original }
}
it.each(['run-first', 'wait-first'] as const)('claims once and retains the long run through actual cleanup: %s', async (order) => {
  const f = fixture()
  let claimed: Promise<PairedTaskTargetAdmission>, running: Promise<PairedTaskTargetAdmission>
  if (order === 'run-first') {
    running = f.runs.run('intent', 'binding', f.start, f.execution.signal)
    expect(f.starts()).toBe(0)
    claimed = f.runs.waitClaim('intent', 'binding', f.request.signal)
  } else {
    claimed = f.runs.waitClaim('intent', 'binding', f.request.signal)
    expect(f.starts()).toBe(0)
    running = f.runs.run('intent', 'binding', f.start, f.execution.signal)
  }
  let cleaned = false
  void running.then(() => { cleaned = true })
  f.accepted.resolve(admission)
  expect(await claimed).toBe(admission)
  expect(f.starts()).toBe(1)
  expect(f.original()).toBe(f.request.signal)
  expect(cleaned).toBe(false)
  f.request.abort(Error('unary closed after claim'))
  expect(cleaned).toBe(false)
  f.completion.resolve(admission)
  expect(await running).toBe(admission)
  await f.runs.close()
})
it('refuses a changed private binding and duplicate runs before any second start', async () => {
  const f = fixture(), running = f.runs.run('intent', 'binding', f.start, f.execution.signal)
  await expect(f.runs.waitClaim('intent', 'different', f.request.signal)).rejects.toThrow('conflict')
  await expect(f.runs.run('intent', 'binding', f.start, f.execution.signal)).rejects.toThrow('conflict')
  const claimed = f.runs.waitClaim('intent', 'binding', f.request.signal)
  f.accepted.resolve(admission); await claimed
  f.completion.resolve(admission); await running
  expect(f.starts()).toBe(1)
  await f.runs.close()
})
it('releases an aborted waiter without starting work and rejects a run whose parent already closed', async () => {
  const f = fixture(), waiting = f.runs.waitClaim('intent', 'binding', f.request.signal)
  const closed = Error('original request closed')
  f.request.abort(closed)
  await expect(waiting).rejects.toBe(closed)
  f.execution.abort(closed)
  await expect(f.runs.run('intent', 'binding', f.start, f.execution.signal)).rejects.toBe(closed)
  expect(f.starts()).toBe(0)
  await f.runs.close()
})
it('teardown cancels unattached runs and waits for already started cleanup', async () => {
  const f = fixture(), unattached = f.runs.run('unattached', 'binding', f.start, f.execution.signal)
  const running = f.runs.run('intent', 'binding', f.start, f.execution.signal)
  const claimed = f.runs.waitClaim('intent', 'binding', f.request.signal)
  f.accepted.resolve(admission); await claimed
  const denied = expect(unattached).rejects.toThrow('closed')
  let closed = false
  const closing = f.runs.close().then(() => { closed = true })
  await denied
  expect(closed).toBe(false)
  f.completion.resolve(admission); await running; await closing
  expect(f.starts()).toBe(1)
})
it('bounds pending short waiters and frees their capacity on cancellation', async () => {
  const f = fixture(), requests = Array.from({ length: 64 }, () => new AbortController())
  const pending = requests.map((controller, n) => f.runs.waitClaim(String(n), 'binding', controller.signal))
  const rejected = Promise.allSettled(pending)
  await expect(f.runs.waitClaim('overflow', 'binding', f.request.signal)).rejects.toThrow('capacity')
  for (const controller of requests) controller.abort(Error('closed'))
  await rejected
  const next = f.runs.waitClaim('next', 'binding', f.request.signal)
  f.request.abort(Error('closed')); await expect(next).rejects.toThrow('closed')
  await f.runs.close()
})
