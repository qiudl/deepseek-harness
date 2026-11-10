/** Signed body-free original metadata; parsing and retained proofs confer no dispatch or Source authority. */
import { createHash } from 'node:crypto'
import { parseRuntimeEntryBinding, encodeRuntimeEntryBinding, type RuntimeEntryBinding, type RuntimeEntryObservation } from './project-operation-runtime-entry.ts'
import { record, id, uuid, digest, time, version, text } from './twin-binding-validation.ts'

/** Independent purpose for the signed metadata carrier; it never replaces the original consumer grant. */
export const RUNTIME_ENTRY_METADATA_AUTHORIZATION_PURPOSE = 'project_operation_runtime_entry_metadata' as const
const DOMAIN = 'slark.project-operation-runtime-entry-metadata/v1\0'
const GRANT_DOMAIN = 'slark.project-operation-runtime-entry-consumer-grant/v1\0'
const grantFields = ['namespaceId', 'consumerCommandId', 'commandDigest', 'consumerAttemptId', 'consumerStepGrantId',
  'rootTaskId', 'rootTraceId', 'executionCommandId', 'terminalDeliveryId', 'terminalResultDigest', 'messageId', 'sessionId',
  'expectedEventCount', 'expectedLogDigest', 'hostEpoch', 'grantIssuedAt', 'grantExpiresAt'] as const
const fail = (): never => { throw Error('invalid_runtime_entry_metadata_authorization') }
const positive = (value: unknown): number => { const n = time(value); return n > 0 ? n : fail() }
const label = (value: unknown): string => text(value, /^[^\x00-\x20\x7f]{1,2048}$/u)
function encoded(value: unknown, length: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return fail()
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === length && bytes.toString('base64url') === value ? value : fail()
}
/** Original immutable consumer tuple; the one-shot dispatch flag deliberately does not belong to its digest. */
export interface RuntimeEntryConsumerGrantMetadata {
  readonly namespaceId: string
  readonly consumerCommandId: string
  readonly commandDigest: string
  readonly consumerAttemptId: string
  readonly consumerStepGrantId: string
  readonly rootTaskId: string
  readonly rootTraceId: string
  readonly executionCommandId: string
  readonly terminalDeliveryId: string
  readonly terminalResultDigest: string
  readonly messageId: string
  readonly sessionId: string
  readonly expectedEventCount: number
  readonly expectedLogDigest: string
  readonly hostEpoch: string
  readonly grantIssuedAt: number
  readonly grantExpiresAt: number
  readonly consumerGrantDigest: string
}
/** The Source's current signed wrapper around the original immutable command facts. */
export interface RuntimeEntryMetadataAuthorization {
  readonly schemaVersion: 1
  readonly purpose: typeof RUNTIME_ENTRY_METADATA_AUTHORIZATION_PURPOSE
  readonly issuer: string
  readonly keyId: string
  readonly authorityEnvironmentId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly accountBindingId: string
  readonly accountBindingVersion: number
  readonly peer: RuntimeEntryObservation['peer']
  readonly requestId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly metadata: Readonly<{
    binding: RuntimeEntryBinding
    projectId: string
    taskRef: string | null
    dispatchGranted: boolean
    sourceKind: 'primary_human'
    originalAuthorityDigest: string
    accountAuthorityDigest: string
    consumerGrantMetadata: RuntimeEntryConsumerGrantMetadata
  }>
  readonly signature: string
}
function grantTuple(m: RuntimeEntryConsumerGrantMetadata): readonly unknown[] { return grantFields.map(key => m[key]) }
/** Validate the exact original persisted consumer tuple and its independent digest.
 * @param value - Body-free Source consumer metadata.
 * @returns Detached immutable original facts; dispatch is never inferred from them.
 */
