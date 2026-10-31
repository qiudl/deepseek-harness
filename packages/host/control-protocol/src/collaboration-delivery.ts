/** Bounded private delivery transport; durable storage stays in the original Profile. */
import { createHash } from 'node:crypto'
import { HostControlProtocolError, parseHostCollaborationSourceTarget } from './codec.ts'
import type { HostCollaborationSourceTarget } from './types.ts'

/** One sequential fragment of a complete delivery capsule. */
export type HostCollaborationDeliveryChunk = Readonly<{
  upload_id: string
  offset: number
  total_bytes: number
  payload_digest: string
  chunk_base64url: string
}>
/** Complete validated reply sent only from the parent Host to the selected Profile worker. */
export type HostCollaborationDeliveryCapsule = Readonly<{
  namespace_id: string
  projection: Readonly<{
    delivery_id: string
    invocation_id: string
    plan_id: string
    task_id: string
    task_revision: string
    source_locator: HostCollaborationSourceTarget
    source_snapshot_digest: string
    execution_state: 'succeeded' | 'failed' | 'revoked' | 'cancelled' | 'indeterminate'
    invocation_state_version: string
    result_digest: string
    target: Readonly<{ project_id: string; agent_id: string }>
    target_display_snapshot: Readonly<{ agent_name: string; project_name: string }>
    answer?: string
    failure_code?: string
    delivery_state: 'pending' | 'delivered' | 'failed'
    delivery_state_version: string
  }>
}>
/** Profile commit coordinates; the complete answer is deliberately absent from this response. */
export type HostCollaborationDeliveryCommit = Readonly<{
  namespace_id: string
  delivery_id: string
  invocation_id: string
  source_locator: HostCollaborationSourceTarget
  source_snapshot_digest: string
  result_digest: string
  host_journal_commit: Readonly<{ journal_id: string; commit_version: '1'; content_digest: string }>
}>
/** Installation-signed evidence of one durable reply in the authorized original Profile. */
export type HostCollaborationDeliveryReceipt = Readonly<{
  schema_version: 1
  authority_environment_id: string
  account_binding_handle: string
  authority_binding_version: number
  account_issuer: string
  account_subject: string
  installation_id: string
  installation_public_key: string
  host_instance_id: string
  process_nonce: string
  commit: HostCollaborationDeliveryCommit
  signature: string
}>
/** Sequential upload progress, or the installation-signed first durable commit. */
export type HostCollaborationDeliveryResult =
  | Readonly<{ kind: 'staged'; upload_id: string; next_offset: number }>
  | Readonly<{ kind: 'committed'; receipt: HostCollaborationDeliveryReceipt }>

function reject(): never { throw new HostControlProtocolError('invalid_frame') }
function row(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) reject()
  const fields = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(value)
  if (names.some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))
    || keys.some(key => !Object.hasOwn(fields, key))
    || Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) reject()
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))
}
function text(value: unknown, bytes: number, nonempty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > bytes
    || (nonempty && !value.trim())) reject()
  return value
}
function id(value: unknown): string {
  const parsed = text(value, 256)
  if (!/^[!-~]{1,256}$/u.test(parsed) || /[/\\]/u.test(parsed) || parsed === '.' || parsed === '..') reject()
  return parsed
}
function uuid(value: unknown): string {
  const parsed = text(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed)) reject()
  return parsed
}
function digest(value: unknown): string {
  const parsed = text(value, 64)
  if (!/^[a-f0-9]{64}$/u.test(parsed)) reject()
  return parsed
}
function version(value: unknown): string {
  const parsed = text(value, 19)
  if (!/^[1-9][0-9]{0,18}$/u.test(parsed) || BigInt(parsed) > 9223372036854775807n) reject()
  return parsed
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/**
 * Validate a sequential upload fragment without changing ordinary control JSON budgets.
 * @param value - Exact chunk metadata and canonical base64url, at most 16KiB decoded.
 * @returns Detached fragment; invalid sizes, offsets, accessors and unknown fields reject.
 */
export function parseHostCollaborationDeliveryChunk(value: unknown): HostCollaborationDeliveryChunk {
  const r = row(value, ['upload_id', 'offset', 'total_bytes', 'payload_digest', 'chunk_base64url'])
  const encoded = text(r.chunk_base64url, 21846)
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) reject()
  const part = Buffer.from(encoded, 'base64url')
  if (!part.length || part.length > 16384 || part.toString('base64url') !== encoded
    || !Number.isSafeInteger(r.offset) || !Number.isSafeInteger(r.total_bytes)
    || (r.offset as number) < 0 || (r.total_bytes as number) < 1 || (r.total_bytes as number) > 1024 * 1024
    || (r.offset as number) + part.length > (r.total_bytes as number)) reject()
  return frozen({ upload_id: uuid(r.upload_id), offset: r.offset as number, total_bytes: r.total_bytes as number,
    payload_digest: digest(r.payload_digest), chunk_base64url: encoded })
}

