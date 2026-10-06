/** Private worker HTTP read for the authenticated Desktop Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRead } from './desktop-private-read.ts'
import { describeCollaborationSource, parseCollaborationSourceSnapshot } from '@deepseek-ai/dsh-api-session-controller'
import {
  parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceTarget, parseHostCollaborationSourceSnapshot,
  type HostCollaborationSourceTarget,
} from '@deepseek-ai/dsh-host-control-protocol'

/**
 * Read a persisted Source descriptor; browser cookies grant no access to this endpoint.
 * @param req - Local worker HTTP request, bounded to 2 KiB.
 * @param res - Noncacheable response; reader errors expose only unavailable.
 * @param token - Random capability owned by the parent Host and this worker.
 * @param inspect - Profile-local Session Controller journal reader, without activation or model preparation.
 */
export async function handleDesktopCollaborationSourceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: HostCollaborationSourceTarget, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handle(req,res,token,inspect,parseHostCollaborationSourceDescriptor,result=>result)
}
/**
 * Return original journal content only to its authenticated parent Host.
 * @param req - Exact original coordinates, bounded to 2 KiB.
 * @param res - Noncacheable response containing at most 1 MiB of Source JSON.
 * @param token - Worker-only Source capability; browser cookies do not grant access.
 * @param read - Profile-local reader with current Session ownership checks.
 */
export async function handleDesktopCollaborationSourceSnapshotRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  read: (target: HostCollaborationSourceTarget, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handle(
    req,
    res,
    token,
    read,
    (value) => {
      const snapshot = parseCollaborationSourceSnapshot(value)
      return parseHostCollaborationSourceSnapshot({
        descriptor: describeCollaborationSource(snapshot),
        snapshot_json: JSON.stringify(snapshot),
      })
    },
    result => result.descriptor,
  )
}
async function handle<T>(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: HostCollaborationSourceTarget, signal: AbortSignal) => Promise<unknown>,
  parse: (value: unknown) => T,
  coordinates: (value: T) => HostCollaborationSourceTarget,
): Promise<void> {
  return handleDesktopPrivateRead(
    req, res, token, inspect, parseHostCollaborationSourceTarget, parse,
    (result, target) => {
      const selected = coordinates(result)
      return selected.workspace_id === target.workspace_id && selected.session_id === target.session_id
        && selected.source_message_id === target.source_message_id && selected.source_revision === target.source_revision
    },
  )
}
