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

  it('accepts every supported time rule for a controlled Bot or room', () => {
    const whenCases = [
      { kind: 'at', at: '2030-01-01T09:00:00.000Z' },
      { kind: 'every', minutes: 1 },
      { kind: 'every', minutes: 10080 },
      { kind: 'daily', time: '09:00', timeZone: 'UTC' },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [1, 7] },
    ]
    for (const when of whenCases) {
      const request = { ...create, targetKind: 'room', targetId: 'chat-1', when }
      expect(parseHostBotScheduleMutationRequest(request)).toEqual(request)
    }
  })

  it('rejects invalid time rules and unbounded request fields', () => {
    const invalidWhen = [
      null, { kind: 'at', at: 'invalid' }, { kind: 'at', at: '2030-01-01', extra: true },
      { kind: 'every', minutes: 0 }, { kind: 'every', minutes: 10081 },
      { kind: 'every', minutes: 1.5 }, { kind: 'daily', time: '25:00', timeZone: 'UTC' },
      { kind: 'daily', time: '09:00', timeZone: '' },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [] },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [0] },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [8] },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [1.5] },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7, 8] },
    ]
    for (const when of invalidWhen) {
      expect(() => parseHostBotScheduleMutationRequest({ ...create, when }))
        .toThrow('invalid_bot_schedule_mutation')
    }
    const invalid = [
      null, [], { ...create, ownerBotId: '../other' }, { ...create, sessionId: '../other' },
      { ...create, requestId: 'other' }, { ...create, targetKind: 'room', targetId: '../other' },
      { ...create, title: '' }, { ...create, title: ' Briefing' },
      { ...create, title: 'x'.repeat(121) }, { ...create, prompt: 'Report progress ' },
      { ...create, prompt: 'x'.repeat(16001) }, { ...remove, taskId: '' },
      { ...remove, taskId: 'x'.repeat(201) }, { ...base, mode: 'status', extra: true },
    ]
    for (const value of invalid) {
      expect(() => parseHostBotScheduleMutationRequest(value))
        .toThrow('invalid_bot_schedule_mutation')
    }
  })

  it('keeps uncertain, deleted, and missing receipts tied to the request', () => {
    const pending = { requestId: base.requestId, operation: 'create',
      state: 'pending', taskId: null, sessionId: null }
    expect(parseHostBotScheduleMutationReceipt(null, create)).toBeNull()
    for (const state of ['pending', 'failed', 'unavailable']) {
      expect(parseHostBotScheduleMutationReceipt({ ...pending, state }, create)?.state).toBe(state)
    }
    const status = parseHostBotScheduleMutationRequest({ ...base, mode: 'status' })
    expect(parseHostBotScheduleMutationReceipt({ ...pending, operation: null,
      state: 'unknown' }, status)?.state).toBe('unknown')
    const deleted = { ...pending, operation: 'delete', state: 'deleted',
      taskId: remove.taskId, sessionId: remove.taskSessionId }
    expect(parseHostBotScheduleMutationReceipt(deleted, remove)?.state).toBe('deleted')
    expect(parseHostBotScheduleMutationReceipt({ ...deleted, state: 'missing' }, remove)?.state)
      .toBe('missing')
    expect(parseHostBotScheduleMutationReceipt(deleted, status)?.operation).toBe('delete')
  })

  it('rejects contradictory or foreign receipts', () => {
    const pending = { requestId: base.requestId, operation: 'create',
      state: 'pending', taskId: null, sessionId: null }
    const invalid = [
      [], { ...pending, extra: true }, { ...pending, operation: 'other' },
      { ...pending, state: 'other' }, { ...pending, taskId: '' },
      { ...pending, sessionId: '../other' },
      { ...pending, operation: null }, { ...pending, state: 'unknown' },
      { ...pending, state: 'created' }, { ...pending, state: 'deleted' },
      { ...pending, operation: 'delete', state: 'created',
        taskId: 'schedule-1', sessionId: 'chat-1' },
    ]
    for (const receipt of invalid) {
      expect(() => parseHostBotScheduleMutationReceipt(receipt, create))
        .toThrow('invalid_bot_schedule_mutation_receipt')
    }
    expect(() => parseHostBotScheduleMutationReceipt({ ...pending, operation: 'delete',
      state: 'deleted', taskId: 'foreign', sessionId: remove.taskSessionId }, remove))
      .toThrow('invalid_bot_schedule_mutation_receipt')
    let reads = 0
    const changing = { ...pending, get state() { return ++reads > 4 ? 'forged' : 'pending' } }
    expect(() => parseHostBotScheduleMutationReceipt(changing, create))
      .toThrow('invalid_bot_schedule_mutation_receipt')
  })
})
