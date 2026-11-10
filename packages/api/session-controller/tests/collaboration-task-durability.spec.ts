/** Pure bounded Session fold vectors; no fixture state is an execution or drain authority. */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { collaborationTaskDurabilityProjection as projection } from '../src/collaboration-task-durability.ts'

const initial = (inherited = 0) => projection.init({ id: SessionId('fold-test'), version: SESSION_FORMAT_VERSION,
  isSeeded: inherited > 0, createdAt: 0 }, SessionLogOffset(inherited))
const turn = (seq = 0, value = 1): SessionEvent<'turn/start'> => ({ type: 'turn/start', seq: SessionSeq(seq), time: seq,
  data: { turn: value } })
const step = (seq = 1, value = 1, turn = 1): SessionEvent<'step/start'> => ({ type: 'step/start', seq: SessionSeq(seq), time: seq,
  data: { turn, step: value } })
const call = (id = 'a', seq = 2, turn = 1, step = 1, name = 'fixture'): SessionEvent<'tool/call'> => ({ type: 'tool/call',
  seq: SessionSeq(seq), time: seq, data: { turn, step, callId: ToolCallId(id), name, arguments: '{"test":"argument-body"}' } })
const result = (id = 'a', seq = 3, source = id): SessionEvent<'tool/result'> => ({ type: 'tool/result', seq: SessionSeq(seq), time: seq,
  surfaceOp: 'append', sourceEventSeqs: [SessionSeq(2)], data: { turn: 1, step: 1,
    message: { ...createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: 'result-body' }], isError: false }),
      id: MessageId('result-fixed'), source: { kind: 'tool', callId: ToolCallId(source) } } } })
const end = (seq = 4, value = 1): SessionEvent<'turn/end'> => ({ type: 'turn/end', seq: SessionSeq(seq), time: seq,
  data: { turn: value, reason: { kind: 'completed' } } })
const begun = () => projection.apply(projection.apply(initial(), turn()), step())

describe('actual-event task durability fold', () => {
  it('retains exact fixed-domain references while excluding all arguments/results', () => {
    const called = projection.apply(begun(), call())
    expect(called.pairs[0]?.callDigest).toBe('27bed91278e9d460d344927de40de32963b159d11dd396f18d1b774c6e2aefef')
    const settled = projection.apply(called, result())
    expect(settled.pairs[0]).toMatchObject({ callId: 'a', toolName: 'fixture', callSeq: 2, resultSeq: 3 })
    const done = projection.apply(settled, end())
    expect(done.end?.digest).toBe('2e3bdfeba5aa992925f603b7888d57ecb1c0fc096da9f6ecad59077050cbe1ab')
    expect(JSON.stringify(done)).not.toContain('argument-body')
    expect(JSON.stringify(done)).not.toContain('result-body')
    expect(projection.stateSchema.parse(done)).toEqual(done)
  })
  it('preserves unrelated and inherited events by identity', () => {
    const state = begun()
    expect(projection.apply(state, { type: 'step/end', seq: SessionSeq(8), time: 8, data: { turn: 1, step: 1 } })).toBe(state)
    const inherited = initial(9)
    expect(projection.apply(inherited, call())).toBe(inherited)
  })
  it('restarts only the next real turn/step without retaining history-sized references', () => {
    const old = projection.apply(projection.apply(begun(), call()), result())
    const next = projection.apply(old, step(9, 2))
    expect(next.pairs).toEqual([])
    expect(projection.apply(next, turn(10, 2))).toMatchObject({ turn: 2, step: null, end: null, pairs: [], complete: true })
    expect(projection.apply(old, step(9, 2, 2)).complete).toBe(false)
    expect(projection.apply(old, end(10, 2)).complete).toBe(false)
  })
  it.each(['wrong_turn', 'wrong_step', 'after_end', 'duplicate', 'long_id', 'long_name', 'capacity'] as const)(
    'keeps %s call metadata unknown without truncating a complete claim', (mode) => {
      let state = begun(), value = call()
      if (mode === 'wrong_turn') value = call('a', 2, 2)
      if (mode === 'wrong_step') value = call('a', 2, 1, 2)
      if (mode === 'after_end') state = projection.apply(state, end())
      if (mode === 'duplicate') state = projection.apply(state, call())
      if (mode === 'long_id') value = call('x'.repeat(257))
      if (mode === 'long_name') value = call('a', 2, 1, 1, 'x'.repeat(257))
      if (mode === 'capacity') {
        const pair = projection.apply(state, call()).pairs[0]
        if (!pair) throw Error('unit fixture call missing')
        state = projection.stateSchema.parse({ ...state, pairs: Array.from({ length: 10000 }, (_, index) => ({
          ...pair, callId: 'existing-' + String(index) })) })
      }
      expect(projection.apply(state, value).complete).toBe(false)
    })
  it.each(['orphan', 'duplicate', 'wrong_source', 'wrong_order'] as const)('rejects %s result association', (mode) => {
    let state = begun(), value = result()
    if (mode !== 'orphan') state = projection.apply(state, call())
    if (mode === 'duplicate') state = projection.apply(state, result())
    if (mode === 'wrong_source') value = result('a', 3, 'another')
    if (mode === 'wrong_order') value = result('a', 2)
    expect(projection.apply(state, value).complete).toBe(false)
  })
  it('updates only the matching pair and restores a checkpoint plus suffix exactly', () => {
    const both = projection.apply(projection.apply(begun(), call()), call('b', 3))
    const checkpoint = projection.stateSchema.parse(JSON.parse(JSON.stringify(both)))
    const next = result('b', 4)
    expect(projection.apply(checkpoint, next)).toEqual(projection.apply(both, next))
    expect(projection.apply(both, next).pairs[0]?.resultSeq).toBeNull()
    expect(projection.apply(both, next).pairs[1]?.resultSeq).toBe(4)
  })
})


it('classifies only the actual error result as cancelled before dispatch', () => {
  const called = projection.apply(begun(), call())
  for (const isError of [false, true]) for (const code of ['ABORTED', 'ABORTED_BEFORE_DISPATCH']) {
    const original = result()
    const value: SessionEvent<'tool/result'> = { ...original, data: { ...original.data,
      message: { ...original.data.message, isError }, error: { name: 'AbortError', code } } }
    expect(projection.apply(called, value).pairs[0]?.abortedBeforeDispatch).toBe(isError && code === 'ABORTED_BEFORE_DISPATCH')
  }
})
