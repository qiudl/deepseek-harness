import { describe, expect, it } from 'vitest'
import { parseHostBotScheduleMutationRequest, parseHostBotScheduleMutationReceipt } from '../src/bot-schedule-mutation.ts'

const base = { ownerBotId: 'main', sessionId: 'chat-1',
  requestId: '11111111-1111-4111-8111-111111111111' }
const create = { ...base, mode: 'create' as const, targetKind: 'bot' as const,
  targetId: 'main', title: 'Briefing', prompt: 'Report progress',
  when: { kind: 'daily' as const, time: '09:00', timeZone: 'UTC' } }
const remove = { ...base, mode: 'delete' as const,
  taskSessionId: 'chat-1', taskId: 'schedule-1' }

describe('controlled Bot schedule mutation', () => {
  it('accepts bounded create, delete, and status requests', () => {
    expect(parseHostBotScheduleMutationRequest(create)).toEqual(create)
    expect(parseHostBotScheduleMutationRequest(remove)).toEqual(remove)
    expect(parseHostBotScheduleMutationRequest({ ...base, mode: 'status' }).mode).toBe('status')
    for (const forged of [{ ...create, targetId: '../other' },
      { ...create, prompt: '  ' }, { ...create, when: { kind: 'weekly', time: '09:00',
        timeZone: 'UTC', weekdays: [1, 1] } },
      { ...remove, taskSessionId: '../other' }, { ...create, profileId: 'other' }])
      expect(() => parseHostBotScheduleMutationRequest(forged)).toThrow('invalid_bot_schedule_mutation')
  })

  it('correlates definite and uncertain results to the original operation', () => {
    const pending = { requestId: base.requestId, operation: 'create', state: 'pending',
      taskId: null, sessionId: null }
    expect(parseHostBotScheduleMutationReceipt(pending, create)?.state).toBe('pending')
    expect(parseHostBotScheduleMutationReceipt({ ...pending, state: 'created',
      taskId: 'schedule-1', sessionId: 'chat-1' }, create)?.state).toBe('created')
    expect(() => parseHostBotScheduleMutationReceipt({ ...pending, operation: 'delete' }, create))
      .toThrow('invalid_bot_schedule_mutation_receipt')
    expect(() => parseHostBotScheduleMutationReceipt({ ...pending, requestId: 'other' }, create))
      .toThrow('invalid_bot_schedule_mutation_receipt')
    expect(() => parseHostBotScheduleMutationReceipt({ ...pending, state: 'deleted',
      taskId: 'schedule-1', sessionId: 'outside', operation: 'delete' }, remove))
      .toThrow('invalid_bot_schedule_mutation_receipt')
  })
})