export function parseRuntimeEntryConsumerGrantMetadata(value: unknown): RuntimeEntryConsumerGrantMetadata {
  const r = record(value, [...grantFields, 'consumerGrantDigest'])
  const result: RuntimeEntryConsumerGrantMetadata = Object.freeze({
    namespaceId: text(r.namespaceId, /^n2_[a-f0-9]{64}$/u), consumerCommandId: uuid(r.consumerCommandId),
    commandDigest: digest(r.commandDigest), consumerAttemptId: uuid(r.consumerAttemptId), consumerStepGrantId: uuid(r.consumerStepGrantId),
    rootTaskId: uuid(r.rootTaskId), rootTraceId: text(r.rootTraceId, /^(?!0{32}$)[a-f0-9]{32}$/u),
    executionCommandId: uuid(r.executionCommandId), terminalDeliveryId: id(r.terminalDeliveryId),
    terminalResultDigest: digest(r.terminalResultDigest), messageId: id(r.messageId), sessionId: id(r.sessionId),
    expectedEventCount: time(r.expectedEventCount), expectedLogDigest: digest(r.expectedLogDigest), hostEpoch: id(r.hostEpoch),
    grantIssuedAt: time(r.grantIssuedAt), grantExpiresAt: time(r.grantExpiresAt), consumerGrantDigest: digest(r.consumerGrantDigest),
  })
  if (result.grantExpiresAt <= result.grantIssuedAt || createHash('sha256').update(GRANT_DOMAIN + JSON.stringify(grantTuple(result)))
    .digest('hex') !== result.consumerGrantDigest) return fail()
  return result
}
function peer(value: unknown): RuntimeEntryObservation['peer'] {
  const p = record(value, ['computerId', 'installationId', 'hostRegistryId', 'hostEpoch', 'publicKey', 'hostInstanceId', 'processNonce'])
  return Object.freeze({ computerId: id(p.computerId), installationId: id(p.installationId), hostRegistryId: id(p.hostRegistryId),
    hostEpoch: version(p.hostEpoch), publicKey: encoded(p.publicKey, 32), hostInstanceId: id(p.hostInstanceId),
    processNonce: id(p.processNonce) }) as RuntimeEntryObservation['peer']
}
/** Parse only the closed signed metadata purpose. Current signatures, Account and worker are verified by Main.
 * @param value - Untrusted Cloud signature envelope.
 * @returns Detached immutable metadata with exact original binding/consumer relationships.
 */
export function parseRuntimeEntryMetadataAuthorization(value: unknown): RuntimeEntryMetadataAuthorization {
  const p = record(value, ['schemaVersion', 'purpose', 'issuer', 'keyId', 'authorityEnvironmentId', 'accountIssuer', 'accountSubject',
    'accountBindingId', 'accountBindingVersion', 'peer', 'requestId', 'issuedAt', 'expiresAt', 'metadata', 'signature'])
  const m = record(p.metadata, ['binding', 'projectId', 'taskRef', 'dispatchGranted', 'sourceKind', 'originalAuthorityDigest',
    'accountAuthorityDigest', 'consumerGrantMetadata'])
  if (p.schemaVersion !== 1 || p.purpose !== RUNTIME_ENTRY_METADATA_AUTHORIZATION_PURPOSE || m.sourceKind !== 'primary_human'
    || typeof m.dispatchGranted !== 'boolean') return fail()
  const b = parseRuntimeEntryBinding(m.binding), g = parseRuntimeEntryConsumerGrantMetadata(m.consumerGrantMetadata)
  const result: RuntimeEntryMetadataAuthorization = Object.freeze({ schemaVersion: 1, purpose: RUNTIME_ENTRY_METADATA_AUTHORIZATION_PURPOSE,
    issuer: label(p.issuer), keyId: id(p.keyId), authorityEnvironmentId: uuid(p.authorityEnvironmentId),
    accountIssuer: label(p.accountIssuer), accountSubject: uuid(p.accountSubject), accountBindingId: id(p.accountBindingId),
    accountBindingVersion: positive(p.accountBindingVersion), peer: peer(p.peer), requestId: uuid(p.requestId),
    issuedAt: time(p.issuedAt), expiresAt: time(p.expiresAt), metadata: Object.freeze({ binding: b, projectId: id(m.projectId),
      taskRef: m.taskRef === null ? null : id(m.taskRef), dispatchGranted: m.dispatchGranted, sourceKind: 'primary_human',
      originalAuthorityDigest: digest(m.originalAuthorityDigest), accountAuthorityDigest: digest(m.accountAuthorityDigest),
      consumerGrantMetadata: g }), signature: encoded(p.signature, 64) })
  if (result.expiresAt <= result.issuedAt || result.expiresAt - result.issuedAt > 120000
    || result.authorityEnvironmentId !== b.authorityEnvironmentId || g.namespaceId !== b.namespaceId
    || g.consumerCommandId !== b.consumerCommandId || g.consumerAttemptId !== b.consumerAttemptId
    || g.consumerStepGrantId !== b.consumerStepGrantId || g.rootTaskId !== b.rootTaskId || g.rootTraceId !== b.rootTraceId
    || g.executionCommandId !== b.executionCommandId || g.terminalDeliveryId !== b.terminalDeliveryId
    || g.terminalResultDigest !== b.terminalResultDigest || g.sessionId !== b.sessionId
    || g.grantIssuedAt !== b.grantIssuedAt || g.grantExpiresAt !== b.grantExpiresAt
    || g.consumerGrantDigest !== b.consumerGrantDigest) return fail()
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) return fail()
  return result
}
/** Encode the fixed signature preimage, excluding only the signature itself.
 * @param value - Complete strict metadata authorization.
 * @returns Domain-prefixed fixed ordered tuples; object insertion order never affects bytes.
 */
