import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseHostBotFeedbackLogRequest, parseHostBotFeedbackLogChunk } from '../src/bot-feedback-log.ts'

describe('native Feedback log chunk', () => {
  it('accepts bounded chunks and rejects changed digests and extra authority', () => {
    const first = parseHostBotFeedbackLogRequest({ offset: 0, digest: null })
    const body = Buffer.from('x'.repeat(48_000))
    const digest = createHash('sha256').update(body).digest('hex')
    expect(parseHostBotFeedbackLogChunk({ digest, total: body.length,
      chunk: body.toString('base64'), nextOffset: null }, first)?.total).toBe(48_000)
    expect(() => parseHostBotFeedbackLogRequest({ offset: 0, digest: null, botId: 'other' })).toThrow()
    expect(() => parseHostBotFeedbackLogRequest({ offset: 1, digest })).toThrow()
    expect(() => parseHostBotFeedbackLogChunk({ digest, total: body.length,
      chunk: body.toString('base64'), nextOffset: null }, { offset: 48_000, digest: 'f'.repeat(64) })).toThrow()
  })
})
