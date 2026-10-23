/** Parent Host-only durable group input fence installation. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostGroupInputFenceChallenge, parseHostGroupInputFenceValue,
  type HostGroupInputFenceChallenge, type HostGroupInputFenceValue,
} from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Install one exact durable original Session fence through the parent-only route.
 * @param req - Private Host request.
 * @param res - Bounded worker response.
 * @param token - Parent-only worker token.
 * @param install - Registry's durable installation callback.
 * @returns Completion after the response is sent.
 */
export async function handleDesktopGroupInputFenceRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  install: (challenge: HostGroupInputFenceChallenge, signal: AbortSignal) => Promise<HostGroupInputFenceValue>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, install,
    parseHostGroupInputFenceChallenge, parseHostGroupInputFenceValue,
    (value, challenge) => value.workspace_id === challenge.workspace_id
      && value.session_id === challenge.session_id && value.group_id === challenge.group_id
      && value.group_version === challenge.group_version, 2048)
}
