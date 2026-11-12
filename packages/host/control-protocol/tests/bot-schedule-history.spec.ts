import { describe, expect, it } from 'vitest'
import { parseHostBotScheduleHistory, parseHostBotScheduleHistoryRequest } from '../src/bot-schedule-history.ts'

const request = { sessionId: 'bot-session', id: 'task-1', limit: 2, before: null }
const page = { available: true, sessionId: 'bot-session', id: 'task-1', code: null,
  records: [{ scheduledAt: '2030-01-01T09:00:00.000Z', deliveredAt: '2030-01-01T09:00:01.000Z',
    messageId: 'm1', prompt: 'Do work' }], nextBefore: 'm1', earlierRecordsUnavailable: true,
  earlierRecordsPruned: false, retention: { days: 90, records: 200 } }

describe('native Bot schedule delivery history', () => {
  it('accepts one exact task page and rejects cross-task or malformed replies', () => {
    expect(parseHostBotScheduleHistoryRequest(request)).toEqual(request)
    expect(parseHostBotScheduleHistory(page, request)?.records[0]?.prompt).toBe('Do work')
    for (const forged of [
      { ...page, id: 'other-task' },
      { ...page, records: [{ ...page.records[0], secret: 'x' }] },
      { ...page, nextBefore: 'not-last' },
      { ...page, retention: { days: 0, records: 200 } },
      { ...page, records: [{ ...page.records[0], prompt: 'x'.repeat(16_001) }] },
    ]) expect(() => parseHostBotScheduleHistory(forged, request)).toThrow()
    expect(() => parseHostBotScheduleHistoryRequest({ ...request, ownerBotId: 'foreign' })).toThrow()
  })

  it('does not invent delivery records for absent tasks or disabled service', () => {
    const empty = { ...page, code: 'schedule_not_found', records: [],
      nextBefore: null, retention: null, earlierRecordsUnavailable: false }
    expect(parseHostBotScheduleHistory(empty, request)?.code).toBe('schedule_not_found')
    expect(parseHostBotScheduleHistory({ ...empty, available: false, code: null }, request)?.available).toBe(false)
    expect(() => parseHostBotScheduleHistory({ ...empty, records: page.records }, request)).toThrow()
  })
})
