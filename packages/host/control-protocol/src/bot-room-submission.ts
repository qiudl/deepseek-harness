/** Stable owner room admission and reconciliation, scoped to the active Profile. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.ts'
import { botRecord as row, botExactKeys as exact } from './bot-value-shape.ts'

/** Original user submission identity retained across transport retries. */
export type HostBotRoomSubmissionId = Branded<'HostBotRoomSubmissionId'>
/** Exact existing room target and bounded text; no caller-selected Account or Profile. */
export interface HostBotRoomSubmission {
  readonly roomId: HostBotRoomId
  readonly submissionId: HostBotRoomSubmissionId
  readonly text: string
  readonly files?: readonly HostBotRoomAttachment[]
}
/** One staged file resolved against the original group Agent before admission. */
export interface HostBotRoomAttachment {
  readonly kind: 'file' | 'image'
  readonly receiptId: string
  readonly attachmentId: string
}
/** Absence of an event is not proof that resending is safe. */
export interface HostBotRoomReceipt {
  readonly roomId: HostBotRoomId
  readonly submissionId: HostBotRoomSubmissionId
  readonly state: 'accepted' | 'unobserved' | 'conflict' | 'stale'
}
/** Validate an exact owner room submission.
 * @param value - Decoded untrusted command request.
 * @returns Canonical bounded request.
 */
export function parseHostBotRoomSubmission(value: unknown): HostBotRoomSubmission {
  if (!row(value) || !(exact(value, ['roomId', 'submissionId', 'text']) ||
    exact(value, ['roomId', 'submissionId', 'text', 'files'])) || !roomIdValid(value.roomId) ||
    typeof value.submissionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.submissionId) ||
    typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > 16_384)
    throw Error('invalid_bot_room_submission')
  let files: HostBotRoomAttachment[] | undefined
  if ('files' in value) {
    if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 5)
      throw Error('invalid_bot_room_submission')
    const receipts = new Set<string>()
    files = value.files.map((file: unknown) => {
      if (!row(file) || !exact(file, ['kind', 'receiptId', 'attachmentId']) ||
        (file.kind !== 'file' && file.kind !== 'image') ||
        typeof file.receiptId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(file.receiptId) ||
        typeof file.attachmentId !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(file.attachmentId) ||
        receipts.has(file.receiptId)) throw Error('invalid_bot_room_submission')
      receipts.add(file.receiptId)
      return { kind: file.kind, receiptId: file.receiptId, attachmentId: file.attachmentId }
    })
  }
  if (!value.text.trim() && !files) throw Error('invalid_bot_room_submission')
  return { roomId: value.roomId as HostBotRoomId,
    submissionId: value.submissionId as HostBotRoomSubmissionId, text: value.text.trim(),
    ...(files ? { files } : {}) }
}

/** Verify that a plugin receipt belongs to the captured room request.
 * @param value - Untrusted plugin or worker response.
 * @param request - Captured request identity.
 * @returns Correlated minimal receipt or null for unavailable plugin.
 */
export function parseHostBotRoomReceipt(value: unknown, request: HostBotRoomSubmission): HostBotRoomReceipt | null {
  if (value === null) return null
  if (!row(value) || !exact(value, ['roomId', 'submissionId', 'state']) ||
    value.roomId !== request.roomId || value.submissionId !== request.submissionId ||
    (value.state !== 'accepted' && value.state !== 'unobserved' && value.state !== 'conflict' && value.state !== 'stale'))
    throw Error('invalid_bot_room_receipt')
  return { roomId: request.roomId, submissionId: request.submissionId, state: value.state }
}
