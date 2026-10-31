/** REQ-20261004-0008: root-bound Host proof; old Source signatures confer no root authority. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import {
  parseHostRemoteSessionJson, parseHostSourceAuthorityChallenge, parseHostSourceAuthorityAssertion,
  parseHostCollaborationSourceTarget, parseHostCollaborationSourceDescriptor,
} from './codec.ts'
import type { HostRemoteSessionJson, HostSourceAuthorityChallenge, HostSourceAuthorityAssertion, HostCollaborationSourceTarget, HostCollaborationSourceDescriptor } from './types.ts'
/** Logical root identity at the Host wire boundary. */
export type HostRootTaskId = Branded<'HostRootTaskId'>
/** Stable trace identity shared by every replay of a root. */
export type HostRootTraceId = Branded<'HostRootTraceId'>
/** Durable business command, distinct from a transport request ID. */
export type HostRootCommandId = Branded<'HostRootCommandId'>
/** Server challenge binding one durable root to its source and registered Host epoch. */
export type HostRootAuthorityChallenge = Readonly<{
  schema_version: 1
  source_challenge: HostSourceAuthorityChallenge
  namespace_id: string
  root_task_id: HostRootTaskId
  root_trace_id: HostRootTraceId
  command_id: HostRootCommandId
  payload_digest: string
}>
/** Installation-signed root proof; execution permission remains separate. */
export type HostRootAuthorityAssertion = Omit<HostSourceAuthorityAssertion, 'challenge'> &
  Readonly<{ challenge: HostRootAuthorityChallenge }>
const keys = ['schema_version', 'source_challenge', 'namespace_id', 'root_task_id', 'root_trace_id', 'command_id', 'payload_digest'] as const
const assertionKeys = ['schema_version', 'challenge', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce', 'signature'] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length)
    throw Error('invalid_root_authority')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).length !== names.length || names.some((k) => {
    const descriptor = descriptors[k]
    return !descriptor || !descriptor.enumerable || !('value' in descriptor)
  }))
    throw Error('invalid_root_authority')
  return value as Record<string, unknown>
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw Error('invalid_root_authority')
  return value
}
/** Parse exact wire fields; issuance, current authorization and durable-root matching are separate checks.
 * @param value - Untrusted challenge JSON.
 * @returns Detached frozen challenge without granting authority.
 */
export function parseHostRootAuthorityChallenge(value: unknown): HostRootAuthorityChallenge {
  const r = record(value, keys)
  if (r.schema_version !== 1) throw Error('invalid_root_authority')
  return Object.freeze({ schema_version: 1, source_challenge: parseHostSourceAuthorityChallenge(r.source_challenge),
    namespace_id: text(r.namespace_id, /^n2_[0-9a-f]{64}$/u), root_task_id: brandString<HostRootTaskId>(text(r.root_task_id, uuid)),
    root_trace_id: brandString<HostRootTraceId>(text(r.root_trace_id, /^(?!0{32}$)[0-9a-f]{32}$/u)),
    command_id: brandString<HostRootCommandId>(text(r.command_id, uuid)),
    payload_digest: text(r.payload_digest, /^[0-9a-f]{64}$/u) })
}
/** Parsing does not verify the signature or grant execution authority.
 * @param value - Untrusted signed assertion JSON.
 * @returns Detached frozen assertion.
 */
export function parseHostRootAuthorityAssertion(value: unknown): HostRootAuthorityAssertion {
  const r = record(value, assertionKeys), challenge = parseHostRootAuthorityChallenge(r.challenge)
  const source = parseHostSourceAuthorityAssertion({ ...r, challenge: challenge.source_challenge })
  return Object.freeze({ ...source, challenge })
}
/** New domain and fixed-order UTF-8 tuple. Transport nonce/epoch may change without replacing the persisted command.
 * @param value - Validated assertion; signature excluded from encoded bytes.
 * @returns Ed25519 signing bytes with the root-specific domain.
 */
export function encodeHostRootAuthorityPayload(value: HostRootAuthorityAssertion): Buffer {
  const r = parseHostRootAuthorityAssertion(value), c = r.challenge, s = c.source_challenge
  return Buffer.from('dsh-collaboration-root-authority/v1\0' + JSON.stringify([
    1, s.request_id, s.challenge_nonce, s.expires_at, s.audience, s.environment_id, s.account_issuer, s.account_subject,
    s.workspace_id, s.session_id, s.source_message_id, s.source_revision, s.snapshot_digest, s.host_epoch,
    c.namespace_id, c.root_task_id, c.root_trace_id, c.command_id, c.payload_digest,
    r.installation_id, r.installation_public_key, r.host_instance_id, r.process_nonce,
  ]), 'utf8')
}

