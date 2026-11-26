import { describe, expect, it } from 'vitest'
import { parseHostBotScheduleMutationRequest, parseHostBotScheduleMutationReceipt } from '../src/bot-schedule-mutation.ts'

const base = { ownerBotId: 'main', sessionId: 'chat-1',
  requestId: '11111111-1111-4111-8111-111111111111' }
const create = { ...base, mode: 'create' as const, targetKind: 'bot' as const,
  targetId: 'main', title: 'Briefing', prompt: 'Report progress',
  when: { kind: 'daily' as const, time: '09:00', timeZone: 'UTC' } }
const remove = { ...base, mode: 'delete' as const,
  taskSessionId: 'chat-1', taskId: 'schedule-1' }
const status = { ...base, mode: 'status' as const }

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

  it('accepts the supported time rules for a Bot room', () => {
    const target = { ...create, targetKind: 'room', targetId: 'room-briefing' }
    for (const when of [
      { kind: 'at', at: '2030-02-05T10:30:00.000Z' },
      { kind: 'every', minutes: 1 },
      { kind: 'every', minutes: 10080 },
      { kind: 'daily', time: '00:00', timeZone: 'Asia/Shanghai' },
      { kind: 'weekly', time: '23:59', timeZone: 'UTC', weekdays: [1, 3, 7] },
    ]) {
      const request = { ...target, when }
      expect(parseHostBotScheduleMutationRequest(request)).toEqual(request)
    }
  })

  it('rejects malformed time rules, ownership coordinates and write titles', () => {
    for (const when of [
      null,
      { kind: 'at', at: 'tomorrow' },
      { kind: 'every', minutes: 0 },
      { kind: 'every', minutes: 1.5 },
      { kind: 'every', minutes: 10081 },
      { kind: 'daily', time: '24:00', timeZone: 'UTC' },
      { kind: 'daily', time: '09:00', timeZone: '' },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [] },
      { kind: 'weekly', time: '09:00', timeZone: 'UTC', weekdays: [1, 8] },
    ]) {
      expect(() => parseHostBotScheduleMutationRequest({ ...create, when })).toThrow('invalid_bot_schedule_mutation')
    }
    for (const request of [
      null,
      { ...create, ownerBotId: '../main' },
      { ...create, requestId: 'unbound' },
      { ...create, targetKind: 'room', targetId: '../room' },
      { ...create, title: ' padded' },
      { ...create, title: '界'.repeat(121) },
      { ...remove, taskId: '' },
    ]) {
      expect(() => parseHostBotScheduleMutationRequest(request)).toThrow('invalid_bot_schedule_mutation')
    }
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

  it('returns separate receipts for deletion, unknown status and an unavailable Host', () => {
    expect(parseHostBotScheduleMutationReceipt(null, status)).toBeNull()
    const deleted = { requestId: base.requestId, operation: 'delete', state: 'deleted',
      taskId: remove.taskId, sessionId: remove.taskSessionId }
    expect(parseHostBotScheduleMutationReceipt(deleted, remove)).toEqual(deleted)
    expect(parseHostBotScheduleMutationReceipt(deleted, status)).toEqual(deleted)
    const unknown = { requestId: base.requestId, operation: null, state: 'unknown', taskId: null, sessionId: null }
    expect(parseHostBotScheduleMutationReceipt(unknown, status)).toEqual(unknown)
    for (const invalid of [
      { ...unknown, operation: 'delete' },
      { ...unknown, state: 'pending' },
      { ...deleted, state: 'created' },
      { ...deleted, state: ['deleted'] },
      { ...deleted, taskId: '' },
    ]) {
      expect(() => parseHostBotScheduleMutationReceipt(invalid, status)).toThrow('invalid_bot_schedule_mutation_receipt')
    }
    expect(() => parseHostBotScheduleMutationReceipt({ ...deleted, taskId: 'different-task' }, remove))
      .toThrow('invalid_bot_schedule_mutation_receipt')
  })
})
