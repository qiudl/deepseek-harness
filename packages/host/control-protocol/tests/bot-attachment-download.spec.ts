import { describe, expect, it } from 'vitest'
import {
  parseHostBotAttachmentDownloadOpenRequest, parseHostBotAttachmentDownloadOpen,
  parseHostBotAttachmentDownloadReadRequest, parseHostBotAttachmentDownloadChunk,
} from '../src/bot-attachment-download.ts'

const transferId = '11111111-1111-4111-8111-111111111111'
const request = { botId: 'main', sessionId: 'chat-main', eventSeq: 7,
  attachmentId: `sha256:${'a'.repeat(64)}` }

describe('Bot original attachment transfer', () => {
  it('binds a safe handle to a visible message selector', () => {
    expect(parseHostBotAttachmentDownloadOpenRequest(request)).toEqual(request)
    expect(parseHostBotAttachmentDownloadOpen({ transferId, attachmentId: request.attachmentId,
      name: 'source.bin', bytes: null }, request)).toEqual({
      transferId, attachmentId: request.attachmentId, name: 'source.bin', bytes: null,
    })
    expect(() => parseHostBotAttachmentDownloadOpenRequest({ ...request, eventSeq: 0 }))
      .toThrow('invalid_bot_attachment_download_request')
    expect(() => parseHostBotAttachmentDownloadOpen({ transferId, attachmentId: request.attachmentId,
      name: '../private', bytes: 5 }, request)).toThrow('invalid_bot_attachment_download_result')
    expect(() => parseHostBotAttachmentDownloadOpen({ transferId, attachmentId: `sha256:${'b'.repeat(64)}`,
      name: 'source.bin', bytes: 5 }, request)).toThrow('invalid_bot_attachment_download_result')
  })

  it('accepts exact sequential bytes and rejects malformed or oversized chunks', () => {
    const read = { transferId, offset: 0 }
    const bytes = Buffer.alloc(40 * 1024, 7).toString('base64')
    expect(parseHostBotAttachmentDownloadReadRequest(read)).toEqual(read)
    expect(parseHostBotAttachmentDownloadChunk({ ...read, bytes: null,
      chunk: bytes, hasMore: true }, read)?.chunk).toBe(bytes)
    expect(parseHostBotAttachmentDownloadChunk({ ...read, bytes: 0,
      chunk: '', hasMore: false }, read)?.chunk).toBe('')
    for (const value of [
      { ...read, bytes: null, chunk: 'a', hasMore: false },
      { ...read, bytes: null, chunk: Buffer.alloc(10).toString('base64'), hasMore: true },
      { ...read, bytes: 1, chunk: bytes, hasMore: true },
      { ...read, bytes: null, chunk: Buffer.alloc(40 * 1024 + 1).toString('base64'), hasMore: true },
      { ...read, bytes: null, chunk: bytes, hasMore: true, private: true },
    ]) expect(() => parseHostBotAttachmentDownloadChunk(value, read))
      .toThrow('invalid_bot_attachment_download_result')
    expect(() => parseHostBotAttachmentDownloadReadRequest({ transferId, offset: 1 }))
      .toThrow('invalid_bot_attachment_download_request')
  })
})
