/** Private Profile worker write of a bound collaboration archive phase. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseHostCollaborationArchiveTransitionTarget, parseHostCollaborationArchiveTransitionResult,
  type HostCollaborationArchiveTransitionTarget, type HostCollaborationArchiveTransitionResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

/** The separate parent Host token is never issued to a browser view.
 * @param req - Worker HTTP request.
 * @param res - Worker HTTP response.
 * @param token - Parent Host-only mutation capability.
 * @param transition - Registry's serialized durable mutation.
 */
export async function handleDesktopCollaborationArchiveTransitionRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  transition: (input: HostCollaborationArchiveTransitionTarget, signal: AbortSignal) => Promise<HostCollaborationArchiveTransitionResult>,
): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, transition,
    parseHostCollaborationArchiveTransitionTarget, parseHostCollaborationArchiveTransitionResult, (value, input) =>
      input.action === 'stage'
        ? value.archive_phase !== 'released'
        : value.archive_phase === ({ prepared: 'prepared', archive: 'archived',
          restore: 'restored', finish_release: 'released' } as const)[input.action], 2048)
}
