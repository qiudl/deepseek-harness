import { describe, expect, it } from 'vitest'
import { parseHostBotAttachmentSubmission, parseHostBotAttachmentReceipt } from '../src/bot-attachment-submission.ts'

const submission = { botId: 'main', sessionId: 'own-main',
  submissionId: '11111111-1111-4111-8111-111111111111',
  receiptId: '22222222-2222-4222-8222-222222222222',
  kind: 'file', attachmentId: `sha256:${'a'.repeat(64)}` }

describe('native Bot attachment submission', () => {
  it('binds an exact staged receipt to the original Bot chat target', () => {
    const request = parseHostBotAttachmentSubmission(submission)
    expect(request).toEqual(submission)
    expect(parseHostBotAttachmentReceipt({ botId: 'main', sessionId: 'own-main',
      submissionId: submission.submissionId, state: 'accepted' }, request)?.state).toBe('accepted')
    for (const patch of [{ botId: 'other' }, { sessionId: 'other' },
      { submissionId: '33333333-3333-4333-8333-333333333333' }, { state: 'unknown' }])
      expect(() => parseHostBotAttachmentReceipt({ botId: 'main', sessionId: 'own-main',
        submissionId: submission.submissionId, state: 'accepted', ...patch }, request))
        .toThrow('invalid_bot_attachment_receipt')
  })
  it('rejects forged selectors before Host work', () => {
    for (const patch of [{ botId: '../main' }, { sessionId: '../other' },
      { receiptId: 'foreign' }, { kind: 'text' }, { attachmentId: 'file.txt' }, { extra: true }])
      expect(() => parseHostBotAttachmentSubmission({ ...submission, ...patch }))
        .toThrow('invalid_bot_attachment_submission')
  })
})