/**
 * Validate a complete parent-only reply before handing it to the original Profile.
 * @param value - Exact namespace and readable terminal projection with complete 128KiB answer.
 * @returns Detached frozen capsule; malformed Unicode, unsafe metadata or result-digest changes reject.
 */
export function parseHostCollaborationDeliveryCapsule(value: unknown): HostCollaborationDeliveryCapsule {
  const r = row(value, ['namespace_id', 'projection'])
  const p = row(r.projection, ['delivery_id', 'invocation_id', 'plan_id', 'task_id', 'task_revision', 'source_locator',
    'source_snapshot_digest', 'execution_state', 'invocation_state_version', 'result_digest', 'target',
    'target_display_snapshot', 'delivery_state', 'delivery_state_version'], ['answer', 'failure_code'])
  const target = row(p.target, ['project_id', 'agent_id']), display = row(p.target_display_snapshot, ['agent_name', 'project_name'])
  const source = row(p.source_locator, ['workspace_id', 'session_id', 'source_message_id', 'source_revision'])
  if (!['succeeded', 'failed', 'revoked', 'cancelled', 'indeterminate'].includes(p.execution_state as string)
    || !['pending', 'delivered', 'failed'].includes(p.delivery_state as string)
    || (p.execution_state === 'succeeded') !== Object.hasOwn(p, 'answer')) reject()
  const result: HostCollaborationDeliveryCapsule = { namespace_id: id(r.namespace_id), projection: {
    delivery_id: id(p.delivery_id), invocation_id: id(p.invocation_id), plan_id: id(p.plan_id), task_id: id(p.task_id),
    task_revision: version(p.task_revision), source_locator: parseHostCollaborationSourceTarget(source),
    source_snapshot_digest: digest(p.source_snapshot_digest),
    execution_state: p.execution_state as HostCollaborationDeliveryCapsule['projection']['execution_state'],
    invocation_state_version: version(p.invocation_state_version), result_digest: digest(p.result_digest),
    target: { project_id: id(target.project_id), agent_id: id(target.agent_id) },
    target_display_snapshot: { agent_name: text(display.agent_name, 512, true), project_name: text(display.project_name, 512, true) },
    ...(Object.hasOwn(p, 'answer') ? { answer: text(p.answer, 128 * 1024) } : {}),
    ...(Object.hasOwn(p, 'failure_code') ? { failure_code: text(p.failure_code, 128, true) } : {}),
    delivery_state: p.delivery_state as HostCollaborationDeliveryCapsule['projection']['delivery_state'],
    delivery_state_version: version(p.delivery_state_version),
  } }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024
    || result.projection.result_digest !== hash({ state: result.projection.execution_state,
      answer: result.projection.answer ?? null, failure_code: result.projection.failure_code ?? null })) reject()
  return frozen(result)
}

/**
 * Validate a Profile's durable commit descriptor without accepting an answer echo.
 * @param value - Exact bounded worker reply coordinates and immutable commit.
 * @returns Detached descriptor for parent identity signing, after full format validation.
 */
export function parseHostCollaborationDeliveryCommit(value: unknown): HostCollaborationDeliveryCommit {
  const r = row(value, ['namespace_id', 'delivery_id', 'invocation_id', 'source_locator',
    'source_snapshot_digest', 'result_digest', 'host_journal_commit'])
  const c = row(r.host_journal_commit, ['journal_id', 'commit_version', 'content_digest'])
  const source = row(r.source_locator, ['workspace_id', 'session_id', 'source_message_id', 'source_revision'])
  if (c.commit_version !== '1') reject()
  return frozen({ namespace_id: id(r.namespace_id), delivery_id: id(r.delivery_id), invocation_id: id(r.invocation_id),
    source_locator: parseHostCollaborationSourceTarget(source), source_snapshot_digest: digest(r.source_snapshot_digest),
    result_digest: digest(r.result_digest),
    host_journal_commit: { journal_id: uuid(c.journal_id), commit_version: '1', content_digest: digest(c.content_digest) } })
}

