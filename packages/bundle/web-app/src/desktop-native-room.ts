/** Worker-token-only preparation of a DS Bot room's Slark bridge Source. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const workspace = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Parse one native room identity; browser cookies cannot call this route. */
export function parseDesktopNativeRoomTarget(value: unknown): { room_id: string } {
  if (!record(value) || Object.keys(value).join(',') !== 'room_id' || !id(value.room_id))
    throw Error('native_room_target_invalid')
  return { room_id: value.room_id }
}

/** Require a bridge Source in the same Profile workspace and a different Session. */
export function parseDesktopNativeRoomSource(value: unknown): {
  room_id: string
  source: { workspace_id: string; session_id: string; source_message_id: string; source_revision: '1' }
} {
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

/** Admit only the current Desktop worker token before invoking the Profile plugin. */
export async function handleDesktopNativeRoomRequest(req: IncomingMessage, res: ServerResponse,
  token: string, prepare: (roomId: string, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => prepare(target.room_id, signal), parseDesktopNativeRoomTarget,
    parseDesktopNativeRoomSource, (result, target) => result.room_id === target.room_id,
    2048, 30_000)
}
