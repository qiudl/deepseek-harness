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
  })

  it('captures only scoped coordinates and explicit source states', () => {
    const item = { taskId: 'a'.repeat(64), botId: 'main', sessionId: 'part-1', messageId: 'm1',
      admissionEventSeq: 1, instructionEventSeq: 2, turn: 1, terminalEventSeq: null,
      state: 'running', updatedAt: 1000 }
    const ready = { schemaVersion: 1, state: 'ready', generation: 2, total: 1,
      items: [item], nextCursor: null }
    expect(parseHostBotWork(ready, request)).toEqual(ready)
    for (const state of ['loading', 'unavailable', 'snapshot_changed'])
      expect(parseHostBotWork({ schemaVersion: 1, state }, request)).toEqual({ schemaVersion: 1, state })
    expect(parseHostBotWork(null, request)).toBeNull()
    for (const bad of [
      { ...ready, items: [{ ...item, text: 'private' }] },
      { ...ready, items: [{ ...item, botId: '../other' }] },
      { ...ready, items: [{ ...item, state: 'completed' }] },
      { ...ready, items: [item, item] },
      { ...ready, total: 0 },
      { schemaVersion: 1, state: 'loading', items: [] },
    ]) expect(() => parseHostBotWork(bad, request)).toThrow()
  })
})
