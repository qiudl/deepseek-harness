import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotImportInventoryRequest, parseHostBotImportInventoryPage,
  type HostBotImportInventoryRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Host-token-only committed team inventory; no browser session grants this route.
 * @param req Incoming private request.
 * @param res Outgoing private response.
 * @param token Host worker bearer token.
 * @param read Current Profile's DS Bot inventory reader.
 */
export async function handleDesktopBotImportInventoryRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotImportInventoryRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotImportInventoryRequest,
    value => parseHostBotImportInventoryPage(value),
    (page, request) => {
      try { parseHostBotImportInventoryPage(page, request); return true }
      catch { return false }
    }, 2048)
}
