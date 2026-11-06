/** Worker-token-only access to current native participation metadata. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostBoundBotRoomsQuery, parseHostBoundBotRoomsRead,
  type HostBoundBotRoomsQuery } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'
/** Read one exact page without exposing a Cloud nonce or private Host authority to the plugin.
 * @param req Private worker request.
 * @param res Noncacheable response.
 * @param token Current Profile worker token.
 * @param inspect Private plugin operation.
 * @returns Completion after response or cancellation.
 */
export function handleDesktopBoundBotRoomsRequest(req: IncomingMessage, res: ServerResponse,
  token: string, inspect: (query: HostBoundBotRoomsQuery, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, inspect, parseHostBoundBotRoomsQuery,
    parseHostBoundBotRoomsRead, (read, query) => read.state !== 'page' || read.bot_id === query.bot_id &&
      read.items.length <= query.limit && (read.next_cursor === null || read.next_cursor !== query.cursor), 32768)
}
