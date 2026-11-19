import { describe, expect, it } from 'vitest'
import { parseHostBotSchedules, parseHostBotSchedulesRequest } from '../src/bot-schedules.ts'

const request = { cursor: null, limit: 2 }
const task = { id: 'task-1', sessionId: 'session-1', ownerKind: 'bot', ownerId: 'main',
  roomId: 'room-1', title: 'Briefing', prompt: 'Report progress', kind: 'daily',
  status: 'active', scheduledAt: '2030-01-01T09:00:00.000Z',
  timing: { time: '09:00:00.000', timeZone: 'UTC' }, lastDelivery: null }

describe('native Bot schedules', () => {
  it('accepts an exact page and keeps Bot tasks created in a group', () => {
    const args = parseHostBotSchedulesRequest(request)
    expect(parseHostBotSchedules({ available: true, total: 1, tasks: [task], nextCursor: null }, args))
      .toMatchObject({ tasks: [{ ownerKind: 'bot', ownerId: 'main', roomId: 'room-1' }] })
  })

  it('rejects foreign fields, malformed ownership and cursor discontinuity', () => {
    expect(() => parseHostBotSchedulesRequest({ ...request, profile: 'other' })).toThrow()
    expect(() => parseHostBotSchedules({ available: true, total: 1,
      tasks: [{ ...task, ownerKind: 'room' }], nextCursor: null }, request)).toThrow()
    expect(() => parseHostBotSchedules({ available: true, total: 2, tasks: [task],
      nextCursor: `${'a'.repeat(64)}:2` }, request)).toThrow()
    expect(() => parseHostBotSchedules({ available: false, total: 1, tasks: [],
      nextCursor: null }, request)).toThrow()
  })

  it('accepts each timing mode and a delivered room task', () => {
    const cases = [
      ['after', { afterSeconds: 1 }],
      ['at', {}],
      ['every', { everySeconds: 60 }],
      ['daily', { time: '09:00', timeZone: 'UTC' }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1, 7] }],
      ['cron', { expression: '0 9 * * *', timeZone: 'UTC' }],
    ] as const
    for (const [kind, timing] of cases) {
      const item = { ...task, id: kind, ownerKind: 'room', ownerId: 'room-1',
        kind, timing, lastDelivery: { scheduledAt: task.scheduledAt,
          deliveredAt: task.scheduledAt, messageId: 'message-1' } }
      expect(parseHostBotSchedules({ available: true, total: 1,
        tasks: [item], nextCursor: null }, request)?.tasks[0])
        .toMatchObject({ kind, timing, ownerKind: 'room', lastDelivery: item.lastDelivery })
    }
    expect(parseHostBotSchedules({ available: false, total: 0, tasks: [],
      nextCursor: null }, request)).toEqual({ available: false, total: 0,
      tasks: [], nextCursor: null })
    expect(parseHostBotSchedules(null, request)).toBeNull()
  })

  it('rejects invalid selectors without trusting a foreign Profile', () => {
    const invalid = [
      null, [], {}, { cursor: null }, { cursor: null, limit: 1, extra: true },
      { cursor: '', limit: 1 }, { cursor: 'a'.repeat(64) + ':0', limit: 1 },
      { cursor: null, limit: 0 }, { cursor: null, limit: 21 },
      { cursor: null, limit: 1.5 }, { cursor: null, limit: '1' },
    ]
    for (const value of invalid) {
      expect(() => parseHostBotSchedulesRequest(value)).toThrow('invalid_bot_schedules_request')
    }
    expect(parseHostBotSchedulesRequest({ cursor: 'a'.repeat(64) + ':1', limit: 20 }))
      .toEqual({ cursor: 'a'.repeat(64) + ':1', limit: 20 })
  })

  it('rejects malformed task identity, ownership, state, and delivery', () => {
    const invalidTasks = [
      null, [], { ...task, extra: true }, { ...task, id: '' },
      { ...task, sessionId: '' }, { ...task, ownerKind: 'foreign' },
      { ...task, ownerId: '' }, { ...task, roomId: 3 },
      { ...task, ownerKind: 'room' }, { ...task, title: '' },
      { ...task, prompt: 3 }, { ...task, kind: 'unknown' },
      { ...task, status: 'done' }, { ...task, scheduledAt: 'invalid' },
      { ...task, lastDelivery: {} },
      { ...task, lastDelivery: { scheduledAt: task.scheduledAt,
        deliveredAt: task.scheduledAt, messageId: '' } },
      { ...task, lastDelivery: { scheduledAt: 'invalid',
        deliveredAt: task.scheduledAt, messageId: 'message-1' } },
      { ...task, lastDelivery: { scheduledAt: task.scheduledAt,
        deliveredAt: 'invalid', messageId: 'message-1' } },
    ]
    for (const item of invalidTasks) {
      expect(() => parseHostBotSchedules({ available: true, total: 1,
        tasks: [item], nextCursor: null }, request)).toThrow('invalid_bot_schedules_result')
    }
  })

  it('rejects malformed timing for every task mode', () => {
    const invalid = [
      ['after', null], ['after', {}], ['after', { afterSeconds: 0 }],
      ['after', { afterSeconds: 1.5 }], ['every', { everySeconds: 59 }],
      ['at', { extra: true }], ['cron', {}],
      ['cron', { expression: '', timeZone: 'UTC' }],
      ['cron', { expression: '*', timeZone: '' }],
      ['daily', {}], ['daily', { time: '', timeZone: 'UTC' }],
      ['daily', { time: '09:00', timeZone: '' }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1, 1] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [0] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1.5] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: ['1'] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7, 8] }],
    ] as const
    for (const [kind, timing] of invalid) {
      expect(() => parseHostBotSchedules({ available: true, total: 1,
        tasks: [{ ...task, kind, timing }], nextCursor: null }, request))
        .toThrow('invalid_bot_schedules_result')
    }
  })

  it('requires page totals and cursors to advance within one snapshot', () => {
    const first = { available: true, total: 2, tasks: [task],
      nextCursor: 'a'.repeat(64) + ':1' }
    expect(parseHostBotSchedules(first, request)?.nextCursor).toBe(first.nextCursor)
    const secondRequest = { cursor: first.nextCursor, limit: 2 }
    expect(parseHostBotSchedules({ available: true, total: 2,
      tasks: [{ ...task, id: 'task-2' }], nextCursor: null }, secondRequest)?.tasks)
      .toHaveLength(1)
    const invalid = [
      undefined, [], { ...first, extra: true }, { ...first, available: 1 },
      { ...first, total: -1 }, { ...first, total: 10001 },
      { ...first, tasks: [task, task, task] }, { ...first, nextCursor: 'bad' },
      { ...first, tasks: [] }, { ...first, nextCursor: null },
      { ...first, nextCursor: 'a'.repeat(64) + ':2' },
      { available: false, total: 0, tasks: [task], nextCursor: null },
      { available: false, total: 0, tasks: [], nextCursor: first.nextCursor },
    ]
    for (const page of invalid) {
      expect(() => parseHostBotSchedules(page, request), JSON.stringify(page))
        .toThrow('invalid_bot_schedules_result')
    }
    expect(() => parseHostBotSchedules({ available: true, total: 1,
      tasks: [task], nextCursor: null }, secondRequest)).toThrow('invalid_bot_schedules_result')
    expect(() => parseHostBotSchedules({ available: true, total: 3,
      tasks: [task], nextCursor: 'b'.repeat(64) + ':2' }, secondRequest))
      .toThrow('invalid_bot_schedules_result')
  })
})
