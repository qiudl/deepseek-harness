/** Fixed owner-only Bot group settings change and saved-state result. */
import { botRecord as row, botExactKeys as exact } from './bot-value-shape.js'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.js'
import { parseHostBotRoomDetails, type HostBotRoomDetails } from './bot-room-details.js'

/** Only one group setting changes per command. */
export type HostBotRoomUpdateChange =
  | { readonly kind: 'name' | 'notice' | 'reply-mode' | 'member-add' | 'member-remove'; readonly value: string }
  | { readonly kind: 'relay-limit'; readonly value: number | null }
  | { readonly kind: 'permission' | 'admin'; readonly value: string | null }
/** No Account/Profile selector; expectedRevision prevents silently overwriting newer team state. */
export interface HostBotRoomUpdateRequest {
  readonly roomId: HostBotRoomId
  readonly expectedRevision: number
  readonly change: HostBotRoomUpdateChange
}
/** Applied means the plugin's state save completed; stale requires a fresh read. */
export interface HostBotRoomUpdateReceipt {
  readonly roomId: HostBotRoomId
  readonly revision: number
  readonly state: 'applied' | 'stale'
  readonly details: HostBotRoomDetails | null
}
const botIdValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const textValid = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' && (!required || !!value.trim()) && Buffer.byteLength(value, 'utf8') <= max

/** Parse the exact fixed edit before any Host call.
 * @param value - Decoded untrusted command request.
 * @returns Canonical bounded edit.
 */
export function parseHostBotRoomUpdateRequest(value: unknown): HostBotRoomUpdateRequest {
  if (!row(value) || !exact(value, ['roomId', 'expectedRevision', 'change']) || !roomIdValid(value.roomId) ||
    typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
    !row(value.change) || !exact(value.change, ['kind', 'value'])) throw Error('invalid_bot_room_update')
  const { kind } = value.change, setting = value.change.value
  let change: HostBotRoomUpdateChange
  if (kind === 'name' && textValid(setting, 512, true)) change = { kind, value: setting }
  else if (kind === 'notice' && textValid(setting, 8192)) change = { kind, value: setting }
  else if (kind === 'reply-mode' && (setting === 'admin' || setting === 'everyone')) change = { kind, value: setting }
  else if (kind === 'relay-limit' && (setting === null ||
    (typeof setting === 'number' && Number.isSafeInteger(setting) && setting >= 1 && setting <= 200)))
    change = { kind, value: setting }
  else if (kind === 'permission' && (setting === null || textValid(setting, 200, true)))
    change = { kind, value: setting }
  else if (kind === 'admin' && (setting === null || botIdValid(setting))) change = { kind, value: setting }
  else if ((kind === 'member-add' || kind === 'member-remove') && botIdValid(setting))
    change = { kind, value: setting }
  else throw Error('invalid_bot_room_update')
  return { roomId: value.roomId as HostBotRoomId, expectedRevision: value.expectedRevision, change }
}

/** Validate one plugin save result against the original room and revision.
 * @param value - Untrusted plugin result.
 * @param request - Captured exact edit.
 * @returns Correlated saved-state result or absent plugin.
 */
export function parseHostBotRoomUpdateReceipt(value: unknown, request: HostBotRoomUpdateRequest): HostBotRoomUpdateReceipt | null {
  if (value === null) return null
  if (!row(value) || !exact(value, ['roomId', 'revision', 'state', 'details']) ||
    value.roomId !== request.roomId || typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) || value.revision < request.expectedRevision ||
    (value.state !== 'applied' && value.state !== 'stale') ||
    (value.state === 'stale' && value.details !== null) ||
    (value.state === 'applied' && value.revision <= request.expectedRevision))
    throw Error('invalid_bot_room_update_receipt')
  let details: HostBotRoomDetails | null = null
  if (value.state === 'applied') {
    try { details = parseHostBotRoomDetails(value.details, { roomId: request.roomId }) }
    catch { throw Error('invalid_bot_room_update_receipt') }
    if (details === null || details.revision !== value.revision) throw Error('invalid_bot_room_update_receipt')
  }
  return { roomId: request.roomId, revision: value.revision,
    state: value.state, details }
}
