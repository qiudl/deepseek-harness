import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostBotChatAttachmentsPage, parseHostBotChatAttachmentsReadRequest } from '../src/index.ts'

const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat-attachments',
  logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', part: 1, limit: 10 }
const item = { eventSeq: 12, blockIndex: 1, type: 'image', ref: {
  attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 12,
  width: 1, height: 1, name: 'photo.png',
} }
const page = { logical_id: request.logical_id, part: 1, part_count: 2, team_revision: 7,
  event_digest: 'a'.repeat(64), manifest_digest: 'b'.repeat(64), items: [item],
  next_cursor: null, source: 'authority', last_confirmed_at: '2026-10-26T12:00:00.000Z' }

describe('REQ-20261023-0001 Bot chat attachment Host contract', () => {
  it('accepts only a bounded logical Bot selector', () => {
    expect(parseHostBotChatAttachmentsReadRequest(request)).toEqual(request)
    for (const bad of [{ ...request, profile_id: 'other' }, { ...request, session_id: 'session-x' },
      { ...request, logical_id: 'bot:../other' }, { ...request, part: -1 },
      { ...request, limit: 101 }, { ...request, cursor: '../other' }]) {
      expect(() => parseHostBotChatAttachmentsReadRequest(bad)).toThrow('invalid_bot_chat_attachments_request')
    }
  })

  it('accepts visible refs and rejects extra fields, unsafe names and oversized pages', () => {
    expect(parseHostBotChatAttachmentsPage(page)).toEqual(page)
    for (const bad of [{ ...page, private_path: '/private/work' },
      { ...page, items: [{ ...item, ref: { ...item.ref, localPath: '/private/work' } }] },
      { ...page, items: [{ ...item, ref: { ...item.ref, name: '../secret' } }] },
      { ...page, items: [{ ...item, ref: { ...item.ref, attachmentId: 'other' } }] },
      { ...page, items: [], next_cursor: 'YWJj' },
      { ...page, items: Array(101).fill(item) },
      { ...page, items: [{ ...item, ref: { ...item.ref, name: 'x'.repeat(60_000) } }] }]) {
      expect(() => parseHostBotChatAttachmentsPage(bad)).toThrow('invalid_bot_chat_attachments_page')
    }
  })

  it('roundtrips only Account-bound manifest frames', () => {
    const frame = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
      method: 'profile.bot_chat_attachments_read', params: {
        client_instance_id: '10000000-0000-4000-8000-000000000001',
        host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
        jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
        authority_environment_id: '40000000-0000-4000-8000-000000000004',
        account_binding_handle: 'binding:bot', authority_binding_version: 1,
        account_issuer: 'https://accounts.example.test',
        account_subject: '50000000-0000-4000-8000-000000000005', read: request,
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
