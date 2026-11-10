/** Bounded owner room summaries supplied by the installed Bot plugin. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

/** Existing group Session identity in the lease-selected Profile. */
export type HostBotRoomId = Branded<'HostBotRoomId'>
/** Cursor and maximum page size; no Profile or Account selector is accepted. */
export interface HostBotRoomListRequest { readonly afterRoomId: HostBotRoomId | ''; readonly limit: number }
/** Room names and counts without private Bot state or group message bodies. */
export interface HostBotRoomList {
  readonly revision: number
  readonly rooms: readonly {
    readonly roomId: HostBotRoomId
    readonly displayName: string
    readonly botCount: number
    readonly pinned: boolean
    readonly hidden: boolean
  }[]
  readonly nextCursor: HostBotRoomId | null
}
const roomIdValid = (value: unknown): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= 256 && value !== '.' && value !== '..' &&
  !/[^!-~]|[/\\]/u.test(value)

/**
 * Reject caller-selected authority and unbounded paging.
 * @param value - Decoded request arguments.
 * @returns Canonical room page request.
 */
export function parseHostBotRoomListRequest(value: unknown): HostBotRoomListRequest {
  if (!record(value) || !exact(value, ['afterRoomId', 'limit']) ||
    (value.afterRoomId !== '' && !roomIdValid(value.afterRoomId)) ||
    typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) ||
    value.limit < 1 || value.limit > 100) throw Error('invalid_bot_room_list_request')
  return { afterRoomId: value.afterRoomId as HostBotRoomId | '', limit: value.limit }
}

/**
 * Validate the plugin's room page before sending it through the Host carrier.
 * @param value - Untrusted plugin response.
 * @param request - Captured page request.
 * @returns Owner-visible room summaries or plugin absence.
 */
export function parseHostBotRoomList(value: unknown, request: HostBotRoomListRequest): HostBotRoomList | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['revision', 'rooms', 'nextCursor']) ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !Array.isArray(value.rooms) || value.rooms.length > request.limit ||
    (value.nextCursor !== null && !roomIdValid(value.nextCursor))) throw Error('invalid_bot_room_list_result')
  let previous: string = request.afterRoomId
  const rooms: HostBotRoomList['rooms'][number][] = []
  for (const item of value.rooms) {
    if (!record(item) || !exact(item, ['roomId', 'displayName', 'botCount', 'pinned', 'hidden']) ||
      !roomIdValid(item.roomId) || item.roomId <= previous ||
      typeof item.displayName !== 'string' || !item.displayName.trim() ||
      Buffer.byteLength(item.displayName, 'utf8') > 512 ||
      typeof item.botCount !== 'number' || !Number.isSafeInteger(item.botCount) ||
      item.botCount < 0 || item.botCount > 100 ||
      typeof item.pinned !== 'boolean' || typeof item.hidden !== 'boolean')
      throw Error('invalid_bot_room_list_result')
    rooms.push({ roomId: item.roomId as HostBotRoomId, displayName: item.displayName,
      botCount: item.botCount, pinned: item.pinned, hidden: item.hidden })
    previous = item.roomId
  }
  if (value.nextCursor !== null && (rooms.length === 0 || value.nextCursor !== previous))
    throw Error('invalid_bot_room_list_result')
  return { revision: value.revision, rooms, nextCursor: value.nextCursor as HostBotRoomId | null }
}
