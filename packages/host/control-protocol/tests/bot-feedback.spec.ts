import { describe, expect, it } from 'vitest'
import { parseHostBotFeedbackClearRequest } from '../src/bot-feedback-clear.ts'
import { parseHostBotFeedbackRequest, parseHostBotFeedback } from '../src/bot-feedback.js'

describe('native redacted Bot feedback contract', () => {
  const report = { total: 1, entries: [{ time: 1700000000000, level: 'error',
    source: 'host', text: 'Connection failed', code: null }], markdown: 'Redacted report',
  markdownTruncated: false, issuesUrl: 'https://github.com/Fei2411/DeepSeek-Bot/issues/new' }

  it('admits only an empty request and exact report fields', () => {
    expect(parseHostBotFeedbackRequest({})).toEqual({})
    expect(() => parseHostBotFeedbackRequest({ account: 'other' })).toThrow()
    expect(parseHostBotFeedback(report)).toEqual(report)
    expect(() => parseHostBotFeedback({ ...report, token: 'private' })).toThrow()
    expect(() => parseHostBotFeedback({ ...report, issuesUrl: 'https://evil.test' })).toThrow()
    expect(() => parseHostBotFeedback({ ...report,
      entries: [{ ...report.entries[0], stack: 'private' }] })).toThrow()
  })
  it('binds log clear to one Bot Session without extra authority', () => {
    expect(parseHostBotFeedbackClearRequest({ botId: 'main', sessionId: 'chat-1' }))
      .toEqual({ botId: 'main', sessionId: 'chat-1' })
    expect(() => parseHostBotFeedbackClearRequest({ botId: 'main', sessionId: 'chat-1',
      profileId: 'other' })).toThrow()
    expect(() => parseHostBotFeedbackClearRequest({ botId: 'main', sessionId: '../other' })).toThrow()
  })
})
