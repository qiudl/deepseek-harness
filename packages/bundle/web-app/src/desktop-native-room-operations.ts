/** Worker-token-only native room member and message operations. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { matchesHostNativeRoomReply, parseHostNativeRoomCommand,
  parseHostNativeRoomReply, type HostNativeRoomCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Keep plugin commands behind the current Profile worker's private token.
 * @param req Incoming private HTTP request.
 * @param res HTTP response.
 * @param token Current worker token.
 * @param run Profile service operation.
 */
export async function handleDesktopNativeRoomOperationRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  run: (command: HostNativeRoomCommand, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, run,
    parseHostNativeRoomCommand, parseHostNativeRoomReply,
    matchesHostNativeRoomReply, 32768, 30_000)
}
