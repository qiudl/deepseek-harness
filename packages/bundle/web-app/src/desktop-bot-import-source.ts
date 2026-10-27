import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBotImportSourceRequest, parseHostBotImportSourceResult,
  type HostBotImportSourceRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Worker-token-only Session transfer; no browser or Account capability is registered.
 * @param req Private worker request.
 * @param res Private worker response.
 * @param token Current worker token.
 * @param read Profile-local transfer reader.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopBotImportSourceRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  read: (request: HostBotImportSourceRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  let target: HostBotImportSourceRequest | undefined
  return handleDesktopPrivateRequest(req, res, token, read,
    (value) => { target = parseHostBotImportSourceRequest(value); return target },
    (value) => {
      if (!target) throw Error('invalid_bot_import_source_request')
      return parseHostBotImportSourceResult(value, target)
    },
    () => true, 2048, 30_000)
}
