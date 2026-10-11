/** Private Profile worker read of a persisted collaboration archive token. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseHostCollaborationArchiveStateTarget, parseHostCollaborationArchiveStateValue,
  type HostCollaborationArchiveStateTarget, type HostCollaborationArchiveStateValue,
} from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Browser cookies cannot call this token-only endpoint.
 * @param req - Worker HTTP request.
 * @param res - Worker HTTP response.
 * @param token - Parent Host-only capability.
 * @param inspect - Current Registry phase reader.
 */
export async function handleDesktopCollaborationArchiveStateRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  inspect: (target: HostCollaborationArchiveStateTarget, signal: AbortSignal) => Promise<HostCollaborationArchiveStateValue>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, inspect,
    parseHostCollaborationArchiveStateTarget, parseHostCollaborationArchiveStateValue,
    () => true, 2048)
}
