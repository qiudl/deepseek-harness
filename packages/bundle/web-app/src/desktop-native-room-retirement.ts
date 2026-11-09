/** Worker-token-only retirement of one complete original native member cycle. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostNativeRoomRetirementCommand, parseHostNativeRoomRetirementReply,
  type HostNativeRoomRetirementCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'
/** Close the original member cycle only through its private current Profile service.
 * @param req Parent Host request.
 * @param res Noncacheable response.
 * @param token Current Profile worker capability.
 * @param retire Private plugin operation retaining original identity.
 * @returns Completion after response or cancellation.
 */
export function handleDesktopNativeRoomRetirementRequest(req: IncomingMessage, res: ServerResponse,
  token: string, retire: (command: HostNativeRoomRetirementCommand, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, retire, parseHostNativeRoomRetirementCommand,
    parseHostNativeRoomRetirementReply, () => true, 32768, 30_000, true)
}
