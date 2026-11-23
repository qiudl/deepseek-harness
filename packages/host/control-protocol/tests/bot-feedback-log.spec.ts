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

  it('binds a second log page to the first page digest and exact byte offset', () => {
    const first = parseHostBotFeedbackLogRequest({ offset: 0, digest: null })
    const body = Buffer.from('x'.repeat(48_000) + 'tail')
    const digest = createHash('sha256').update(body).digest('hex')
    const startPage = { digest, total: body.length,
      chunk: body.subarray(0, 48_000).toString('base64'), nextOffset: 48_000 }
    expect(parseHostBotFeedbackLogChunk(startPage, first)).toEqual(startPage)
    const second = parseHostBotFeedbackLogRequest({ offset: 48_000, digest })
    const endPage = { digest, total: body.length,
      chunk: body.subarray(48_000).toString('base64'), nextOffset: null }
    expect(parseHostBotFeedbackLogChunk(endPage, second)).toEqual(endPage)
    expect(parseHostBotFeedbackLogChunk(null, second)).toBeNull()
    expect(() => parseHostBotFeedbackLogRequest({ offset: 48_000, digest: null }))
      .toThrow('invalid_bot_feedback_log_request')
    expect(() => parseHostBotFeedbackLogChunk({ ...startPage, nextOffset: 96_000 }, first))
      .toThrow('invalid_bot_feedback_log_result')
    expect(() => parseHostBotFeedbackLogChunk({ ...endPage, nextOffset: body.length, total: body.length + 1 }, second))
      .toThrow('invalid_bot_feedback_log_result')
  })
})
