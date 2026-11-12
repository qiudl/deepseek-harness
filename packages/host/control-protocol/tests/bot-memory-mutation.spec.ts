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
})
