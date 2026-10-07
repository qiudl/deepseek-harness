import { parseHostRootSubmissionDescriptor, type HostRootSubmissionTarget, type HostRootSubmissionDescriptor } from './root-authority.ts'
/** REQ-20261004-0008: bind a fresh planning attempt to an immutable original root and a current Host. */
import {
  encodeHostRootAuthorityPayload,
  parseHostRootAuthorityAssertion,
  parseHostRootAuthorityChallenge,
  type HostRootAuthorityAssertion,
  type HostRootAuthorityChallenge,
} from './root-authority.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HostControlRequestId } from './types.ts'
/** Actual model identity prepared for this attempt; no credentials or callable handles. */
export type HostRootPlanningModelSnapshot = Readonly<{
  provider: string
  model: string
  reasoning_effort?: string
  configuration_generation: string
  adapter_fingerprint: string
}>
/** Cloud challenge for one fresh attempt, distinct from root admission and execution grants. */
export type HostRootPlanningAttemptAuthorityChallenge = Readonly<{
  schema_version: 1
  scope: 'planning_attempt'
  root_challenge: HostRootAuthorityChallenge
  expected_plan_revision: string
  input_version: '1'
  predecessor: Readonly<{ attempt_request_id: HostControlRequestId; input_manifest_digest: string }> | null
  attempt_request_id: HostControlRequestId
  input_manifest_digest: string
  model_policy: 'original_model'
  model_snapshot: HostRootPlanningModelSnapshot
}>
/** Installation-signed planning metadata; dispatch requires a separate current grant. */
export type HostRootPlanningAttemptAuthorityAssertion = Omit<
  HostRootAuthorityAssertion,
  'challenge'
> &
  Readonly<{ challenge: HostRootPlanningAttemptAuthorityChallenge }>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const digest = /^[0-9a-f]{64}$/u
function bounded(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit
    || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'utf8')) !== value) invalid()
  return value
}
function invalid(): never {
  throw Error('invalid_root_planning_attempt_authority')
}
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    invalid()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).some(
      k =>
        ![...required, ...optional].includes(k) ||
        !fields[k]?.enumerable ||
        !('value' in fields[k]),
    ) ||
    required.some(k => !Object.hasOwn(fields, k))
  )
    invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) invalid()
  return value
}
function version(value: unknown): string {
  const v = text(value, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(v) > 9223372036854775807n) invalid()
  return v
}
function attemptFields(c: Record<string, unknown>): Omit<HostRootPlanningAttemptDescriptor, 'root'> {
  if (c.input_version !== '1' || c.model_policy !== 'original_model') invalid()
  const attemptId = brandString<HostControlRequestId>(text(c.attempt_request_id, uuid)),
    manifest = text(c.input_manifest_digest, digest)
  let predecessor: HostRootPlanningAttemptAuthorityChallenge['predecessor'] = null
  if (c.predecessor !== null) {
    const p = record(c.predecessor, ['attempt_request_id', 'input_manifest_digest'])
    predecessor = Object.freeze({
      attempt_request_id: brandString<HostControlRequestId>(text(p.attempt_request_id, uuid)),
      input_manifest_digest: text(p.input_manifest_digest, digest),
    })
    if (
      predecessor.attempt_request_id === attemptId ||
      predecessor.input_manifest_digest === manifest
    )
      invalid()
  }
  const m = record(
    c.model_snapshot,
    ['provider', 'model', 'configuration_generation', 'adapter_fingerprint'],
    ['reasoning_effort'],
  )
  version(m.configuration_generation)
  text(m.adapter_fingerprint, digest)
  const model = Object.freeze({ provider: bounded(m.provider, 256), model: bounded(m.model, 256),
    configuration_generation: version(m.configuration_generation), adapter_fingerprint: text(m.adapter_fingerprint, digest),
    ...(Object.hasOwn(m, 'reasoning_effort') ? { reasoning_effort: bounded(m.reasoning_effort, 128) } : {}),
  })
  return Object.freeze({
    input_version: '1',
    predecessor,
    attempt_request_id: attemptId,
    input_manifest_digest: manifest,
    model_policy: 'original_model',
    model_snapshot: model,
  })
}
/** Parse bounded private metadata without establishing its owner or liveness.
 * @param value - Untrusted worker or wire descriptor.
 * @returns Detached descriptor; lifecycle and authorization require separate checks.
 */
export function parseHostRootPlanningAttemptDescriptor(value: unknown): HostRootPlanningAttemptDescriptor {
  const r = record(value, ['root', 'input_version', 'predecessor', 'attempt_request_id', 'input_manifest_digest', 'model_policy', 'model_snapshot'])
  return Object.freeze({ root: parseHostRootSubmissionDescriptor(r.root), ...attemptFields(r) })
}
/** Parse exact fields without validating issuance, original model policy or dispatch state.
 * @param value - Untrusted challenge JSON.
 * @returns Detached frozen challenge; no authority is granted.
 */
export function parseHostRootPlanningAttemptAuthorityChallenge(
  value: unknown,
): HostRootPlanningAttemptAuthorityChallenge {
  const c = record(value, [
    'schema_version',
    'scope',
    'root_challenge',
    'expected_plan_revision',
    'input_version',
    'predecessor',
    'attempt_request_id',
    'input_manifest_digest',
    'model_policy',
    'model_snapshot',
  ])
  if (
    c.schema_version !== 1 ||
    c.scope !== 'planning_attempt' ||
    c.input_version !== '1' ||
    c.model_policy !== 'original_model'
  )
    invalid()
  const root = parseHostRootAuthorityChallenge(c.root_challenge)
  return Object.freeze({ schema_version: 1, scope: 'planning_attempt', root_challenge: root,
    expected_plan_revision: version(c.expected_plan_revision), ...attemptFields(c) })
}
/** Parse signed metadata without granting dispatch.
 * @param value - Untrusted assertion JSON.
 * @returns Detached frozen assertion; signature verification remains separate.
 */
