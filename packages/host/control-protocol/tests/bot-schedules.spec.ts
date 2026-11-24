import { describe, expect, it } from 'vitest'
import { parseHostBotSchedules, parseHostBotSchedulesRequest } from '../src/bot-schedules.ts'

const request = { cursor: null, limit: 2 }
const task = { id: 'task-1', sessionId: 'session-1', ownerKind: 'bot', ownerId: 'main',
  roomId: 'room-1', title: 'Briefing', prompt: 'Report progress', kind: 'daily',
  status: 'active', scheduledAt: '2030-01-01T09:00:00.000Z',
  timing: { time: '09:00:00.000', timeZone: 'UTC' }, lastDelivery: null }
const page = { available: true, total: 1, tasks: [task], nextCursor: null }
const scheduleError = 'invalid_bot_schedules_result'

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

  it.each([
    ['after', { afterSeconds: 1 }],
    ['at', {}],
    ['every', { everySeconds: 60 }],
    ['daily', { time: '09:00', timeZone: 'Asia/Shanghai' }],
    ['weekly', { time: '23:59', timeZone: 'UTC', weekdays: [1, 7] }],
    ['cron', { expression: '5 9 * * 1', timeZone: 'UTC' }],
  ])('round-trips %s timing and the last delivery of a room task', (kind, timing) => {
    const lastDelivery = { scheduledAt: task.scheduledAt, deliveredAt: '2030-01-01T09:00:03.000Z',
      messageId: 'message-1' }
    const roomTask = { ...task, kind, timing, ownerKind: 'room', ownerId: task.roomId,
      status: 'inactive', lastDelivery }
    const result = { ...page, tasks: [roomTask] }
    expect(parseHostBotSchedules(result, request)).toEqual(result)
  })

  it('rejects timing data that does not match the selected schedule', () => {
    for (const [kind, timing] of [
      ['after', null],
      ['after', { everySeconds: 1 }],
      ['every', { everySeconds: '60' }],
      ['every', { everySeconds: 59.5 }],
      ['every', { everySeconds: 59 }],
      ['at', { afterSeconds: 1 }],
      ['cron', { expression: '', timeZone: 'UTC' }],
      ['cron', { expression: '5 9 * * 1', timeZone: '' }],
      ['daily', { time: '', timeZone: 'UTC' }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: '1' }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7, 8] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [1, 1] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [0] }],
      ['weekly', { time: '09:00', timeZone: 'UTC', weekdays: [8] }],
    ]) {
      expect(() => parseHostBotSchedules({ ...page, tasks: [{ ...task, kind, timing }] }, request)).toThrow(scheduleError)
    }
  })

  it('keeps pagination on one snapshot and preserves unavailable states', () => {
    const offset = (n: number) => `${'a'.repeat(64)}:${n}`
    const second = parseHostBotSchedulesRequest({ cursor: offset(1), limit: 1 })
    const next = { ...page, total: 3, nextCursor: offset(2) }
    expect(parseHostBotSchedules(next, second)).toEqual(next)
    expect(parseHostBotSchedules({ ...next, nextCursor: null }, { ...second, cursor: offset(2) }))
      .toEqual({ ...next, nextCursor: null })
    expect(parseHostBotSchedules(null, request)).toBeNull()
    const unavailable = { available: false, total: 0, tasks: [], nextCursor: null }
    expect(parseHostBotSchedules(unavailable, request)).toEqual(unavailable)
    expect(() => parseHostBotSchedulesRequest({ cursor: 'old-snapshot', limit: 1 })).toThrow('invalid_bot_schedules_request')
    for (const invalid of [
      { ...next, nextCursor: `${'b'.repeat(64)}:2` },
      { ...next, nextCursor: offset(3) },
      { ...next, nextCursor: null },
      { ...next, tasks: [] },
      { ...next, tasks: [task, task] },
    ]) {
      expect(() => parseHostBotSchedules(invalid, second)).toThrow(scheduleError)
    }
  })

  it('rejects malformed last delivery coordinates', () => {
    const delivery = { scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt, messageId: 'message-1' }
    for (const lastDelivery of [
      false,
      { ...delivery, privateBody: 'fixture' },
      { ...delivery, scheduledAt: 'unknown' },
      { ...delivery, deliveredAt: 'unknown' },
      { ...delivery, messageId: '' },
    ]) {
      expect(() => parseHostBotSchedules({ ...page, tasks: [{ ...task, lastDelivery }] }, request)).toThrow(scheduleError)
    }
  })
})
