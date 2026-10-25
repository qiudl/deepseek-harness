import { describe, expect, it } from 'vitest'
import { parseHostBotChatPage, parseHostBotChatReadRequest } from '../src/bot-chat-read.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
  logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', part: 1 }
const page = { logical_id: request.logical_id, part: 1, part_count: 2, team_revision: 7,
  event_digest: 'a'.repeat(64), rows_digest: 'b'.repeat(64), complete: true,
  total_bytes: 8, offset: 0, content_base64: Buffer.from('1234').toString('base64'),
  next_cursor: 'YWJj', source: 'authority', last_confirmed_at: '2026-10-24T12:00:00.000Z' }

describe('REQ-20261023-0001 private Bot chat Host contract', () => {
  it('accepts only a bounded current-team Bot and part selector', () => {
    expect(parseHostBotChatReadRequest(request)).toEqual({ ...request, limit: 32 * 1024 })
    for (const bad of [{ ...request, profile_id: 'other' }, { ...request, session_id: 'session-x' },
      { ...request, logical_id: 'bot:../x' }, { ...request, part: -1 },
      { ...request, kind: 'group-history' }, { ...request, limit: 32 * 1024 + 1 },
      { ...request, cursor: '../x' }]) {
      expect(() => parseHostBotChatReadRequest(bad)).toThrow('invalid_bot_chat_request')
    }
  })

  it('accepts a canonical page and refuses malformed bytes, fields or progress', () => {
    expect(parseHostBotChatPage(page)).toEqual(page)
    for (const bad of [{ ...page, private_path: '/private/work' },
      { ...page, content_base64: '!!!' }, { ...page, part_count: 1 },
      { ...page, complete: false }, { ...page, total_bytes: 0 },
      { ...page, next_cursor: null }, { ...page, offset: 8 },
      { ...page, content_base64: Buffer.alloc(32 * 1024 + 1).toString('base64') }]) {
      expect(() => parseHostBotChatPage(bad)).toThrow('invalid_bot_chat_page')
    }
  })

  it('roundtrips only Account-bound private Bot chat frames', () => {
    const frame = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.bot_chat_read', params: {
        client_instance_id: '10000000-0000-4000-8000-000000000001',
        host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
        jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
        authority_environment_id: '40000000-0000-4000-8000-000000000004',
        account_binding_handle: 'binding:bot', authority_binding_version: 1,
        account_issuer: 'https://accounts.example.test',
        account_subject: '50000000-0000-4000-8000-000000000005',
        read: { ...request, limit: 32 * 1024 },
      } }
    const reply = { version: 1, type: 'result', request_id: frame.request_id,
      method: frame.method, result: { page } }
    for (const value of [frame, reply]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
        .toBe(`${JSON.stringify(value)}\n`)
    }
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      params: { ...frame.params, read: { ...request, profile_id: 'other' } } })}\n`)).toThrow()
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...reply,
      result: { page: { ...page, private_path: '/private/work' } } })}\n`)).toThrow()
  })
})