export function parseHostRootPlanningAttemptAuthorityAssertion(
  value: unknown,
): HostRootPlanningAttemptAuthorityAssertion {
  const r = record(value, [
    'schema_version',
    'challenge',
    'installation_id',
    'installation_public_key',
    'host_instance_id',
    'process_nonce',
    'signature',
  ])
  const challenge = parseHostRootPlanningAttemptAuthorityChallenge(r.challenge)
  const root = parseHostRootAuthorityAssertion({ ...r, challenge: challenge.root_challenge })
  return Object.freeze({ ...root, challenge })
}
/**
 * UTF-8 domain-separated fixed tuple. The nested root payload is a string, including its domain/NUL,
 * and binds the original root, Source and current Account/Host challenge without reusing its signature.
 * Missing reasoning and predecessor are explicit nulls. Credentials and executable handles are excluded.
 * @param value - Parsed assertion; the signature itself is excluded.
 * @returns Domain-separated signing bytes, compatible with the Slark encoder.
 */
export function encodeHostRootPlanningAttemptAuthorityPayload(
  value: HostRootPlanningAttemptAuthorityAssertion,
): Buffer {
  const r = parseHostRootPlanningAttemptAuthorityAssertion(value),
    c = r.challenge,
    m = c.model_snapshot
  const rootPayload = encodeHostRootAuthorityPayload({ ...r, challenge: c.root_challenge }).toString('utf8')
  return Buffer.from(
    'dsh-collaboration-root-planning-attempt-authority/v1\0' +
    JSON.stringify([
      1,
      rootPayload,
      c.scope,
      c.expected_plan_revision,
      c.input_version,
      c.predecessor === null
        ? null
        : [c.predecessor.attempt_request_id, c.predecessor.input_manifest_digest],
      c.attempt_request_id,
      c.input_manifest_digest,
      c.model_policy,
      [
        m.provider,
        m.model,
        m.reasoning_effort ?? null,
        m.configuration_generation,
        m.adapter_fingerprint,
      ],
    ]),
  )
}

/** Persisted attempt metadata supplied only by the current Profile's private owner. */
export type HostRootPlanningAttemptDescriptor = Pick<HostRootPlanningAttemptAuthorityChallenge,
  'input_version' | 'predecessor' | 'attempt_request_id' | 'input_manifest_digest' | 'model_policy' | 'model_snapshot'>
  & Readonly<{ root: HostRootSubmissionDescriptor }>
/** Compare private durable metadata with a server challenge; liveness and dispatch state remain owner checks.
 * @param value - Metadata returned by the Account-authorized private reader.
 * @param challenge - Detached current challenge.
 * @returns Matched detached descriptor without granting dispatch.
 */
export function matchHostRootPlanningAttemptDescriptor(value: unknown,
  challenge: HostRootPlanningAttemptAuthorityChallenge): HostRootPlanningAttemptDescriptor {
  const r = record(value, ['root', 'input_version', 'predecessor', 'attempt_request_id', 'input_manifest_digest', 'model_policy', 'model_snapshot'])
  const root = parseHostRootSubmissionDescriptor(r.root), c = challenge.root_challenge, s = c.source_challenge, d = root.source_descriptor
  if (root.namespace_id !== c.namespace_id || root.root_task_id !== c.root_task_id || root.root_trace_id !== c.root_trace_id
    || root.command_id !== c.command_id || root.payload_digest !== c.payload_digest
    || d.workspace_id !== s.workspace_id || d.session_id !== s.session_id || d.source_message_id !== s.source_message_id
    || d.source_revision !== s.source_revision || d.snapshot_digest !== s.snapshot_digest) invalid()
  const { root: _root, ...attempt } = r
  const parsed = parseHostRootPlanningAttemptAuthorityChallenge({ ...challenge, ...attempt })
  if (JSON.stringify(parsed) !== JSON.stringify(challenge)) invalid()
  return Object.freeze({ root, input_version: parsed.input_version, predecessor: parsed.predecessor,
    attempt_request_id: parsed.attempt_request_id, input_manifest_digest: parsed.input_manifest_digest,
    model_policy: parsed.model_policy, model_snapshot: parsed.model_snapshot })
}

/** Match private metadata to the requested original root and optional attempt identity.
 * @param value - Private worker response.
 * @param target - Original Account-authorized lookup.
 * @param attemptId - Exact attempt identity for read operations; omitted for preparation.
 * @returns Parsed descriptor; mismatched coordinates reject.
 */
export function matchHostRootPlanningAttemptTarget(value: unknown, target: HostRootSubmissionTarget,
  attemptId?: string): HostRootPlanningAttemptDescriptor {
  const d = parseHostRootPlanningAttemptDescriptor(value), r = d.root, s = r.source_descriptor
  if (r.namespace_id !== target.namespace_id || r.command_id !== target.command_id || s.workspace_id !== target.workspace_id
    || s.session_id !== target.session_id || s.source_message_id !== target.source_message_id
    || s.source_revision !== target.source_revision
    || (attemptId !== undefined && d.attempt_request_id !== attemptId)) invalid()
  return d
}
