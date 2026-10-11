/** Parent Host-only recovery read of an original Registry archive token. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostCollaborationArchiveIntentTarget, parseHostCollaborationArchiveIntentValue,
  type HostCollaborationArchiveIntentTarget, type HostCollaborationArchiveIntentValue,
} from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** Resolve one exact Session without browser credentials.
 * @param req - Parent Host request.
 * @param res - Noncacheable worker response.
 * @param token - Parent Host-only capability.
 * @param inspect - Registry queue read for the current Account Profile.
 */
export async function handleDesktopCollaborationArchiveIntentRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  inspect: (target: HostCollaborationArchiveIntentTarget, signal: AbortSignal) => Promise<HostCollaborationArchiveIntentValue>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, inspect,
    parseHostCollaborationArchiveIntentTarget, parseHostCollaborationArchiveIntentValue, () => true, 2048)
}