/** Private root lookup retains original Source coordinates for worker ownership checks. */
export type HostRootSubmissionTarget = HostCollaborationSourceTarget & Readonly<{ namespace_id: string; command_id: HostRootCommandId }>
/** Metadata read from a committed root journal, without Source content or credentials. */
export type HostRootSubmissionDescriptor = Readonly<{
  namespace_id: string
  command_id: HostRootCommandId
  root_task_id: HostRootTaskId
  root_trace_id: HostRootTraceId
  payload_digest: string
  source_descriptor: HostCollaborationSourceDescriptor
}>
/**
 * Validate a private worker lookup without accepting proposed root values.
 * @param value - Exact namespace, command and original Source coordinates.
 * @returns Detached validated lookup.
 */
export function parseHostRootSubmissionTarget(value: unknown): HostRootSubmissionTarget {
  const r = record(value, ['namespace_id', 'command_id', 'workspace_id', 'session_id', 'source_message_id', 'source_revision'])
  const { namespace_id, command_id, ...source } = r
  return Object.freeze({ ...parseHostCollaborationSourceTarget(source), namespace_id: text(namespace_id, /^n2_[0-9a-f]{64}$/u),
    command_id: brandString<HostRootCommandId>(text(command_id, uuid)) })
}
/**
 * Validate durable root metadata returned by an authenticated worker.
 * @param value - Exact descriptor without message or credentials.
 * @returns Detached frozen descriptor; transport authenticity remains the caller's responsibility.
 */
export function parseHostRootSubmissionDescriptor(value: unknown): HostRootSubmissionDescriptor {
  const r = record(value, ['namespace_id', 'command_id', 'root_task_id', 'root_trace_id', 'payload_digest', 'source_descriptor'])
  return Object.freeze({ namespace_id: text(r.namespace_id, /^n2_[0-9a-f]{64}$/u),
    command_id: brandString<HostRootCommandId>(text(r.command_id, uuid)),
    root_task_id: brandString<HostRootTaskId>(text(r.root_task_id, uuid)),
    root_trace_id: brandString<HostRootTraceId>(text(r.root_trace_id, /^(?!0{32}$)[0-9a-f]{32}$/u)),
    payload_digest: text(r.payload_digest, /^[0-9a-f]{64}$/u),
    source_descriptor: parseHostCollaborationSourceDescriptor(r.source_descriptor) })
}

/** Original admission fact; this receipt grants no current execution permission. */
export type HostRootAdmissionReceipt = Readonly<{
  root_task_id: HostRootTaskId
  root_trace_id: HostRootTraceId
  admission_id: HostRootCommandId
  task_revision: 1
  state_version: number
  state: 'active' | 'waiting_input' | 'waiting_host' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled'
}>
/** Private journal operations cannot create or replace a root. */
export type HostRootJournalCommand = Readonly<{ action: 'read'; target: HostRootSubmissionTarget }>
  | Readonly<{ action: 'accept'; target: HostRootSubmissionTarget; receipt: HostRootAdmissionReceipt }>
/** Bounded journal metadata; Source content travels through the existing chunked reader. */
export type HostRootJournalMetadata = HostRootSubmissionDescriptor & Readonly<{
  schema_version: 1
  source_digest: string
  objective_ref: string
  task_grant_ref: string
  continuation_policy: 'display_only' | 'follow_authorized_plan'
}> & (Readonly<{ state: 'pending' }> | Readonly<{ state: 'admitted'; receipt: HostRootAdmissionReceipt }>)
/** Validate exact admission fields without treating them as a cloud authorization.
 * @param value - Untrusted receipt JSON.
 * @returns Detached receipt; callers must compare the original persisted root.
 */
