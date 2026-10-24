import { expect, it } from 'vitest'
import { parseHostBotMemoryPage, parseHostBotMemoryReadRequest } from '../src/bot-memory-read.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

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

it('roundtrips only Account-bound memory read frames', () => {
  const frame = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
    method: 'profile.bot_memory_read', params: {
      client_instance_id: '10000000-0000-4000-8000-000000000001',
      host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
      jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
      authority_environment_id: '40000000-0000-4000-8000-000000000004',
      account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test', account_subject: '50000000-0000-4000-8000-000000000005',
      read: request,
    } }
  const reply = { version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
    result: { page } }
  for (const value of [frame, reply]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
      .toBe(`${JSON.stringify(value)}\n`)
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
    params: { ...frame.params, read: { ...request, profile_id: 'other' } } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...reply,
    result: { page: { ...page, private_path: '/private/work' } } })}\n`)).toThrow()
})
