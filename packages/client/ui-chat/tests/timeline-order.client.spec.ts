import { expect, it } from 'vitest'
import type { ChatTimelineRow } from '../src/client/contract/slots.ts'
import type { ChatTimelineRecord } from '../src/client/timeline.ts'
import { mergeChatTimeline } from '../src/client/chat/timeline-order.ts'

const row = (sequence: number | null): ChatTimelineRow => ({ key: `ordinary:${sequence}`, sequence })
function group(order: string, sequence: number | null): ChatTimelineRecord {
  return { recordId: order, afterSequence: sequence, localOrder: order }
}
const ids = (entries: ReturnType<typeof mergeChatTimeline>) => entries.map(entry =>
  entry.kind === 'ordinary' ? entry.row.key : `source:${entry.record.recordId}`)

it('places originals after their first ordinary sequence and orders equal positions by exact int64 order', () => {
  const rows = Object.freeze([row(0), row(2), row(4)])
  const groups = Object.freeze([group('4', 2), group('3', 0), group('2', 0), group('1', null)])
  expect(ids(mergeChatTimeline(rows, groups))).toEqual([
    'source:1', 'ordinary:0', 'source:2', 'source:3', 'ordinary:2', 'source:4', 'ordinary:4',
  ])
  expect(groups[0]?.recordId).toBe('4')
  expect(ids(mergeChatTimeline([], [group('9223372036854775807', 0), group('9223372036854775806', 0)])))
    .toEqual(['source:9223372036854775806', 'source:9223372036854775807'])
})

it('opens only a display group crossed by a Source, keeping unrelated group controls and ordinary keys', () => {
  const grouped: ChatTimelineRow = { key: 'process', sequence: 0, members: [row(0), row(2), row(4)] }
  expect(ids(mergeChatTimeline([grouped, row(6)], [group('1', 2)])))
    .toEqual(['ordinary:0', 'ordinary:2', 'source:1', 'ordinary:4', 'ordinary:6'])
  expect(ids(mergeChatTimeline([grouped, row(6)], [group('1', 4)]))).toEqual(['process', 'source:1', 'ordinary:6'])
  expect(ids(mergeChatTimeline([grouped], [group('1', null)]))).toEqual(['source:1', 'process'])
  expect(mergeChatTimeline([grouped], [])[0]).toEqual({ kind: 'ordinary', row: grouped })
})

it('keeps virtual ordinary rows and unpositioned groups without inventing a legacy ordering', () => {
  const unknown: ChatTimelineRow = { key: 'unknown', sequence: null, members: [row(null)] }
  expect(ids(mergeChatTimeline([unknown, row(2)], []))).toEqual(['unknown', 'ordinary:2'])
  expect(ids(mergeChatTimeline([unknown], [group('2', 2)]))).toEqual(['unknown', 'source:2'])
  expect(ids(mergeChatTimeline([{ ...unknown, members: [] }], []))).toEqual(['unknown'])
})