export function parseHostRootAdmissionReceipt(value: unknown): HostRootAdmissionReceipt {
  const r = record(value, ['root_task_id', 'root_trace_id', 'admission_id', 'task_revision', 'state_version', 'state'])
  if (r.task_revision !== 1 || !Number.isSafeInteger(r.state_version) || (r.state_version as number) < 1
    || !['active', 'waiting_input', 'waiting_host', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(r.state as string)) throw Error('invalid_root_authority')
  return Object.freeze({ root_task_id: brandString<HostRootTaskId>(text(r.root_task_id, uuid)),
    root_trace_id: brandString<HostRootTraceId>(text(r.root_trace_id, /^(?!0{32}$)[0-9a-f]{32}$/u)),
    admission_id: brandString<HostRootCommandId>(text(r.admission_id, uuid)), task_revision: 1,
    state_version: r.state_version as number, state: r.state as HostRootAdmissionReceipt['state'] })
}
/** Parse an original-root lookup or admission acknowledgement.
 * @param value - Private Main command with exact fields.
 * @returns Detached command with no proposed Source content.
 */
export function parseHostRootJournalCommand(value: unknown): HostRootJournalCommand {
  const action: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'action')?.value : undefined
  const r = record(value, action === 'accept' ? ['action', 'target', 'receipt'] : ['action', 'target'])
  const target = parseHostRootSubmissionTarget(r.target)
  if (action === 'read') return Object.freeze({ action, target })
  if (action !== 'accept') throw Error('invalid_root_authority')
  const receipt = parseHostRootAdmissionReceipt(r.receipt)
  if (receipt.admission_id !== target.command_id) throw Error('invalid_root_authority')
  return Object.freeze({ action, target, receipt })
}
/** Parse bounded journal metadata and match admitted receipts to their original root.
 * @param value - Worker metadata; no Source content is accepted in this frame.
 * @returns Frozen metadata; Main verifies business hashes after reading Source content.
 */
export function parseHostRootJournalMetadata(value: unknown): HostRootJournalMetadata {
  const state: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'state')?.value : undefined
  const keys = ['schema_version','namespace_id','command_id','root_task_id','root_trace_id','payload_digest','source_descriptor','source_digest','objective_ref','task_grant_ref','continuation_policy','state']
  const r = record(value, state === 'admitted' ? [...keys,'receipt'] : keys)
  const descriptor = parseHostRootSubmissionDescriptor(Object.fromEntries(['namespace_id','command_id','root_task_id','root_trace_id','payload_digest','source_descriptor'].map(k=>[k,r[k]])))
  if (r.schema_version !== 1 || (state !== 'pending' && state !== 'admitted') || r.source_digest !== descriptor.source_descriptor.snapshot_digest
    || (r.continuation_policy !== 'display_only' && r.continuation_policy !== 'follow_authorized_plan')) throw Error('invalid_root_authority')
  const base = { ...descriptor, schema_version: 1 as const, source_digest: descriptor.source_descriptor.snapshot_digest,
    objective_ref: text(r.objective_ref, /^[!-~]{1,256}$/u), task_grant_ref: text(r.task_grant_ref, /^[!-~]{1,256}$/u),
    continuation_policy: r.continuation_policy } as const
  if (state === 'pending') return Object.freeze({ ...base,state })
  const receipt = parseHostRootAdmissionReceipt(r.receipt)
  if (receipt.root_task_id !== base.root_task_id || receipt.root_trace_id !== base.root_trace_id || receipt.admission_id !== base.command_id) throw Error('invalid_root_authority')
  return Object.freeze({ ...base,state,receipt })
}
/** Validate an operation's reply against its original journal lookup and receipt.
 * @param value - Untrusted metadata returned by the worker or Host.
 * @param command - Parsed original command.
 * @returns Matched metadata; an accept must return the exact committed receipt.
 */
export function matchHostRootJournalMetadata(value: unknown, command: HostRootJournalCommand): HostRootJournalMetadata {
  const result = parseHostRootJournalMetadata(value), t = command.target, d = result.source_descriptor
  if (result.namespace_id !== t.namespace_id || result.command_id !== t.command_id || d.workspace_id !== t.workspace_id
    || d.session_id !== t.session_id || d.source_message_id !== t.source_message_id || d.source_revision !== t.source_revision
    || (command.action === 'accept' && (result.state !== 'admitted' || JSON.stringify(result.receipt) !== JSON.stringify(command.receipt)))) throw Error('invalid_root_authority')
  return result
}

/** Trusted Main root-capture selection; IDs and full Source are generated by the Profile. */
export type HostRootAnalysisInput = Readonly<{
  namespace_id: string
  continuation_policy: 'display_only' | 'follow_authorized_plan'
  source: HostRemoteSessionJson
}>
/** Validate a root preparation request without accepting proposed root IDs or grants.
 * @param value - Main-selected namespace/policy and original Source input.
 * @returns Detached bounded input; the Profile validates Source membership and content.
 */
export function parseHostRootAnalysisInput(value: unknown): HostRootAnalysisInput {
  const r = record(value, ['namespace_id', 'continuation_policy', 'source'])
  if (r.continuation_policy !== 'display_only' && r.continuation_policy !== 'follow_authorized_plan') throw Error('invalid_root_authority')
  const source = parseHostRemoteSessionJson(r.source)
  if (Buffer.byteLength(JSON.stringify(source), 'utf8') > 32768) throw Error('invalid_root_authority')
  return Object.freeze({ namespace_id: text(r.namespace_id, /^n2_[0-9a-f]{64}$/u), continuation_policy: r.continuation_policy, source })
}
