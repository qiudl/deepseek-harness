import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

export type HostBotFeedbackClearRequest = Readonly<{ botId: string; sessionId: string }>

export function parseHostBotFeedbackClearRequest(value: unknown): HostBotFeedbackClearRequest {
  if (!record(value) || !exact(value, ['botId', 'sessionId']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    typeof value.sessionId !== 'string' || value.sessionId.length > 256 ||
    !/^[!-~]+$/u.test(value.sessionId) || /[/\\]/u.test(value.sessionId) ||
    value.sessionId === '.' || value.sessionId === '..') throw Error('invalid_bot_feedback_clear_request')
  return { botId: value.botId, sessionId: value.sessionId }
}
