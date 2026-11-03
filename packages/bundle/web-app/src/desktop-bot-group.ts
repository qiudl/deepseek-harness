/** Parent Host-only Bot group delivery and receipt bridge to the Profile plugin. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { matchesHostBotGroupResponse, parseHostBotGroupCommand,
  parseHostBotGroupResponse, type HostBotGroupCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/**
 * Accept only the current worker token and a bounded Bot group command.
 * @param req - Parent Host request.
 * @param res - Private response.
 * @param token - Current worker capability.
 * @param run - Execute a validated command in the selected Profile.
 */
export async function handleDesktopBotGroupRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  run: (command: HostBotGroupCommand, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, run,
    parseHostBotGroupCommand, parseHostBotGroupResponse,
    matchesHostBotGroupResponse, 131072, 30_000)
}
