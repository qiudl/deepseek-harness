import { describe, expect, it } from 'vitest'
import { parseHostBotMemoryMutationRequest, parseHostBotMemoryMutationReceipt }
  from '../src/bot-memory-mutation.ts'

const ask = { mode: 'ask' as const, ownerBotId: 'main', sessionId: 'chat-1',
  requestId: '11111111-1111-4111-8111-111111111111',
  targetKind: 'bot' as const, targetId: 'main', text: 'Remember tea' }
const applied = { requestId: ask.requestId, operation: 'ask', targetKind: 'bot',
  targetId: 'main', state: 'applied', reply: 'Done', truncated: false,
  changes: [{ op: 'add', scope: 'own', text: 'Prefers tea', before: null,
    ok: true, error: null }] }

describe('controlled native Bot memory writes', () => {
  it('accepts an exact Bot or group target and bounds the text', () => {
    expect(parseHostBotMemoryMutationRequest(ask)).toEqual(ask)
    const group = { ...ask, mode: 'forget', targetKind: 'room', targetId: 'room-1',
      scope: 'group', topic: null, text: 'Old fact' }
    expect(parseHostBotMemoryMutationRequest(group).mode).toBe('forget')
    expect(parseHostBotMemoryMutationRequest({ mode: 'status', ownerBotId: 'main',
      sessionId: 'chat-1', requestId: ask.requestId, targetKind: 'room', targetId: 'room-1' }).mode)
      .toBe('status')
    for (const forged of [{ ...ask, targetId: 'other' }, { ...ask, text: ' ' },
      { ...ask, text: 'x'.repeat(2001) }, { ...ask, profileId: 'other' },
      { ...group, scope: 'team' }, { ...group, targetId: '../room' }])
      expect(() => parseHostBotMemoryMutationRequest(forged)).toThrow('invalid_bot_memory_mutation')
  })

  it('correlates a bounded partial result and rejects private fields', () => {
    expect(parseHostBotMemoryMutationReceipt(applied, ask)?.changes[0]?.ok).toBe(true)
    const status = { mode: 'status' as const, ownerBotId: 'main', sessionId: 'chat-1',
      requestId: ask.requestId, targetKind: 'bot' as const, targetId: 'main' }
    expect(parseHostBotMemoryMutationReceipt(applied, status)?.state).toBe('applied')
    const unknown = { requestId: ask.requestId, operation: null, targetKind: null,
      targetId: null, state: 'unknown', reply: null, changes: [], truncated: false }
    expect(parseHostBotMemoryMutationReceipt(unknown, status)?.state).toBe('unknown')
    for (const forged of [{ ...applied, targetId: 'other' },
      { ...applied, changes: [{ ...applied.changes[0], secret: 'private' }] },
      { ...applied, reply: 'x'.repeat(8001) }, { ...applied, requestId: 'other' },
      { ...applied, state: 'pending' }, { ...unknown, reply: 'private' }])
      expect(() => parseHostBotMemoryMutationReceipt(forged, ask))
        .toThrow('invalid_bot_memory_mutation_receipt')
  })
  it('keeps durable ask, forget, and status outcomes distinct', () => {
    const status = { mode: 'status' as const, ownerBotId: 'main', sessionId: 'chat-1',
      requestId: ask.requestId, targetKind: 'bot' as const, targetId: 'main' }
    const forget = { ...ask, mode: 'forget' as const, scope: 'own' as const, topic: 'tea', text: 'Old fact' }
    expect(parseHostBotMemoryMutationRequest(forget)).toEqual(forget)
    for (const state of ['pending', 'missing', 'unavailable']) {
      const receipt = { ...applied, state, reply: null, changes: [] }
      expect(parseHostBotMemoryMutationReceipt(receipt, status)?.state).toBe(state)
    }
    const forgotten = { ...applied, operation: 'forget', state: 'applied', reply: null, changes: [] }
    expect(parseHostBotMemoryMutationReceipt(forgotten, forget)?.operation).toBe('forget')
    const changes = [
      { op: 'edit', scope: 'team', text: 'Prefers coffee', before: 'Prefers tea', ok: true, error: null },
      { op: 'remove', scope: 'group', text: 'Old fact', before: 'Old fact', ok: false, error: 'not found' },
    ]
    expect(parseHostBotMemoryMutationReceipt({ ...applied, changes }, ask)?.changes).toEqual(changes)
    expect(parseHostBotMemoryMutationReceipt(null, ask)).toBeNull()
  })

  it('rejects forged memory outcomes and cross-target edits', () => {
    for (const bad of [null, {}, { ...ask, requestId: 'bad' }, { ...ask, ownerBotId: '../other' },
      { ...ask, mode: 'status', text: 'hidden' }, { ...ask, mode: 'forget', scope: 'group', topic: null },
      { ...ask, mode: 'forget', scope: 'own', topic: '', text: 'Old fact' },
      { ...ask, mode: 'forget', scope: 'own', topic: null, text: '' },
      { ...ask, text: 'x'.repeat(8001) }, { ...ask, mode: 'unknown' }])
      expect(() => parseHostBotMemoryMutationRequest(bad)).toThrow('invalid_bot_memory_mutation')
    const malformed = [undefined, {}, { ...applied, operation: 'forget' },
      { ...applied, targetKind: 'room' }, { ...applied, state: 'unknown' },
      { ...applied, changes: Array(21).fill(applied.changes[0]) },
      { ...applied, truncated: 'no' }, { ...applied, state: 'missing', reply: null },
      { ...applied, changes: [{ ...applied.changes[0], op: 'unknown' }] },
      { ...applied, changes: [{ ...applied.changes[0], scope: 'unknown' }] },
      { ...applied, changes: [{ ...applied.changes[0], text: 'x'.repeat(801) }] },
      { ...applied, changes: [{ ...applied.changes[0], before: 1 }] },
      { ...applied, changes: [{ ...applied.changes[0], ok: 'yes' }] },
      { ...applied, changes: [{ ...applied.changes[0], error: 'x'.repeat(257) }] },
    ]
    for (const value of malformed)
      expect(() => parseHostBotMemoryMutationReceipt(value, ask)).toThrow('invalid_bot_memory_mutation_receipt')
  })
})
