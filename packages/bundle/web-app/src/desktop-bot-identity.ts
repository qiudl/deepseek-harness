/** Private Bot identity read for the authenticated parent Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotIdentity, parseHostBotIdentityTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/**
 * Read only an exact Bot ID from the current Profile's exclusive-writer plugin.
 * @param req - Parent Host request with the private worker token.
 * @param res - Noncacheable identity response.
 * @param token - Parent and worker secret, excluded from browser routes.
 * @param resolve - Profile-local Bot plugin reader.
 * @returns When the bounded response is sent.
 */
export async function handleDesktopBotIdentityRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  resolve: (botId: string, signal: AbortSignal) => Promise<HostBotIdentity | null>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => resolve(target.bot_id, signal),
    parseHostBotIdentityTarget, parseHostBotIdentity,
    (identity, target) => identity === null || identity.bot_id === target.bot_id, 2048)
}
