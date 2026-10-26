import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotChatAttachmentTransferRequest, parseHostBotChatAttachmentTransferResult,
  type HostBotChatAttachmentTransferRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Private worker-token route for one bounded Bot attachment transfer action.
 * @param req Incoming private worker request.
 * @param res Private worker response.
 * @param token Current worker token.
 * @param read Profile-local transfer reader.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopBotChatAttachmentTransferRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotChatAttachmentTransferRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotChatAttachmentTransferRequest,
    value => parseHostBotChatAttachmentTransferResult(value),
    (result, target) => {
      try { parseHostBotChatAttachmentTransferResult(result, target); return true }
      catch { return false }
    }, 2048, 30_000)
}
