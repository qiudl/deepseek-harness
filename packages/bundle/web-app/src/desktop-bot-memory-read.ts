/** Private worker-token route for one bounded logical memory chunk. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotMemoryPage, parseHostBotMemoryReadRequest,
  type HostBotMemoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/**
 * Require the worker-only token before calling the Profile-local memory reader.
 * @param req - Private Host request.
 * @param res - Noncacheable response.
 * @param token - Current worker capability.
 * @param read - Profile-local DS Bot projection.
 */
export async function handleDesktopBotMemoryReadRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotMemoryReadRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read,
    parseHostBotMemoryReadRequest, parseHostBotMemoryPage,
    (result, target) => result.logical_id === target.logical_id, 2048)
}
