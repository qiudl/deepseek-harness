import { expect, it } from 'vitest'
import { parseHostBotMemoryPage, parseHostBotMemoryReadRequest } from '../src/bot-memory-read.ts'

const digest = 'a'.repeat(64)
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'memory', logical_id: 'bot:thanos', limit: 50 }
const page = { logical_id: 'bot:thanos', scope_revision: digest, next_cursor: null,
  item: { file: 'MEMORY.md', offset: 0, total_bytes: 3, sha256: digest,
    content_base64: Buffer.from('abc').toString('base64') },
  source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }

it('accepts only a logical memory scope selector', () => {
  expect(parseHostBotMemoryReadRequest(request)).toEqual(request)
  expect(parseHostBotMemoryReadRequest({ ...request, logical_id: 'team' }).logical_id).toBe('team')
  for (const invalid of [{ ...request, logical_id: 'bot:../secret' },
    { ...request, profile_id: 'other' }, { ...request, kind: 'team' },
    { ...request, limit: 101 }, { ...request, cursor: '../secret' }]) {
    expect(() => parseHostBotMemoryReadRequest(invalid)).toThrow('invalid_bot_memory_request')
  }
})

it('copies one bounded byte chunk and refuses extra or malformed data', () => {
  expect(parseHostBotMemoryPage(page)).toEqual(page)
  for (const invalid of [{ ...page, private_path: '/private/work' },
    { ...page, item: { ...page.item, file: '../secret' } },
    { ...page, item: { ...page.item, content_base64: 'YQ=' } },
    { ...page, item: { ...page.item, content_base64: 'Y WJj' } },
    { ...page, item: { ...page.item, total_bytes: 2 } },
    { ...page, item: { ...page.item, private_path: '/private/work' } },
    { ...page, item: null, next_cursor: 'abc' },
    { ...page, item: { ...page.item, total_bytes: 4 } },
  ]) expect(() => parseHostBotMemoryPage(invalid)).toThrow('invalid_bot_memory_page')
})
