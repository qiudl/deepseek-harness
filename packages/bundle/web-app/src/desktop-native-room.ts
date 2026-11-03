/** Worker-token-only preparation of a DS Bot room's Slark bridge Source. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostNativeRoomSource, parseHostNativeRoomTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/**
 * Admit only the current Desktop worker token before invoking the Profile plugin.
 * @param req - Private Host request with one room ID.
 * @param res - Noncacheable response.
 * @param token - Current Profile worker token.
 * @param prepare - Profile plugin operation for the exact room.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopNativeRoomRequest(req: IncomingMessage, res: ServerResponse,
  token: string, prepare: (roomId: string, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => prepare(target.room_id, signal), parseHostNativeRoomTarget,
    value => value === null ? null : parseHostNativeRoomSource(value),
    (result, target) => result === null || result.room_id === target.room_id,
    2048, 30_000)
}
