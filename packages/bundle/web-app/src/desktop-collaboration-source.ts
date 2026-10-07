import { parseHostRootJournalCommand, parseHostRootJournalMetadata, matchHostRootJournalMetadata, type HostRootJournalCommand } from '@deepseek-ai/dsh-host-control-protocol'
import type { CollaborationRootSubmission } from '@deepseek-ai/dsh-api-session-controller'
import { parseHostRootSubmissionTarget, parseHostRootSubmissionDescriptor, type HostRootSubmissionTarget } from '@deepseek-ai/dsh-host-control-protocol'
/** Private worker HTTP read for the authenticated Desktop Host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'
import { describeCollaborationSource, parseCollaborationSourceSnapshot,
  parseCollaborationReferenceSelection, parseCollaborationReferenceMetadata, collaborationJournalDigest } from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationReferenceSelection, CollaborationReferenceRecord } from '@deepseek-ai/dsh-api-session-controller'
import {
  parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceTarget, parseHostCollaborationSourceSnapshot,
  type HostCollaborationSourceTarget,
  parseHostCollaborationReferenceTarget, parseHostCollaborationReferenceGrant, type HostCollaborationReferenceTarget,
  parseHostCollaborationReferenceContentTarget, parseHostCollaborationReferenceContentChunk,
  type HostCollaborationReferenceContentTarget,
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
  return handle(req,res,token,inspect,parseHostCollaborationSourceDescriptor,result=>result,parseHostCollaborationSourceTarget)
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
    parseHostCollaborationSourceTarget,
  )
}
async function handle<T, Target extends HostCollaborationSourceTarget>(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  inspect: (target: Target, signal: AbortSignal) => Promise<unknown>,
  parse: (value: unknown) => T,
  coordinates: (value: T) => HostCollaborationSourceTarget,
  parseTarget: (value: unknown) => Target,
): Promise<void> {
  return handleDesktopPrivateRequest(
    req, res, token, inspect, parseTarget, parse,
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
          : selection.range.unit === 'quote'
            ? request.range.unit === 'utf16' && request.range.end - request.range.start === selection.range.text.length
              && request.byte_length === Buffer.byteLength(selection.range.text)
              && request.content_digest === createHash('sha256').update(selection.range.text).digest('hex')
            : collaborationJournalDigest(request.range) === collaborationJournalDigest(selection.range))
    }, 32768)
}

/**
 * Read one chunk from an independently captured and currently revalidated reference.
 * @param req - Source, reservation digest and offset only, bounded to 2 KiB.
 * @param res - Noncacheable response with at most 32 KiB of selected bytes.
 * @param token - Separate Reference capability; Source tokens and browser cookies grant no access.
 * @param read - Original Profile reader that rechecks membership and actual selected content.
 */
export async function handleDesktopCollaborationReferenceContentRequest(req: IncomingMessage, res: ServerResponse, token: string,
  read: (target: HostCollaborationReferenceContentTarget, signal: AbortSignal) => Promise<CollaborationReferenceRecord>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, async (target, signal) => {
    const record = await read(target, signal), bytes = Buffer.from(record.content_base64, 'base64')
    return { descriptor: record.descriptor, reference_request_digest: record.reference_request_digest,
      content_digest: record.request.content_digest, offset: target.offset, total_bytes: bytes.byteLength,
      chunk_base64url: bytes.subarray(target.offset, target.offset + 32768).toString('base64url') }
  }, parseHostCollaborationReferenceContentTarget, parseHostCollaborationReferenceContentChunk,
  (result, target) => result.descriptor.workspace_id === target.workspace_id && result.descriptor.session_id === target.session_id
    && result.descriptor.source_message_id === target.source_message_id && result.descriptor.source_revision === target.source_revision
    && result.reference_request_digest === target.reference_request_digest && result.offset === target.offset, 2048)
}

/**
 * Read root metadata through the private worker capability; no browser or model access.
 * @param req - Exact original namespace, command and Source coordinates within 2 KiB.
 * @param res - Noncacheable metadata only; errors omit private details.
 * @param token - Parent-owned random Source-read capability.
 * @param inspect - Profile journal reader with current membership checks.
 */
export async function handleDesktopCollaborationRootRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  inspect: (target: HostRootSubmissionTarget, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  return handle(req, res, token, async (target, signal) => {
    const result = parseHostRootSubmissionDescriptor(await inspect(target, signal))
    if (result.namespace_id !== target.namespace_id || result.command_id !== target.command_id) throw Error('mismatch')
    return result
  }, parseHostRootSubmissionDescriptor, result => result.source_descriptor, parseHostRootSubmissionTarget)
}

/** Read or acknowledge a root through the parent write capability, never browser cookies.
 * @param req - Exact read/accept command bounded to 2 KiB.
 * @param res - Bounded metadata, without Source content or executable handles.
 * @param token - Parent-owned analysis/write capability, distinct from Source reads.
 * @param execute - Profile-local journal access with current Session membership checks.
 */
export async function handleDesktopRootJournalRequest(
  req: IncomingMessage, res: ServerResponse, token: string,
  execute: (command: HostRootJournalCommand, signal: AbortSignal) => Promise<CollaborationRootSubmission>,
): Promise<void> {
  return handle(req, res, token, async ({ command }: HostRootSubmissionTarget & { command: HostRootJournalCommand }, signal) => {
    const entry = await execute(command, signal)
    const { source, ...metadata } = entry
    return matchHostRootJournalMetadata({ ...metadata, source_descriptor: describeCollaborationSource(source) }, command)
  }, parseHostRootJournalMetadata, value => value.source_descriptor, (value) => {
    const command = parseHostRootJournalCommand(value)
    return { ...command.target, command }
  })
}
