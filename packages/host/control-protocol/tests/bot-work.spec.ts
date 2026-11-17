import { describe, expect, it } from 'vitest'
import { parseHostBotWork, parseHostBotWorkRequest } from '../src/bot-work.ts'

describe('fixed Bot work read', () => {
  const request = { cursor: null, limit: 20 }
  it('admits only a bounded cursor and limit, without caller-selected authority', () => {
    expect(parseHostBotWorkRequest(request)).toEqual(request)
    for (const value of [{ cursor: null, limit: 0 }, { cursor: null, limit: 51 },
      { cursor: null, limit: 20, profile: 'other' }, { cursor: null, limit: 20, botId: 'other' },
      { cursor: '*', limit: 20 }, { cursor: null, limit: 20.5 }])
      expect(() => parseHostBotWorkRequest(value)).toThrow()
    for (const value of [null, [], {}, { cursor: null },
      { cursor: undefined, limit: 20 }, { cursor: '', limit: 20 },
      { cursor: 'x'.repeat(401), limit: 20 }, { cursor: 1, limit: 20 },
      { cursor: 'a_B-1', limit: -1 }, { cursor: 'a_B-1', limit: Number.NaN }])
      expect(() => parseHostBotWorkRequest(value)).toThrow()
    expect(parseHostBotWorkRequest({ cursor: 'a_B-1', limit: 50 })).toEqual({ cursor: 'a_B-1', limit: 50 })
  })

  it('captures only scoped coordinates and explicit source states', () => {
    const item = { taskId: 'a'.repeat(64), botId: 'main', sessionId: 'part-1', messageId: 'm1',
      admissionEventSeq: 1, instructionEventSeq: 2, turn: 1, terminalEventSeq: null,
      state: 'running', updatedAt: 1000 }
    const ready = { schemaVersion: 1, state: 'ready', generation: 2, total: 1,
      items: [item], nextCursor: null }
    expect(parseHostBotWork(ready, request)).toEqual(ready)
    expect(() => parseHostBotWork({ ...ready, nextCursor: 'same' },
      { cursor: 'same', limit: 20 })).toThrow()
    for (const state of ['loading', 'unavailable', 'snapshot_changed'])
      expect(parseHostBotWork({ schemaVersion: 1, state }, request)).toEqual({ schemaVersion: 1, state })
    expect(parseHostBotWork(null, request)).toBeNull()
    for (const bad of [
      undefined, [], {}, { schemaVersion: 2, state: 'ready' }, { schemaVersion: 1, state: 1 },
      { ...ready, state: 'other' }, { ...ready, generation: -1 },
      { ...ready, total: -1 }, { ...ready, nextCursor: '*' },
      { ...ready, items: null }, { ...ready, items: Array(21).fill(item) },
      { ...ready, items: [], nextCursor: 'next' },
      { ...ready, items: [null] },
      { ...ready, items: [{ ...item, text: 'private' }] },
      { ...ready, items: [{ ...item, botId: '../other' }] },
      { ...ready, items: [{ ...item, state: 'completed' }] },
      { ...ready, items: [item, item] },
      { ...ready, total: 0 },
      { schemaVersion: 1, state: 'loading', items: [] },
    ]) expect(() => parseHostBotWork(bad, request)).toThrow()

    const invalidItemFields = [
      { taskId: 'bad' }, { botId: '../other' }, { sessionId: '../other' },
      { messageId: 1 }, { messageId: '' }, { messageId: 'x'.repeat(257) },
      { admissionEventSeq: -1 }, { instructionEventSeq: -1 },
      { turn: 0 }, { turn: -1 }, { terminalEventSeq: -1 },
      { state: 'completed' }, { updatedAt: -1 },
    ]
    for (const changed of invalidItemFields)
      expect(() => parseHostBotWork({ ...ready, items: [{ ...item, ...changed }] }, request)).toThrow()
    expect(parseHostBotWork({ ...ready, items: [{ ...item, instructionEventSeq: null,
      turn: null, terminalEventSeq: 3, state: 'reply_complete' }] }, request)).not.toBeNull()
  })
})
