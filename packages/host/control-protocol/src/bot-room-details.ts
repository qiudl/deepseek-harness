/** Bounded owner-room member and settings projection from the installed Bot plugin. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.js'

/** Exact room selector under an already admitted Account and Profile. */
export interface HostBotRoomDetailsRequest { readonly roomId: HostBotRoomId }
/** Public management fields; no private Session, folder, prompt or raw team state. */
export interface HostBotRoomDetails {
  readonly roomId: HostBotRoomId
  readonly revision: number
  readonly displayName: string
  readonly notice: string
  readonly replyMode: 'admin' | 'everyone'
  readonly relayLimit: number | null
  readonly permissionPreset: string | null
  readonly adminBotId: string | null
  readonly members: readonly { readonly botId: string; readonly displayName: string }[]
}

/** Parse one exact owner-room selector.
 * @param value - Decoded untrusted read arguments.
 * @returns Canonical request.
 */
export function parseHostBotRoomDetailsRequest(value: unknown): HostBotRoomDetailsRequest {
  if (!record(value) || !exact(value, ['roomId']) || !roomIdValid(value.roomId))
    throw Error('invalid_bot_room_details_request')
  return { roomId: value.roomId as HostBotRoomId }
}

/** Validate the complete plugin projection before it crosses the Host lease.
 * @param value - Untrusted plugin reply.
 * @param request - Captured room identity.
 * @returns Correlated bounded details or null when the room is unavailable.
 */
export function parseHostBotRoomDetails(value: unknown, request: HostBotRoomDetailsRequest): HostBotRoomDetails | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['roomId', 'revision', 'displayName', 'notice', 'replyMode',
    'relayLimit', 'permissionPreset', 'adminBotId', 'members']) || value.roomId !== request.roomId ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.displayName !== 'string' || !value.displayName.trim() || Buffer.byteLength(value.displayName, 'utf8') > 512 ||
    typeof value.notice !== 'string' || Buffer.byteLength(value.notice, 'utf8') > 8192 ||
    (value.replyMode !== 'admin' && value.replyMode !== 'everyone') ||
    (value.relayLimit !== null && (typeof value.relayLimit !== 'number' ||
      !Number.isSafeInteger(value.relayLimit) || value.relayLimit < 1 || value.relayLimit > 200)) ||
    (value.permissionPreset !== null && (typeof value.permissionPreset !== 'string' ||
      !value.permissionPreset.trim() || Buffer.byteLength(value.permissionPreset, 'utf8') > 200)) ||
    (value.adminBotId !== null && (typeof value.adminBotId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/u.test(value.adminBotId))) ||
    !Array.isArray(value.members) || value.members.length > 12)
    throw Error('invalid_bot_room_details_result')
  const members: HostBotRoomDetails['members'][number][] = []
  const seen = new Set<string>()
  for (const member of value.members) {
    if (!record(member) || !exact(member, ['botId', 'displayName']) ||
      typeof member.botId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(member.botId) || seen.has(member.botId) ||
      typeof member.displayName !== 'string' || !member.displayName.trim() ||
      Buffer.byteLength(member.displayName, 'utf8') > 512) throw Error('invalid_bot_room_details_result')
    seen.add(member.botId)
    members.push({ botId: member.botId, displayName: member.displayName })
  }
  if (value.adminBotId !== null && !seen.has(value.adminBotId)) throw Error('invalid_bot_room_details_result')
  return { roomId: request.roomId, revision: value.revision, displayName: value.displayName,
    notice: value.notice, replyMode: value.replyMode, relayLimit: value.relayLimit,
    permissionPreset: value.permissionPreset, adminBotId: value.adminBotId, members }
}