export function encodeRuntimeEntryMetadataAuthorization(value: unknown): string {
  const a = parseRuntimeEntryMetadataAuthorization(value), m = a.metadata, p = a.peer
  const binding = encodeRuntimeEntryBinding(m.binding)
  const bindingTuple: unknown = JSON.parse(binding.slice(binding.indexOf('\0') + 1))
  return DOMAIN + JSON.stringify([a.schemaVersion, a.purpose, a.issuer, a.keyId, a.authorityEnvironmentId, a.accountIssuer,
    a.accountSubject, a.accountBindingId, a.accountBindingVersion,
    [p.computerId, p.installationId, p.hostRegistryId, p.hostEpoch, p.publicKey, p.hostInstanceId, p.processNonce],
    a.requestId, a.issuedAt, a.expiresAt, [bindingTuple, m.projectId, m.taskRef, m.dispatchGranted, m.sourceKind,
      m.originalAuthorityDigest, m.accountAuthorityDigest,
      [...grantTuple(m.consumerGrantMetadata), m.consumerGrantMetadata.consumerGrantDigest]]])
}
/** Original raw grant syntax retained separately from the signed metadata wrapper. */
export type RuntimeEntryConsumerGrant = Readonly<{
  root_task_id: string
  root_trace_id: string
  execution_command_id: string
  delivery_id: string
  result_digest: string
  message_id: string
  command_id: string
  expected_event_count: number
  expected_log_digest: string
  task_revision: 1
  session_id: string
  command_digest: string
  consumer_attempt_id: string
  consumer_step_id: string
  issued_at: string
  expires_at: string
  dispatch_granted: boolean
}>
/** Validate original raw ISO grant fields without issuing or extending its permission.
 * @param value - The original grant from the same Source response as its metadata signature.
 * @returns Detached original grant; current authorization remains the actual consumer's responsibility.
 */
export function parseRuntimeEntryConsumerGrant(value: unknown): RuntimeEntryConsumerGrant {
  const g = record(value, ['root_task_id', 'root_trace_id', 'execution_command_id', 'delivery_id', 'result_digest', 'message_id',
    'command_id', 'expected_event_count', 'expected_log_digest', 'task_revision', 'session_id', 'command_digest',
    'consumer_attempt_id', 'consumer_step_id', 'issued_at', 'expires_at', 'dispatch_granted'])
  const iso = (v: unknown) => {
    const s = text(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    return new Date(time(Date.parse(s))).toISOString() === s ? s : fail()
  }
  if (g.task_revision !== 1 || typeof g.dispatch_granted !== 'boolean') return fail()
  const parsed: RuntimeEntryConsumerGrant = Object.freeze({ root_task_id: uuid(g.root_task_id),
    root_trace_id: text(g.root_trace_id, /^(?!0{32}$)[a-f0-9]{32}$/u), execution_command_id: uuid(g.execution_command_id),
    delivery_id: id(g.delivery_id), result_digest: digest(g.result_digest),
    message_id: text(g.message_id, /^collaboration-feedback-[a-f0-9]{64}$/u), command_id: uuid(g.command_id),
    expected_event_count: time(g.expected_event_count), expected_log_digest: digest(g.expected_log_digest), task_revision: 1,
    session_id: id(g.session_id), command_digest: digest(g.command_digest), consumer_attempt_id: uuid(g.consumer_attempt_id),
    consumer_step_id: uuid(g.consumer_step_id), issued_at: iso(g.issued_at), expires_at: iso(g.expires_at),
    dispatch_granted: g.dispatch_granted })
  const duration = Date.parse(parsed.expires_at) - Date.parse(parsed.issued_at)
  if (duration <= 0 || duration > 120000) return fail()
  return parsed
}
