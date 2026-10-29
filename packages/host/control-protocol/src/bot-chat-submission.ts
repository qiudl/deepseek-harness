/** Stable Bot own-chat admission and reconciliation, scoped to the active Profile. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostBotChatId, HostBotChatSessionId } from './bot-chat.ts'

/** Stable user submission identity, retained across transport requests. */
export type HostBotChatSubmissionId = Branded<'HostBotChatSubmissionId'>
/** Expected part is a precondition, never an arbitrary Session routing authority. */
export interface HostBotChatSubmission {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly text: string
}
/** Unobserved is absence of evidence, not proof that retrying is safe. */
export interface HostBotChatReceipt {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly state: 'accepted' | 'unobserved' | 'conflict' | 'stale'
}
const row = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/**
 * Validate and snapshot a bounded Bot submission, normalizing outer whitespace.
 * @param value - Decoded request with no caller-selected Profile or API endpoint.
 * @returns Bot, expected own-chat part, stable submission identity and text.
 */
export function parseHostBotChatSubmission(value: unknown): HostBotChatSubmission {
  if (!row(value) || !exact(value, ['botId', 'sessionId', 'submissionId', 'text'])
    || typeof value.botId !== 'string' || !value.botId.length || value.botId.length > 200 || /[^A-Za-z0-9_-]/u.test(value.botId)
    || typeof value.sessionId !== 'string' || !value.sessionId.length || value.sessionId.length > 256
    || /[^!-~]|[/\\]/u.test(value.sessionId) || value.sessionId === '.' || value.sessionId === '..'
    || typeof value.submissionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.submissionId)
    || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text, 'utf8') > 16_384)
    throw Error('invalid_bot_chat_submission')
  return { botId: value.botId as HostBotChatId, sessionId: value.sessionId as HostBotChatSessionId,
    submissionId: value.submissionId as HostBotChatSubmissionId, text: value.text.trim() }
}

/**
 * Validate a minimal receipt and bind it to the captured submission target.
 * @param value - Untrusted plugin or worker response; null means unavailable.
 * @param request - Captured submission, independent from transport request ID.
 * @returns A correlated acceptance observation, without prompt content.
 */
export function parseHostBotChatReceipt(value: unknown, request: HostBotChatSubmission): HostBotChatReceipt | null {
  if (value === null) return null
  if (!row(value) || !exact(value, ['botId', 'sessionId', 'submissionId', 'state'])
    || value.botId !== request.botId || value.sessionId !== request.sessionId || value.submissionId !== request.submissionId
    || (value.state !== 'accepted' && value.state !== 'unobserved' && value.state !== 'conflict' && value.state !== 'stale'))
    throw Error('invalid_bot_chat_receipt')
  return { botId: request.botId, sessionId: request.sessionId, submissionId: request.submissionId, state: value.state }
}
