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
})
