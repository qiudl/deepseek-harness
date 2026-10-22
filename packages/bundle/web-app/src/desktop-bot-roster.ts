/** Private, Account Profile local Bot roster for the Desktop Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotRosterPage, parseHostBotRosterTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotRosterPage } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

export async function handleDesktopBotRosterRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  list: (afterBotId: string, limit: number, signal: AbortSignal) => Promise<HostBotRosterPage | null>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token,
    (target, signal) => list(target.after_bot_id, target.limit, signal),
    parseHostBotRosterTarget, parseHostBotRosterPage,
    (page, target) => page === null ||
      (page.bots.length <= target.limit && page.bots.every(bot => bot.bot_id > target.after_bot_id)), 2048)
}
