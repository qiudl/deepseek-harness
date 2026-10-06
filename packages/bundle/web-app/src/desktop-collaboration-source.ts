/** Private worker HTTP read for the authenticated Desktop Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'
import { describeCollaborationSource, parseCollaborationSourceSnapshot,
  parseCollaborationReferenceSelection, parseCollaborationReferenceMetadata, collaborationJournalDigest } from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationReferenceSelection } from '@deepseek-ai/dsh-api-session-controller'
import {
  parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceTarget, parseHostCollaborationSourceSnapshot,
  type HostCollaborationSourceTarget,
  parseHostCollaborationReferenceTarget, parseHostCollaborationReferenceGrant, type HostCollaborationReferenceTarget,
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
  return handleDesktopPrivateRequest(
    req, res, token, inspect, parseHostCollaborationSourceTarget, parse,
    (result, target) => {
      const selected = coordinates(result)
      return selected.workspace_id === target.workspace_id && selected.session_id === target.session_id
        && selected.source_message_id === target.source_message_id && selected.source_revision === target.source_revision
    },
    2048,
  )
}

/**
 * Read one separately committed Profile reference grant; caller content and cookies grant no access.
 * @param req - Parent request with exact Source coordinates and full reservation digest, bounded to 2 KiB.
 * @param res - Noncacheable grant metadata, without content, paths, credentials or reader error details.
 * @param token - Private Source capability owned by the Parent Host and this worker.
 * @param read - Current Profile's independent selection reader, without capture or model preparation.
 */
export async function handleDesktopCollaborationReferenceGrantRequest(req: IncomingMessage, res: ServerResponse, token: string,
  read: (target: HostCollaborationReferenceTarget, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, read, parseHostCollaborationReferenceTarget, parseHostCollaborationReferenceGrant,
    (result, target) => result.workspace_id === target.workspace_id && result.session_id === target.session_id
      && result.source_message_id === target.source_message_id && result.source_revision === target.source_revision
      && result.reference_request_digest === target.reference_request_digest, 2048)
}

/**
 * Capture already authorized selected content through a separate private write capability.
 * @param req - Locator/range/recipient selection, at most 32 KiB; caller body or digest overrides refuse.
 * @param res - Noncacheable computed metadata only; selected bytes and error details are omitted.
 * @param token - Independent Reference capability; Source-read and browser cookies grant no access.
 * @param capture - Owning Profile producer after the trusted coordinator established explicit user sharing intent.
 */
export async function handleDesktopCollaborationReferenceCaptureRequest(req: IncomingMessage, res: ServerResponse, token: string,
  capture: (selection: CollaborationReferenceSelection, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, capture, parseCollaborationReferenceSelection, parseCollaborationReferenceMetadata,
    (result, selection) => {
      const request = result.request, source = request.source, expected = selection.source
      return source.workspace_id === expected.workspace_id && source.session_id === expected.session_id
        && source.source_message_id === expected.source_message_id && source.revision === expected.revision
        && request.reference_request_id === selection.reference_request_id && request.source_kind === selection.source_kind
        && request.source_locator === selection.source_locator && request.source_version === selection.source_version
        && collaborationJournalDigest(request.recipient_mention_ids) === collaborationJournalDigest(selection.recipient_mention_ids)
        && collaborationJournalDigest(request.source_evidence_spans) === collaborationJournalDigest(selection.source_evidence_spans)
        && (selection.range.unit === 'whole'
          ? request.range.start === 0 && request.range.unit === (selection.source_kind === 'message' ? 'utf16' : 'byte')
          : collaborationJournalDigest(request.range) === collaborationJournalDigest(selection.range))
    }, 32768)
}
