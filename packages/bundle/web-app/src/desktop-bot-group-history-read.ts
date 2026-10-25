/** Private worker-token route for one committed DS Bot group journal page. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotGroupHistoryPage, parseHostBotGroupHistoryReadRequest,
  type HostBotGroupHistoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Require the worker-only token before reading a current Profile group.
 * @param req Incoming private worker request.
 * @param res Private worker response.
 * @param token Current worker token.
 * @param read Profile-local group journal reader.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopBotGroupHistoryReadRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotGroupHistoryReadRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotGroupHistoryReadRequest, parseHostBotGroupHistoryPage,
    (result, target) => result.logical_id === target.logical_id, 2048)
}
