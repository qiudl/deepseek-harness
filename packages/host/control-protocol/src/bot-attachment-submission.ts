/** Bot own-chat file submission bound to one Agent-scoped staged upload receipt. */
import type { HostBotChatId, HostBotChatSessionId } from './bot-chat.ts'
import type { HostBotChatSubmissionId } from './bot-chat-submission.ts'

export interface HostBotAttachmentSubmission {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly receiptId: string
  readonly kind: 'file' | 'image'
  readonly attachmentId: string
}

export interface HostBotAttachmentReceipt {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly state: 'accepted' | 'unobserved' | 'conflict' | 'stale'
}

const row = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Parse a Bot-owned Session target and the exact uploaded file identity. */
export function parseHostBotAttachmentSubmission(value: unknown): HostBotAttachmentSubmission {
  if (!row(value) || !exact(value, ['botId', 'sessionId', 'submissionId', 'receiptId', 'kind', 'attachmentId']) ||
    typeof value.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(value.botId) ||
    typeof value.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(value.sessionId) ||
    value.sessionId.includes('/') || value.sessionId.includes('\\') ||
    value.sessionId === '.' || value.sessionId === '..' ||
    typeof value.submissionId !== 'string' || !uuid.test(value.submissionId) ||
    typeof value.receiptId !== 'string' || !uuid.test(value.receiptId) ||
    (value.kind !== 'file' && value.kind !== 'image') ||
    typeof value.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.attachmentId))
    throw Error('invalid_bot_attachment_submission')
  return { botId: value.botId as HostBotChatId, sessionId: value.sessionId as HostBotChatSessionId,
    submissionId: value.submissionId as HostBotChatSubmissionId, receiptId: value.receiptId,
    kind: value.kind, attachmentId: value.attachmentId }
}

/** Correlate the plugin's durable receipt with the original Bot submission. */
export function parseHostBotAttachmentReceipt(value: unknown,
  request: HostBotAttachmentSubmission): HostBotAttachmentReceipt | null {
  if (value === null) return null
  if (!row(value) || !exact(value, ['botId', 'sessionId', 'submissionId', 'state']) ||
    value.botId !== request.botId || value.sessionId !== request.sessionId ||
    value.submissionId !== request.submissionId ||
    (value.state !== 'accepted' && value.state !== 'unobserved' &&
      value.state !== 'conflict' && value.state !== 'stale'))
    throw Error('invalid_bot_attachment_receipt')
  return { botId: request.botId, sessionId: request.sessionId,
    submissionId: request.submissionId, state: value.state }
}
