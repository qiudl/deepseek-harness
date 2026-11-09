/** Binding-scoped native control Sources and their original signing artifacts. */
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostBoundBotRoomsProof, HostBoundBotRoomsTarget, HostBoundRoomId } from './bound-bot-rooms.ts'
import type { HostProfileId, HostControlSha256, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot,
  HostSourceAuthorityChallenge, HostSourceAuthorityAssertion, HostGroupInputFenceChallenge,
  HostGroupInputFenceAssertion } from './types.ts'
import { record, text, uuid, digest, id, version, time } from './twin-binding-validation.ts'
import { parseHostCollaborationSourceDescriptor, parseHostCollaborationSourceSnapshot,
  parseHostSourceAuthorityChallenge, parseHostSourceAuthorityAssertion, encodeHostSourceAuthorityPayload,
  parseHostGroupInputFenceChallenge, parseHostGroupInputFenceAssertion, encodeHostGroupInputFencePayload } from './codec.ts'
import { parseHostNativeRoomAssertion, encodeHostNativeRoomAssertionPayload, type HostNativeRoomAssertion } from './native-room.ts'

/** Original Computer selected by Cloud; this echo grants no Host or Cloud authority. */
export type HostNativePreparationComputerId = Branded<'HostNativePreparationComputerId'>
/** Complete JSON frame budget for the independent preparation method, excluding its LF delimiter. */
export const HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES = 49_152
type Base = Pick<HostBoundBotRoomsTarget, 'challenge_nonce' | 'expires_at' | 'binding_id' | 'binding_generation' | 'bot_id'> & Readonly<{
  computer_id: HostNativePreparationComputerId
  slark_audience: string
  expected_profile_id: HostProfileId
  room_id: HostBoundRoomId
  workspace_id: HostCollaborationSourceDescriptor['workspace_id']
  member_set_digest: HostControlSha256
}>
/** Independent preparation stage; only a null first-stage Source permits creation. */
export type HostNativeRoomPreparationTarget = Base & (
  Readonly<{ operation: 'prepare_source'; expected_source: HostCollaborationSourceDescriptor | null }>
  | Readonly<{ operation: 'attest_source'; source_challenge: HostSourceAuthorityChallenge }>
  | Readonly<{ operation: 'attest_activation'
    source: HostCollaborationSourceDescriptor
    activation_challenge: HostGroupInputFenceChallenge }>
)
/** Actual participation and immutable Source read from the same Profile worker. */
export type HostNativeRoomPreparationObservation = Readonly<{
  bot_id: HostBoundBotRoomsTarget['bot_id']
  room_id: HostBoundRoomId
  workspace_id: HostCollaborationSourceDescriptor['workspace_id']
  member_set_digest: HostControlSha256
  source: HostCollaborationSourceDescriptor
}>
/** Original artifacts; none independently grants Cloud binding or group readiness. */
export type HostNativeRoomPreparationOutput =
  Readonly<{ operation: 'prepare_source'
    native_room_assertion: HostNativeRoomAssertion
    source_snapshot: HostCollaborationSourceSnapshot }>
  | Readonly<{ operation: 'attest_source'; source_assertion: HostSourceAuthorityAssertion }>
  | Readonly<{ operation: 'attest_activation'; activation_assertion: HostGroupInputFenceAssertion }>
type Authority = Omit<HostBoundBotRoomsProof, 'schema_version' | 'purpose' | 'target' | 'page' | 'account_subject'>
  & Readonly<{ account_subject: HostSourceAuthorityChallenge['account_subject'] }>
/** Installation signature over current participation, the complete stage and its original artifacts. */
export type HostNativeRoomPreparationProof = Authority & Readonly<{
  schema_version: 1
  purpose: 'native_room_preparation'
  target: HostNativeRoomPreparationTarget
  observation: HostNativeRoomPreparationObservation
  output: HostNativeRoomPreparationOutput
}>
/** Definite stage outcomes, separate from the existing Host error vocabulary. */
export type HostNativeRoomPreparationOutcome = Readonly<{ state: 'prepared'; proof: HostNativeRoomPreparationProof }>
  | Readonly<{ state: 'bot_unavailable' | 'room_unavailable' | 'membership_changed' | 'not_prepared'
    | 'recovery_required' | 'source_conflict' | 'too_large' }>

