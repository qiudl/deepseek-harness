/** Parent Host-only, current Profile Bot roster read. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotTeamPage, parseHostBotTeamReadRequest,
  type HostBotTeamReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/**
 * Accept only a private worker token and return one validated team directory page.
 * @param req - Parent Host request; browser cookies grant no access.
 * @param res - Noncacheable private response.
 * @param token - Current worker capability retained by the parent Host.
 * @param read - Current Profile plugin reader.
 */
export async function handleDesktopBotTeamReadRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotTeamReadRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotTeamReadRequest, parseHostBotTeamPage, () => true, 2048)
}
