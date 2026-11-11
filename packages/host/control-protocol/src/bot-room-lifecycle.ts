/** Fixed native Bot room lifecycle under an authenticated Profile. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'
import { parseHostBotRoomDetails, type HostBotRoomDetails } from './bot-room-details.js'
import { roomIdValid, type HostBotRoomId } from './bot-room-list.js'

/** Create is anchored to a verified Bot Session controlled by the remote client. */
export interface HostBotRoomCreateRequest {
  readonly ownerBotId: string
  readonly sessionId: string
  readonly expectedRevision: number
  readonly members: readonly string[]
  readonly name: string
  readonly notice: string
  readonly replyMode: 'admin' | 'everyone'
  readonly adminBotId: string | null
}
/** Delete is anchored to the target room Session. */
export interface HostBotRoomDeleteRequest { readonly roomId: HostBotRoomId; readonly expectedRevision: number }
/** Authoritative create or stale result. A lost reply remains uncertain. */
export interface HostBotRoomCreateReceipt {
  readonly state: 'created' | 'stale'
  readonly revision: number
  readonly details: HostBotRoomDetails | null
}
/** Authoritative deletion, stale revision, or already-missing room. */
export interface HostBotRoomDeleteReceipt {
  readonly roomId: HostBotRoomId
  readonly state: 'deleted' | 'stale' | 'missing'
  readonly revision: number
}

const botId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/u.test(value)
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') <= max
const revision = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0

/** Validate an exact create request before Session control admission.
 * @param value - Untrusted decoded request.
 * @returns Bounded create input.
 */
export function parseHostBotRoomCreateRequest(value: unknown): HostBotRoomCreateRequest {
  if (!record(value) || !exact(value, ['ownerBotId', 'sessionId', 'expectedRevision', 'members',
    'name', 'notice', 'replyMode', 'adminBotId']) || !botId(value.ownerBotId) ||
    !roomIdValid(value.sessionId) || !revision(value.expectedRevision) ||
    !Array.isArray(value.members) || value.members.length < 2 || value.members.length > 12 ||
    value.members.some(id => !botId(id)) || new Set(value.members).size !== value.members.length ||
    !bounded(value.name, 512) || value.name.length > 60 ||
    !bounded(value.notice, 8192) || value.notice.length > 2000 ||
    (value.replyMode !== 'admin' && value.replyMode !== 'everyone') ||
    (value.adminBotId !== null && (!botId(value.adminBotId) || !value.members.includes(value.adminBotId))))
    throw Error('invalid_bot_room_create')
  return { ownerBotId: value.ownerBotId, sessionId: value.sessionId,
    expectedRevision: value.expectedRevision, members: [...value.members], name: value.name,
    notice: value.notice, replyMode: value.replyMode, adminBotId: value.adminBotId }
}

/** Validate an exact delete request before room Session control admission.
 * @param value - Untrusted decoded request.
 * @returns Bounded delete input.
 */
export function parseHostBotRoomDeleteRequest(value: unknown): HostBotRoomDeleteRequest {
  if (!record(value) || !exact(value, ['roomId', 'expectedRevision']) ||
    !roomIdValid(value.roomId) || !revision(value.expectedRevision)) throw Error('invalid_bot_room_delete')
  return { roomId: value.roomId as HostBotRoomId, expectedRevision: value.expectedRevision }
}

/** Bind a plugin create result to the captured revision and saved room projection.
 * @param value - Untrusted plugin result.
 * @param request - Validated create input.
 * @returns Correlated create result or null when the plugin is unavailable.
 */
export function parseHostBotRoomCreateReceipt(value: unknown,
  request: HostBotRoomCreateRequest): HostBotRoomCreateReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['state', 'revision', 'details']) ||
    !revision(value.revision) || value.revision < request.expectedRevision ||
    (value.state !== 'created' && value.state !== 'stale')) throw Error('invalid_bot_room_create_receipt')
  if (value.state === 'stale') {
    if (value.details !== null) throw Error('invalid_bot_room_create_receipt')
    return { state: 'stale', revision: value.revision, details: null }
  }
  if (!record(value.details) || !roomIdValid(value.details.roomId) ||
    value.revision <= request.expectedRevision) throw Error('invalid_bot_room_create_receipt')
  let details: HostBotRoomDetails | null
  try { details = parseHostBotRoomDetails(value.details, { roomId: value.details.roomId as HostBotRoomId }) }
  catch { throw Error('invalid_bot_room_create_receipt') }
  if (details === null || details.revision !== value.revision ||
    details.members.length !== request.members.length ||
    details.members.some(member => !request.members.includes(member.botId)))
    throw Error('invalid_bot_room_create_receipt')
  return { state: 'created', revision: value.revision, details }
}

/** Bind a plugin delete result to the selected room and revision.
 * @param value - Untrusted plugin result.
 * @param request - Validated delete input.
 * @returns Correlated delete result or null when the plugin is unavailable.
 */
export function parseHostBotRoomDeleteReceipt(value: unknown,
  request: HostBotRoomDeleteRequest): HostBotRoomDeleteReceipt | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['roomId', 'state', 'revision']) ||
    value.roomId !== request.roomId || !revision(value.revision) ||
    (value.state !== 'deleted' && value.state !== 'stale' && value.state !== 'missing') ||
    (value.state === 'deleted' ? value.revision <= request.expectedRevision
      : value.state === 'missing' ? value.revision !== request.expectedRevision
        : value.revision < request.expectedRevision)) throw Error('invalid_bot_room_delete_receipt')
  return { roomId: request.roomId, state: value.state, revision: value.revision }
}
