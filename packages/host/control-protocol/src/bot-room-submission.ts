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
  if (!row(value) || !exact(value, ['roomId', 'submissionId', 'text']) || !roomIdValid(value.roomId) ||
    typeof value.submissionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.submissionId) ||
    typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text, 'utf8') > 16_384)
    throw Error('invalid_bot_room_submission')
  return { roomId: value.roomId as HostBotRoomId,
    submissionId: value.submissionId as HostBotRoomSubmissionId, text: value.text.trim() }
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
