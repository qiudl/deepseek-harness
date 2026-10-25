import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotChatAttachmentsPage, parseHostBotChatAttachmentsReadRequest,
  type HostBotChatAttachmentsReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Private worker-token route for one visible Bot chat attachment manifest page.
 * @param req Incoming private worker request.
 * @param res Private worker response.
 * @param token Current worker token.
 * @param read Profile-local manifest reader.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopBotChatAttachmentsReadRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotChatAttachmentsReadRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotChatAttachmentsReadRequest, parseHostBotChatAttachmentsPage,
    (result, target) => result.logical_id === target.logical_id && result.part === target.part, 2048)
}
