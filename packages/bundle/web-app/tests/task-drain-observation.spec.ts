/** Actual Main/controller/Loader/Native/JSONL cut; Cloud signatures and effect provider are controlled. */
import { createHash, randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { taskDrainHarness } from './task-drain-observation.test-support.ts'

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v)
const digest = (value: unknown) => createHash('sha256').update('dsh.task-coordination.session-event/v1\0').update(canonical(value)).digest('hex')

it.each(['durable', 'undurable', 'ignored_abort', 'expired_ignored_abort', 'executor_replaced'] as const)(
  'keeps original native/body/prefix identity at %s', async (mode) => {
    let bodies = 0, denyFlush = false
    const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<undefined>()
    const h = await taskDrainHarness(async () => {
      bodies++; entered.resolve(undefined)
      if (mode === 'undurable') denyFlush = true
      if (mode === 'ignored_abort' || mode === 'expired_ignored_abort') await finish.promise
      return 'isolated completed effect'
    })
    const { f, rt, scope, operate } = h
    onTestFinished(() => { finish.resolve(undefined) })
    if (mode === 'undurable') {
      const original = rt.ctx.sessions.flush.bind(rt.ctx.sessions)
      vi.spyOn(rt.ctx.sessions, 'flush').mockImplementation((...args) => denyFlush ? Promise.resolve(false) : original(...args))
    }
    const signal = new AbortController().signal
    const work = rt.controller.collaborationRootConsumption(rt.start, signal)
    let settled = false
    const outcome = work.then((value) => { settled = true; return { ok: true as const, value } },
      (error: unknown) => { settled = true; return { ok: false as const, error } })
    await Promise.race([entered.promise, outcome.then(() => { throw Error('original body never entered') })])
    const ignored = mode === 'ignored_abort' || mode === 'expired_ignored_abort'
    if (!ignored) await outcome
    expect(bodies).toBe(1)
    if (mode === 'executor_replaced') rt.agent.ctx.tools.setExecutor(new NativeToolExecutor(rt.agent.ctx))
    if (mode === 'expired_ignored_abort') {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(rt.start.grant.expires_at) + 1)
      try { expect(rt.ctx.get('collaborationTaskExecutions')?.read(rt.agent.id, 1)).toBeNull() }
      finally { clock.mockRestore() }
      expect(settled).toBe(false)
    }
    const transferRequestId = randomUUID()
    const closed = await operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }, scope))
    if (!closed.ok || closed.record.status !== 'closed') throw Error('actual closed cut missing')
    const originalAck = JSON.stringify(closed.record.fenceAck)
    const observe = async () => {
      const result = await operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 50 }, scope))
      if (!result.ok || result.record.status !== 'observed') throw Error('actual observation missing')
      return result.record.observation
    }
    let observed = await observe()
    let native = observed.items.find(item => item.kind === 'native_call')
    if (mode === 'undurable') {
      expect(native).toMatchObject({ state: 'returned_not_durable', disposition: 'running', callSeq: null, resultSeq: null })
      expect(observed.quiescence).not.toBe('quiescent')
      expect((await rt.controller.openCollaborationTaskCoordinationJournal()).jobs(rt.execution.execution_command_id)
        .every(job => job.state !== 'settled')).toBe(true)
      return
    }
    if (ignored) {
      expect(settled).toBe(false)
      expect(native).toMatchObject({ state: 'body_entered', disposition: 'running', resultSeq: null })
      expect(observed.quiescence).toBe('in_flight')
      finish.resolve(undefined); await outcome; await rt.agent.whenIdle()
      observed = await observe(); native = observed.items.find(item => item.kind === 'native_call')
    }
    expect(native).toMatchObject({ state: 'settled', disposition: 'terminal_receipted' })
    if (!native || native.kind !== 'native_call') throw Error('original native invocation missing')
    expect(typeof native.callSeq).toBe('number'); expect(typeof native.resultSeq).toBe('number')
    expect(native.callDigest).toMatch(/^[a-f0-9]{64}$/u); expect(native.resultDigest).toMatch(/^[a-f0-9]{64}$/u)
    const stored = await rt.ctx.sessionPersistence.open(rt.agent.id, 'read')
    try {
      const { events } = await stored.read()
      const call = events.find(event => event.type === 'tool/call'), result = events.find(event => event.type === 'tool/result')
      expect(call).toBeDefined(); expect(result).toBeDefined()
      expect(native).toMatchObject({ callSeq: call?.seq, callDigest: digest(call), resultSeq: result?.seq, resultDigest: digest(result) })
      expect(events.some(event => event.type === 'turn/end' && event.data.reason.kind !== 'interrupted')).toBe(true)
    } finally { await stored.close() }
    if (mode === 'executor_replaced') expect(observed).toMatchObject({ coverage: { native: 'unknown' }, quiescence: 'unknown' })
    else expect(observed).toMatchObject({ coverage: { native: 'complete', device: 'unsupported' }, quiescence: 'unknown' })
    const receipt = await operate(f.create({ operation: 'receipt', transferRequestId }, scope))
    if (!receipt.ok || receipt.record.status !== 'found') throw Error('original receipt missing')
    expect(JSON.stringify(receipt.record.fenceAck)).toBe(originalAck)
    expect(bodies).toBe(1)
    expect(await rt.controller.collaborationRootExecution({ action: 'read', target: rt.target, selection: rt.selection }, signal)).toEqual(rt.execution)
  })


