/** Bounded Source coordinates for one existing DS Bot room. */
export interface HostNativeRoomSource {
  readonly room_id: string
  readonly source: {
    readonly workspace_id: string
    readonly session_id: string
    readonly source_message_id: string
    readonly source_revision: '1'
  }
}

const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const workspace = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/**
 * Parse one caller-selected native room ID without Profile or chat coordinates.
 * @param value - Exact room target from an untrusted caller.
 * @returns Bounded room ID.
 */
export function parseHostNativeRoomTarget(value: unknown): { readonly room_id: string } {
  if (!record(value) || Object.keys(value).join(',') !== 'room_id' || !id(value.room_id))
    throw Error('native_room_target_invalid')
  return { room_id: value.room_id }
}

/**
 * Reject a room Session reused as a Slark bridge or any extra Profile fields.
 * @param value - Private Profile service reply.
 * @returns Bounded Source coordinates for the requested room.
 */
export function parseHostNativeRoomSource(value: unknown): HostNativeRoomSource {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'room_id,source' ||
    !id(value.room_id) || !record(value.source) ||
    Object.keys(value.source).sort().join(',') !==
      'session_id,source_message_id,source_revision,workspace_id' ||
    !workspace(value.source.workspace_id) || !id(value.source.session_id) ||
    value.source.session_id === value.room_id || !id(value.source.source_message_id) ||
    value.source.source_revision !== '1') throw Error('native_room_source_invalid')
  return { room_id: value.room_id, source: {
    workspace_id: value.source.workspace_id, session_id: value.source.session_id,
    source_message_id: value.source.source_message_id, source_revision: '1',
  } }
}