/**
 * Check that the returned first commit certifies this complete immutable reply body.
 * @param capsule - Parsed full reply, including mutable cloud status.
 * @param receipt - Parsed private Profile commit descriptor.
 * @returns Whether original coordinates, result identity and immutable body digest all match.
 */
export function matchesHostCollaborationDeliveryCommit(
  capsule: HostCollaborationDeliveryCapsule, receipt: HostCollaborationDeliveryCommit,
): boolean {
  const { delivery_state: _state, delivery_state_version: _version, ...body } = capsule.projection
  return receipt.namespace_id === capsule.namespace_id && receipt.delivery_id === body.delivery_id
    && receipt.invocation_id === body.invocation_id && receipt.source_snapshot_digest === body.source_snapshot_digest
    && receipt.result_digest === body.result_digest && canonical(receipt.source_locator) === canonical(body.source_locator)
    && receipt.host_journal_commit.content_digest === hash({ namespace_id: capsule.namespace_id, ...body })
}

/**
 * Validate an answer-free receipt before checking its installation signature.
 * @param value - Exact Account, current Host identity and immutable Profile commit.
 * @returns Detached receipt; unknown fields, credentials, unsafe origins or malformed keys reject.
 */
export function parseHostCollaborationDeliveryReceipt(value: unknown): HostCollaborationDeliveryReceipt {
  const r = row(value, ['schema_version', 'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
    'account_issuer', 'account_subject', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce', 'commit', 'signature'])
  const issuer = text(r.account_issuer, 2048, true), handle = text(r.account_binding_handle, 2048)
  let origin: URL
  try { origin = new URL(issuer) } catch { return reject() }
  if (r.schema_version !== 1 || origin.protocol !== 'https:' || origin.origin !== issuer || !handle.length || handle.length > 512 || /[\u0000-\u001f\u007f]/u.test(handle)
    || !Number.isSafeInteger(r.authority_binding_version) || (r.authority_binding_version as number) < 1) reject()
  const key = text(r.installation_public_key, 43), nonce = text(r.process_nonce, 43), signature = text(r.signature, 86)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(key) || !/^[A-Za-z0-9_-]{43}$/u.test(nonce) || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) reject()
  return frozen({ schema_version: 1, authority_environment_id: uuid(r.authority_environment_id), account_binding_handle: handle,
    authority_binding_version: r.authority_binding_version as number, account_issuer: issuer, account_subject: uuid(r.account_subject),
    installation_id: uuid(r.installation_id), installation_public_key: key,
    host_instance_id: uuid(r.host_instance_id), process_nonce: nonce,
    commit: parseHostCollaborationDeliveryCommit(r.commit), signature })
}

/**
 * Encode a separate signing domain for the exact parsed immutable delivery receipt.
 * @param value - Validated receipt; its signature is excluded from the payload.
 * @returns Canonical UTF-8 bytes binding Account, Host process and the original durable commit.
 */
export function encodeHostCollaborationDeliveryReceiptPayload(value: HostCollaborationDeliveryReceipt): Buffer {
  const { signature: _signature, ...payload } = parseHostCollaborationDeliveryReceipt(value)
  return Buffer.from(canonical(['dsh-collaboration-delivery-receipt-v1', payload]), 'utf8')
}

/**
 * Validate bounded progress or the final signed commit for the control carrier.
 * @param value - Exact progress metadata or answer-free receipt.
 * @returns Detached response; oversized offsets and unexpected fields reject.
 */
export function parseHostCollaborationDeliveryResult(value: unknown): HostCollaborationDeliveryResult {
  const discriminator = row(value, ['kind'], ['upload_id', 'next_offset', 'receipt'])
  if (discriminator.kind === 'committed') {
    const r = row(value, ['kind', 'receipt'])
    return frozen({ kind: 'committed', receipt: parseHostCollaborationDeliveryReceipt(r.receipt) })
  }
  const r = row(value, ['kind', 'upload_id', 'next_offset'])
  if (r.kind !== 'staged' || !Number.isSafeInteger(r.next_offset) || (r.next_offset as number) < 1 || (r.next_offset as number) >= 1024 * 1024) reject()
  return frozen({ kind: 'staged', upload_id: uuid(r.upload_id), next_offset: r.next_offset as number })
}
