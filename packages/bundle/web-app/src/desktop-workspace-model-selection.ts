/** Private worker HTTP read for the authenticated Desktop Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRead } from './desktop-private-read.ts'
import {
  parseHostWorkspaceModelSelection, parseHostWorkspaceModelSelectionTarget,
  type HostWorkspaceModelSelection, type HostWorkspaceModelSelectionTarget,
} from '@deepseek-ai/dsh-host-control-protocol'

/**
 * Read a registry-bound choice; browser cookies grant no access to this endpoint.
 * @param req - Local worker HTTP request, bounded to 2 KiB.
 * @param res - Noncacheable response; reader errors expose only unavailable.
 * @param token - Random capability owned by the parent Host and this worker.
 * @param inspect - Profile-local Session Controller reader, without activation or model dispatch.
 */
export async function handleDesktopWorkspaceModelSelectionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: HostWorkspaceModelSelectionTarget, signal: AbortSignal) => Promise<HostWorkspaceModelSelection>,
): Promise<void> {
  return handleDesktopPrivateRead(
    req, res, token, inspect, parseHostWorkspaceModelSelectionTarget, parseHostWorkspaceModelSelection,
    (result, target) => result.workspace_id === target.workspace_id && result.session_id === target.session_id,
  )
}
