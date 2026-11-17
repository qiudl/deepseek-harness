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

  it('requires a matching digest and exact byte continuity for later chunks', () => {
    const digest = 'a'.repeat(64)
    const body = Buffer.from('x'.repeat(48_000))
    const first = parseHostBotFeedbackLogRequest({ offset: 0, digest: null })
    const second = parseHostBotFeedbackLogRequest({ offset: 48_000, digest })
    const chunk = body.toString('base64')
    expect(parseHostBotFeedbackLogChunk({ digest, total: 48_001, chunk,
      nextOffset: 48_000 }, first)?.nextOffset).toBe(48_000)
    expect(parseHostBotFeedbackLogChunk({ digest, total: 48_001,
      chunk: Buffer.from('y').toString('base64'), nextOffset: null }, second)?.total).toBe(48_001)
    expect(parseHostBotFeedbackLogChunk(null, second)).toBeNull()
    for (const bad of [
      { offset: 48_000, digest: null },
      { offset: 48_000, digest: 'invalid' },
      { offset: -48_000, digest },
    ]) expect(() => parseHostBotFeedbackLogRequest(bad)).toThrow('invalid_bot_feedback_log_request')
    for (const bad of [
      { digest, total: 48_001, chunk, nextOffset: 47_999 },
      { digest, total: 48_001, chunk: Buffer.from('y').toString('base64'), nextOffset: 1 },
      { digest, total: 48_000, chunk, nextOffset: 48_000 },
    ]) expect(() => parseHostBotFeedbackLogChunk(bad, first)).toThrow('invalid_bot_feedback_log_result')
  })
})