it('observes real no-body cancellation and durable terminal after an awaited wrapper replaces its signal', async () => {
  let bodies = 0
  const waiting = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const { f, rt, scope, operate } = await taskDrainHarness(async () => { bodies++; return 'never dispatched' })
  onTestFinished(() => { release.resolve(undefined) })
  rt.ctx.on('tools/execute', async (exec, next) => {
    waiting.resolve(undefined)
    await release.promise
    exec.signal = new AbortController().signal
    return next()
  })
  const work = rt.controller.collaborationRootConsumption(rt.start, new AbortController().signal)
  const outcome = work.then(() => undefined, () => undefined)
  await Promise.race([waiting.promise, outcome.then(() => { throw Error('wrapper was never reached') })])
  const transferRequestId = randomUUID()
  const closed = await operate(f.create({ operation: 'fence', transferRequestId, payloadDigest: 'd'.repeat(64) }, scope))
  if (!closed.ok || closed.record.status !== 'closed') throw Error('actual floor missing')
  release.resolve(undefined); await outcome; await rt.agent.whenIdle()
  const observed = await operate(f.create({ operation: 'observe', transferRequestId, inventoryId: null, cursor: null, pageSize: 50 }, scope))
  if (!observed.ok || observed.record.status !== 'observed') throw Error('actual terminal cut missing')
  expect(bodies).toBe(0)
  expect(observed.record.observation).toMatchObject({ coverage: { native: 'complete', device: 'unsupported' }, quiescence: 'quiescent' })
  const native = observed.record.observation.items.find(item => item.kind === 'native_call')
  expect(native).toMatchObject({ state: 'settled', disposition: 'cancelled_before_effect' })
  if (!native || native.kind !== 'native_call') throw Error('original invocation missing')
  const handle = await rt.ctx.sessionPersistence.open(rt.agent.id, 'read')
  try {
    const { events } = await handle.read()
    const result = events.find(event => event.type === 'tool/result')
    expect(result).toMatchObject({ data: { error: { code: 'ABORTED_BEFORE_DISPATCH' }, message: { isError: true } } })
    expect(events.some(event => event.type === 'turn/end')).toBe(true)
    expect(native.resultSeq).toBe(result?.seq); expect(native.resultDigest).toBe(digest(result))
  } finally { await handle.close() }
})
