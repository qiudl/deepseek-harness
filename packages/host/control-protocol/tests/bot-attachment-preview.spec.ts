import { describe, expect, it } from 'vitest'
import { parseHostBotAttachmentPreview, parseHostBotAttachmentPreviewRequest } from '../src/bot-attachment-preview.ts'

const request = { botId: 'main', sessionId: 'own-main', eventSeq: 7,
  attachmentId: `sha256:${'a'.repeat(64)}`, offset: 0 }
const value = { ...request, name: 'report.txt', total: 6, sha256: 'b'.repeat(64),
  chunk: 'report', hasMore: false, whole: true }

describe('native Bot attachment preview contract', () => {
  it('binds every reply coordinate and text boundary', () => {
    expect(parseHostBotAttachmentPreviewRequest(request)).toEqual(request)
    expect(parseHostBotAttachmentPreview(value, request)).toEqual(value)
    for (const patch of [{ sessionId: 'foreign' }, { eventSeq: 8 }, { attachmentId: `sha256:${'c'.repeat(64)}` },
      { offset: 8_000 }, { chunk: 'wrong' }, { name: 'archive.zip' }, { hasMore: true }])
      expect(() => parseHostBotAttachmentPreview({ ...value, ...patch }, request)).toThrow('invalid_bot_attachment_preview_result')
  })
  it('rejects arbitrary selectors', () => {
    for (const patch of [{ sessionId: '../other' }, { botId: '../main' }, { eventSeq: 0 },
      { offset: 1 }, { attachmentId: 'file.txt' }, { extra: true }])
      expect(() => parseHostBotAttachmentPreviewRequest({ ...request, ...patch })).toThrow('invalid_bot_attachment_preview_request')
  })
})
