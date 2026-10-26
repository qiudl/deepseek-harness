import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostBotChatAttachmentTransferRequest, parseHostBotChatAttachmentTransferResult } from '../src/index.ts'

const scope = { logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  part: 0, team_revision: 7, event_digest: 'a'.repeat(64), manifest_digest: 'b'.repeat(64),
  eventSeq: 1, blockIndex: 0 }
const open = { schema_version: 'dsh-remote-bot-attachment/v1' as const, kind: 'open' as const, ...scope }
const transferId = '10000000-0000-4000-8000-000000000001'
const next = { ...open, kind: 'next' as const, transfer_id: transferId, offset: 0 }
const descriptor = { ...scope, transfer_id: transferId, part_count: 1, type: 'file',
  ref: { attachmentId: `sha256:${'c'.repeat(64)}`, name: 'report.txt', bytes: 3 },
  total_bytes: 3, source: 'authority' }
const page = { ...scope, transfer_id: transferId, attachment_id: descriptor.ref.attachmentId,
  total_bytes: 3, offset: 0, chunk_base64: Buffer.from('abc').toString('base64'),
  final: true, source: 'authority' }

describe('REQ-20261023-0001 Bot attachment byte transfer', () => {
  it('requires the full logical scope on every action', () => {
    expect(parseHostBotChatAttachmentTransferRequest(open)).toEqual(open)
    expect(parseHostBotChatAttachmentTransferRequest(next)).toEqual(next)
    const close = { ...open, kind: 'close' as const, transfer_id: transferId }
    expect(parseHostBotChatAttachmentTransferRequest(close)).toEqual(close)
    expect(parseHostBotChatAttachmentTransferResult({ closed: true }, close)).toEqual({ closed: true })
    for (const bad of [{ ...next, manifest_digest: undefined },
      { ...next, profile_path: '/private/other' }, { ...next, offset: -1 },
      { ...open, logical_id: 'bot:../other' }, { ...open, kind: 'close' }]) {
      expect(() => parseHostBotChatAttachmentTransferRequest(bad)).toThrow()
    }
  })

  it('bounds and binds every descriptor and byte page to the request', () => {
    expect(parseHostBotChatAttachmentTransferResult(descriptor, open)).toEqual(descriptor)
    expect(parseHostBotChatAttachmentTransferResult(page, next)).toEqual(page)
    for (const bad of [{ ...page, logical_id: 'bot:other' },
      { ...page, offset: 1 }, { ...page, chunk_base64: 'YWJj=' },
      { ...page, chunk_base64: Buffer.alloc(32_769).toString('base64') },
      { ...page, final: false }, { ...page, path: '/private/other' }]) {
      expect(() => parseHostBotChatAttachmentTransferResult(bad, next)).toThrow()
    }
    expect(() => parseHostBotChatAttachmentTransferResult({ ...descriptor,
      ref: { ...descriptor.ref, path: '/private/other' } }, open)).toThrow()
    expect(() => parseHostBotChatAttachmentTransferResult({ ...descriptor, type: 'image',
      ref: { ...descriptor.ref, mediaType: 'image/png', width: 1, height: 1,
        path: '/private/other' } }, open)).toThrow()
  })

  it('roundtrips only Account-bound transfer frames', () => {
    const frame = { version: 1, type: 'request', request_id: transferId,
      method: 'profile.bot_chat_attachment_transfer', params: {
        client_instance_id: transferId,
        host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
        jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
        authority_environment_id: '40000000-0000-4000-8000-000000000004',
        account_binding_handle: 'binding:bot', authority_binding_version: 1,
        account_issuer: 'https://accounts.example.test',
        account_subject: '50000000-0000-4000-8000-000000000005', transfer: next,
      } }
    const reply = { version: 1, type: 'result', request_id: transferId,
      method: frame.method, result: { value: page } }
    for (const value of [frame, reply]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
        .toBe(`${JSON.stringify(value)}\n`)
    }
    expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame,
      params: { ...frame.params, transfer: { ...next, path: '/private/other' } } })}\n`)).toThrow()
  })
})
