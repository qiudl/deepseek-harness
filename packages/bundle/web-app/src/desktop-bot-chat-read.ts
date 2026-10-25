/** Private worker-token route for one text-only DS Bot chat page. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotChatPage, parseHostBotChatReadRequest,
  type HostBotChatReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

export async function handleDesktopBotChatReadRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotChatReadRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotChatReadRequest, parseHostBotChatPage,
    (result, target) => result.logical_id === target.logical_id && result.part === target.part, 2048)
}
