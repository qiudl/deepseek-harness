import { describe, expect, it } from 'vitest'
import { parseHostBotGroupHistoryPage, parseHostBotGroupHistoryReadRequest } from '../src/bot-group-history-read.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'group-history',
  logical_id: 'room:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }
const page = { logical_id: request.logical_id, seq: 2, digest: 'a'.repeat(64), complete: true,
  total_bytes: 8, offset: 0, content_base64: Buffer.from('1234').toString('base64'),
  next_cursor: 'YWJj', source: 'authority', last_confirmed_at: '2026-10-24T12:00:00.000Z' }

describe('REQ-20261023-0001 group history Host contract', () => {
  it('accepts one bounded logical group selector', () => {
    expect(parseHostBotGroupHistoryReadRequest(request)).toEqual({ ...request, limit: 32 * 1024 })
    for (const bad of [{ ...request, profile_id: 'other' }, { ...request, logical_id: 'room:../x' },
      { ...request, kind: 'memory' }, { ...request, limit: 32 * 1024 + 1 },
      { ...request, cursor: '../x' }]) {
      expect(() => parseHostBotGroupHistoryReadRequest(bad)).toThrow('invalid_bot_group_history_request')
    }
  })

  it('accepts a canonical bounded page and refuses malformed bytes or progress', () => {
    expect(parseHostBotGroupHistoryPage(page)).toEqual(page)
    expect(parseHostBotGroupHistoryPage({ ...page, offset: 4, next_cursor: null })).toEqual({
      ...page, offset: 4, next_cursor: null,
    })
    for (const bad of [{ ...page, profile_id: 'other' }, { ...page, content_base64: '!!!' },
      { ...page, content_base64: Buffer.from('123456789').toString('base64') },
      { ...page, next_cursor: null }, { ...page, offset: 8 },
      { ...page, seq: 0 }, { ...page, total_bytes: 0 },
      { ...page, content_base64: Buffer.alloc(32 * 1024 + 1).toString('base64') }]) {
      expect(() => parseHostBotGroupHistoryPage(bad)).toThrow('invalid_bot_group_history_page')
    }
  })

  it('roundtrips only Account-bound group history frames', () => {
    const frame = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.bot_group_history_read', params: {
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