const baseKeys = ['operation', 'challenge_nonce', 'expires_at', 'binding_id', 'binding_generation',
  'computer_id', 'slark_audience', 'expected_profile_id', 'bot_id', 'room_id', 'workspace_id', 'member_set_digest']
const descriptorKeys = ['workspace_id', 'session_id', 'source_message_id', 'source_revision', 'snapshot_digest']
const workspaceChallengeKeys = ['request_id', 'challenge_nonce', 'expires_at', 'audience', 'environment_id',
  'account_issuer', 'account_subject', 'workspace_id', 'session_id']
const sourceChallengeKeys = [...workspaceChallengeKeys, 'source_message_id', 'source_revision', 'snapshot_digest', 'host_epoch']
const fenceChallengeKeys = [...workspaceChallengeKeys, 'group_id', 'group_version']
const assertionKeys = ['schema_version', 'challenge', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce', 'signature']
const authorityKeys = ['host_profile_id', 'authority_environment_id', 'account_binding_handle', 'authority_binding_version',
  'account_issuer', 'account_subject', 'installation_id', 'installation_public_key', 'host_instance_id', 'process_nonce', 'issued_at', 'signature']
const nativeAssertionKeys = ['schema_version', 'binding', ...authorityKeys.filter(key => key !== 'host_profile_id')]
const invalid = (): never => { throw Error('host_native_room_preparation_invalid') }
function parse<T>(work: () => T): T {
  try { return work() } catch { return invalid() }
}
function tag(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const field = Object.getOwnPropertyDescriptor(value, key)
  return field && field.enumerable && Object.hasOwn(field, 'value') ? field.value : invalid()
}
function base64(value: unknown, bytes: number): string {
  const parsed = text(value, /^[A-Za-z0-9_-]+$/u), decoded = Buffer.from(parsed, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== parsed) return invalid()
  return parsed
}
function positive(value: unknown): number {
  const parsed = time(value)
  return parsed > 0 ? parsed : invalid()
}
function origin(value: unknown): string {
  const parsed = text(value, /^https:\/\/[!-~]{1,2040}$/u), url = new URL(parsed)
  return url.origin === parsed && !url.username && !url.password ? parsed : invalid()
}
function descriptor(value: unknown): HostCollaborationSourceDescriptor {
  const parsed = parseHostCollaborationSourceDescriptor(record(value, descriptorKeys))
  return parsed.source_revision === '1' ? parsed : invalid()
}
function sourceChallenge(value: unknown): HostSourceAuthorityChallenge {
  const parsed = parseHostSourceAuthorityChallenge(record(value, sourceChallengeKeys))
  return parsed.source_revision === '1' ? parsed : invalid()
}
function fenceChallenge(value: unknown): HostGroupInputFenceChallenge {
  const parsed = parseHostGroupInputFenceChallenge(record(value, fenceChallengeKeys))
  return parsed.group_version === 1 ? parsed : invalid()
}
function base(r: Record<string, unknown>): Base {
  return { challenge_nonce: base64(r.challenge_nonce, 32) as Base['challenge_nonce'], expires_at: positive(r.expires_at),
    binding_id: uuid(r.binding_id) as Base['binding_id'], binding_generation: version(r.binding_generation) as Base['binding_generation'],
    computer_id: id(r.computer_id) as HostNativePreparationComputerId, slark_audience: origin(r.slark_audience),
    expected_profile_id: uuid(r.expected_profile_id) as HostProfileId,
    bot_id: text(r.bot_id, /^[A-Za-z0-9_-]{1,200}$/u) as Base['bot_id'], room_id: id(r.room_id) as HostBoundRoomId,
    workspace_id: uuid(r.workspace_id) as Base['workspace_id'], member_set_digest: digest(r.member_set_digest) as HostControlSha256 }
}
/** Parse one independent stage and reject cross-room or cross-audience targets before I/O.
 * @param value Untrusted target.
 * @returns Detached typed stage with original Source coordinates.
 */
export function parseHostNativeRoomPreparationTarget(value: unknown): HostNativeRoomPreparationTarget {
  return parse(() => {
    const operation = tag(value, 'operation')
    if (operation === 'prepare_source') {
      const r = record(value, [...baseKeys, 'expected_source']), b = base(r)
      const expected = r.expected_source === null ? null : descriptor(r.expected_source)
      if (expected && expected.workspace_id !== b.workspace_id) return invalid()
      return { ...b, operation, expected_source: expected }
    }
    if (operation === 'attest_source') {
      const r = record(value, [...baseKeys, 'source_challenge']), b = base(r), c = sourceChallenge(r.source_challenge)
      if (c.workspace_id !== b.workspace_id || c.audience !== b.slark_audience) return invalid()
      return { ...b, operation, source_challenge: c }
    }
    if (operation === 'attest_activation') {
      const r = record(value, [...baseKeys, 'source', 'activation_challenge']), b = base(r)
      const s = descriptor(r.source), c = fenceChallenge(r.activation_challenge)
      if (s.workspace_id !== b.workspace_id || c.workspace_id !== b.workspace_id || c.session_id !== s.session_id ||
        c.audience !== b.slark_audience) return invalid()
      return { ...b, operation, source: s, activation_challenge: c }
    }
    return invalid()
  })
}
function authority(r: Record<string, unknown>): Authority {
  return { host_profile_id: uuid(r.host_profile_id) as Authority['host_profile_id'],
    authority_environment_id: uuid(r.authority_environment_id) as Authority['authority_environment_id'],
    account_binding_handle: id(r.account_binding_handle) as Authority['account_binding_handle'],
    authority_binding_version: positive(r.authority_binding_version), account_issuer: origin(r.account_issuer),
    account_subject: uuid(r.account_subject) as Authority['account_subject'], installation_id: uuid(r.installation_id) as Authority['installation_id'],
    installation_public_key: base64(r.installation_public_key, 32) as Authority['installation_public_key'],
    host_instance_id: uuid(r.host_instance_id) as Authority['host_instance_id'],
    process_nonce: base64(r.process_nonce, 32) as Authority['process_nonce'], issued_at: time(r.issued_at),
    signature: base64(r.signature, 64) as Authority['signature'] }
}
/** Parse actual room participation and the complete immutable control Source.
 * @param value Untrusted worker observation.
 * @returns Detached participation and Source fields.
 */
export function parseHostNativeRoomPreparationObservation(value: unknown): HostNativeRoomPreparationObservation {
  const r = record(value, ['bot_id', 'room_id', 'workspace_id', 'member_set_digest', 'source'])
  return { bot_id: text(r.bot_id, /^[A-Za-z0-9_-]{1,200}$/u) as Base['bot_id'], room_id: id(r.room_id) as HostBoundRoomId,
    workspace_id: uuid(r.workspace_id) as Base['workspace_id'], member_set_digest: digest(r.member_set_digest) as HostControlSha256, source: descriptor(r.source) }
}
function output(value: unknown): HostNativeRoomPreparationOutput {
  const operation = tag(value, 'operation')
  if (operation === 'prepare_source') {
    const r = record(value, ['operation', 'native_room_assertion', 'source_snapshot'])
    const a = record(r.native_room_assertion, nativeAssertionKeys), b = record(a.binding, ['room_id', 'source'])
    const source = record(b.source, descriptorKeys.slice(0, 4)), capsule = record(r.source_snapshot, ['descriptor', 'snapshot_json'])
    if (typeof capsule.snapshot_json !== 'string' || !capsule.snapshot_json.isWellFormed() ||
      Buffer.byteLength(capsule.snapshot_json, 'utf8') > HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES) return invalid()
    return { operation, native_room_assertion: parseHostNativeRoomAssertion({ ...a, binding: { ...b, source } }),
      source_snapshot: parseHostCollaborationSourceSnapshot({ ...capsule, descriptor: descriptor(capsule.descriptor) }) }
  }
  if (operation === 'attest_source') {
    const r = record(value, ['operation', 'source_assertion']), a = record(r.source_assertion, assertionKeys)
    return { operation, source_assertion: parseHostSourceAuthorityAssertion({ ...a, challenge: sourceChallenge(a.challenge) }) }
  }
  if (operation === 'attest_activation') {
    const r = record(value, ['operation', 'activation_assertion']), a = record(r.activation_assertion, assertionKeys)
    return { operation, activation_assertion: parseHostGroupInputFenceAssertion({ ...a, challenge: fenceChallenge(a.challenge) }) }
  }
  return invalid()
}
function sameSource(a: HostCollaborationSourceDescriptor, b: HostCollaborationSourceDescriptor): boolean {
  return descriptorKeys.every(key =>
    a[key as keyof HostCollaborationSourceDescriptor] === b[key as keyof HostCollaborationSourceDescriptor])
}
function sameIdentity(a: Pick<HostNativeRoomAssertion, 'installation_id' | 'installation_public_key' | 'host_instance_id' | 'process_nonce'>,
  b: Authority): boolean {
  return a.installation_id === b.installation_id && a.installation_public_key === b.installation_public_key &&
    a.host_instance_id === b.host_instance_id && a.process_nonce === b.process_nonce
}
function checkArtifacts(o: HostNativeRoomPreparationOutput, t: HostNativeRoomPreparationTarget,
  r: HostNativeRoomPreparationObservation, a: Authority): void {
  if (o.operation === 'prepare_source') {
    if (t.operation !== 'prepare_source') return invalid()
    const n = o.native_room_assertion, s = n.binding.source
    if (!sameIdentity(n, a) || n.authority_environment_id !== a.authority_environment_id ||
      n.account_binding_handle !== a.account_binding_handle || n.authority_binding_version !== a.authority_binding_version ||
      n.account_issuer !== a.account_issuer || n.account_subject !== a.account_subject || n.binding.room_id !== r.room_id ||
      !sameSource(descriptor({ ...s, snapshot_digest: r.source.snapshot_digest }), r.source) ||
      !sameSource(o.source_snapshot.descriptor, r.source) || n.issued_at < t.expires_at - 60_000 ||
      n.issued_at > a.issued_at) return invalid()
    return
  }
  const artifact = o.operation === 'attest_source' ? o.source_assertion : o.activation_assertion
  const c = artifact.challenge
  if (!sameIdentity(artifact, a) || c.environment_id !== a.authority_environment_id ||
    c.account_issuer !== a.account_issuer || c.account_subject !== a.account_subject || c.audience !== t.slark_audience) return invalid()
  if (o.operation === 'attest_source') {
    if (t.operation !== 'attest_source') return invalid()
    if (JSON.stringify(sourceTuple(o.source_assertion.challenge)) !== JSON.stringify(sourceTuple(t.source_challenge)) ||
      !sameSource(o.source_assertion.challenge, r.source)) return invalid()
  } else {
    if (t.operation !== 'attest_activation') return invalid()
    if (JSON.stringify(fenceTuple(o.activation_assertion.challenge)) !== JSON.stringify(fenceTuple(t.activation_challenge)) ||
      !sameSource(t.source, r.source)) return invalid()
  }
}
/** Parse a complete success proof; full Source semantics, cryptography and current-connection checks remain with its owner.
 * @param value Untrusted proof from the new independent method.
 * @returns Detached original artifacts bound to one stage, participant and Source.
 */
export function parseHostNativeRoomPreparationProof(value: unknown): HostNativeRoomPreparationProof {
  return parse(() => {
    const p = record(value, ['schema_version', 'purpose', 'target', 'observation', 'output', ...authorityKeys])
    if (p.schema_version !== 1 || p.purpose !== 'native_room_preparation') return invalid()
    const t = parseHostNativeRoomPreparationTarget(p.target), r = parseHostNativeRoomPreparationObservation(p.observation)
    const a = authority(p), o = output(p.output)
    if (a.host_profile_id !== t.expected_profile_id || a.issued_at > t.expires_at || r.bot_id !== t.bot_id ||
      r.room_id !== t.room_id || r.workspace_id !== t.workspace_id || r.source.workspace_id !== r.workspace_id ||
      r.member_set_digest !== t.member_set_digest) return invalid()
    if (t.operation === 'prepare_source' && t.expected_source && !sameSource(t.expected_source, r.source)) return invalid()
    checkArtifacts(o, t, r, a)
    const proof: HostNativeRoomPreparationProof = { ...a, schema_version: 1, purpose: 'native_room_preparation',
      target: t, observation: r, output: o }
    if (Buffer.byteLength(JSON.stringify(proof), 'utf8') > HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES) return invalid()
    return proof
  })
}
/** Parse a definite independent-method result without adding Host error codes.
 * @param value Untrusted outcome.
 * @returns Signed stage success or an explicit result with no proof.
 */
export function parseHostNativeRoomPreparationOutcome(value: unknown): HostNativeRoomPreparationOutcome {
  return parse(() => {
    const state = tag(value, 'state')
    if (state === 'prepared') {
      const r = record(value, ['state', 'proof'])
      return { state, proof: parseHostNativeRoomPreparationProof(r.proof) }
    }
    record(value, ['state'])
    if (state === 'bot_unavailable' || state === 'room_unavailable' || state === 'membership_changed' ||
      state === 'not_prepared' || state === 'recovery_required' || state === 'source_conflict' || state === 'too_large') return { state }
    return invalid()
  })
}
function descriptorTuple(s: HostCollaborationSourceDescriptor) {
  return [s.workspace_id, s.session_id, s.source_message_id, s.source_revision, s.snapshot_digest]
}
function workspaceTuple(c: HostSourceAuthorityChallenge | HostGroupInputFenceChallenge) {
  return [c.request_id, c.challenge_nonce, c.expires_at, c.audience, c.environment_id,
    c.account_issuer, c.account_subject, c.workspace_id, c.session_id]
}
function sourceTuple(c: HostSourceAuthorityChallenge) {
  return [workspaceTuple(c), c.source_message_id, c.source_revision, c.snapshot_digest, c.host_epoch]
}
function fenceTuple(c: HostGroupInputFenceChallenge) {
  return [workspaceTuple(c), c.group_id, c.group_version]
}
function targetTuple(t: HostNativeRoomPreparationTarget) {
  const b = [t.operation, t.challenge_nonce, t.expires_at, t.binding_id, t.binding_generation, t.computer_id,
    t.slark_audience, t.expected_profile_id, t.bot_id, t.room_id, t.workspace_id, t.member_set_digest]
  if (t.operation === 'prepare_source') return [b, t.expected_source === null ? null : descriptorTuple(t.expected_source)]
  if (t.operation === 'attest_source') return [b, sourceTuple(t.source_challenge)]
  return [b, descriptorTuple(t.source), fenceTuple(t.activation_challenge)]
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function outputTuple(o: HostNativeRoomPreparationOutput) {
  if (o.operation === 'prepare_source') return [o.operation, hash(encodeHostNativeRoomAssertionPayload(o.native_room_assertion)),
    o.native_room_assertion.signature, descriptorTuple(o.source_snapshot.descriptor), hash(o.source_snapshot.snapshot_json)]
  if (o.operation === 'attest_source') return [o.operation, hash(encodeHostSourceAuthorityPayload(o.source_assertion)), o.source_assertion.signature]
  return [o.operation, hash(encodeHostGroupInputFencePayload(o.activation_assertion)), o.activation_assertion.signature]
}
/** Encode the exact fixed tuples in the independent native preparation domain.
 * @param value Complete proof; the outer signature alone is excluded.
 * @returns UTF8 domain, one NUL byte and the frozen ordered payload.
 */
export function encodeHostNativeRoomPreparationProofPayload(value: HostNativeRoomPreparationProof): Buffer {
  const p = parseHostNativeRoomPreparationProof(value), a = p
  const r = p.observation
  return Buffer.from(`dsh-native-room-preparation/v1\0${JSON.stringify([
    1, 'native_room_preparation', targetTuple(p.target),
    [r.bot_id, r.room_id, r.workspace_id, r.member_set_digest, descriptorTuple(r.source)],
    hash(JSON.stringify(outputTuple(p.output))),
    [a.host_profile_id, a.authority_environment_id, a.account_binding_handle, a.authority_binding_version,
      a.account_issuer, a.account_subject, a.installation_id, a.installation_public_key, a.host_instance_id, a.process_nonce, a.issued_at],
  ])}`, 'utf8')
}
