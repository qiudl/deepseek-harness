import { parseHostRootJournalCommand, parseHostRootJournalMetadata, matchHostRootJournalMetadata, type HostRootJournalCommand } from '@deepseek-ai/dsh-host-control-protocol'
import type { CollaborationRootSubmission } from '@deepseek-ai/dsh-api-session-controller'
import { parseHostRootSubmissionTarget, parseHostRootSubmissionDescriptor, type HostRootSubmissionTarget } from '@deepseek-ai/dsh-host-control-protocol'
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
  return handleDesktopPrivateRead(
    req, res, token, inspect, parseTarget, parse,
    (result, target) => {
      const selected = coordinates(result)
      return selected.workspace_id === target.workspace_id && selected.session_id === target.session_id
        && selected.source_message_id === target.source_message_id && selected.source_revision === target.source_revision
    },
  )
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
