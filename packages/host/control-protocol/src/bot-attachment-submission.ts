/** Bot own-chat file submission bound to one Agent-scoped staged upload receipt. */
import type { HostBotChatId, HostBotChatSessionId } from './bot-chat.ts'
import { parseHostBotChatReceipt, type HostBotChatSubmissionId } from './bot-chat-submission.ts'
import { botExactKeys as exact, botRecord as row } from './bot-value-shape.ts'

/** Bot-owned attachment submission using a staged Agent upload receipt. */
export interface HostBotAttachmentSubmission {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly receiptId: string
  readonly kind: 'file' | 'image'
  readonly attachmentId: string
}

/** Durable outcome for the original Bot attachment submission ID. */
export interface HostBotAttachmentReceipt {
  readonly botId: HostBotChatId
  readonly sessionId: HostBotChatSessionId
  readonly submissionId: HostBotChatSubmissionId
  readonly state: 'accepted' | 'unobserved' | 'conflict' | 'stale'
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Parse a Bot-owned Session target and the exact uploaded file identity.
 * @param value - Untrusted native submission.
 * @returns A validated Bot attachment submission.
 */
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

/** Correlate the plugin's durable receipt with the original Bot submission.
 * @param value - Untrusted plugin receipt.
 * @param request - Validated original submission.
 * @returns A correlated receipt or null when no receipt exists.
 */
export function parseHostBotAttachmentReceipt(value: unknown,
  request: HostBotAttachmentSubmission): HostBotAttachmentReceipt | null {
  try { return parseHostBotChatReceipt(value, request) }
  catch { throw Error('invalid_bot_attachment_receipt') }
}
