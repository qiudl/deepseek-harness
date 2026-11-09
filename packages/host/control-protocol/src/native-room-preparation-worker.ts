/** Unsigned facts from one private native preparation phase in its original Profile worker. */
import { parseHostNativeRoomSource, type HostNativeRoomSource } from './native-room.ts'
import { parseHostCollaborationSourceSnapshot, parseHostGroupInputFenceValue } from './codec.ts'
import { parseHostNativeRoomPreparationObservation, HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES } from './native-room-preparation.ts'
import type { HostNativeRoomPreparationObservation, HostNativeRoomPreparationTarget,
  HostNativeRoomPreparationOutcome } from './native-room-preparation.ts'
import type { HostCollaborationSourceSnapshot, HostGroupInputFenceValue } from './types.ts'
import { record, text, id, uuid, digest } from './twin-binding-validation.ts'

type Facts = Omit<HostNativeRoomPreparationObservation, 'source'>
/** Private DSBot membership read or guarded preparation; Source coordinates omit the snapshot digest. */
export type HostNativeRoomBindingRead =
  Readonly<{ state: 'bound'; source: HostNativeRoomSource['source'] }> & Facts
  | Readonly<{ state: 'not_prepared' | 'recovery_required' }> & Facts
  | Readonly<{ state: 'invalid' | 'unavailable' | 'bot_unavailable' | 'room_unavailable' | 'membership_changed' | 'source_conflict' }>
type NotReady = Exclude<HostNativeRoomPreparationOutcome, { state: 'prepared' }>
/** Only the parent Host signs these actual worker observations. */
export type HostNativeRoomPreparationWorkerRead =
  Readonly<{ state: 'observed'
    operation: 'prepare_source'
    observation: HostNativeRoomPreparationObservation
    source_snapshot: HostCollaborationSourceSnapshot }>
  | Readonly<{ state: 'observed'; operation: 'attest_source'; observation: HostNativeRoomPreparationObservation }>
  | Readonly<{ state: 'observed'
    operation: 'attest_activation'
    observation: HostNativeRoomPreparationObservation
    activation_fence: HostGroupInputFenceValue }>
  | NotReady | Readonly<{ state: 'upgrade_required' }>

const factsKeys = ['bot_id', 'room_id', 'workspace_id', 'member_set_digest']
const notReady = ['bot_unavailable', 'room_unavailable', 'membership_changed', 'not_prepared',
  'recovery_required', 'source_conflict', 'too_large', 'upgrade_required']
const invalid = (): never => { throw Error('host_native_room_preparation_worker_invalid') }
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable && Object.hasOwn(descriptor, 'value') ? descriptor.value : invalid()
}
function facts(value: Record<string, unknown>): Facts {
  return { bot_id: text(value.bot_id, /^[A-Za-z0-9_-]{1,200}$/u) as Facts['bot_id'],
    room_id: id(value.room_id) as Facts['room_id'], workspace_id: uuid(value.workspace_id) as Facts['workspace_id'],
    member_set_digest: digest(value.member_set_digest) as Facts['member_set_digest'] }
}
function sameSource(a: HostNativeRoomPreparationObservation['source'], b: HostNativeRoomPreparationObservation['source']): boolean {
  return a.workspace_id === b.workspace_id && a.session_id === b.session_id && a.source_message_id === b.source_message_id
    && a.source_revision === b.source_revision && a.snapshot_digest === b.snapshot_digest
}
/** Parse the private plugin result before using its participation or original Source.
 * @param value Untrusted plugin response.
 * @returns Detached original coordinates or an explicit inability to read them.
 */
export function parseHostNativeRoomBindingRead(value: unknown): HostNativeRoomBindingRead {
  const state = field(value, 'state')
  if (state === 'bound' || state === 'not_prepared' || state === 'recovery_required') {
    const row = record(value, ['state', ...factsKeys, ...(state === 'bound' ? ['source'] : [])]), actual = facts(row)
    if (state !== 'bound') return { state, ...actual }
    const binding = parseHostNativeRoomSource({ room_id: actual.room_id, source: row.source })
    if (binding.source.workspace_id !== actual.workspace_id) return invalid()
    return { state, ...actual, source: binding.source }
  }
  if (state !== 'invalid' && state !== 'unavailable' && state !== 'bot_unavailable' && state !== 'room_unavailable'
    && state !== 'membership_changed' && state !== 'source_conflict') return invalid()
  record(value, ['state'])
  return { state }
}
/** Parse one unsigned bounded phase result without accepting authority or signatures from the child.
 * @param value Untrusted private HTTP response.
 * @returns Typed actual observations or a definite stage outcome.
 */
export function parseHostNativeRoomPreparationWorkerRead(value: unknown): HostNativeRoomPreparationWorkerRead {
  const state = field(value, 'state')
  if (state !== 'observed') {
    if (typeof state !== 'string' || !notReady.includes(state)) return invalid()
    record(value, ['state'])
    return { state: state as NotReady['state'] | 'upgrade_required' }
  }
  const operation = field(value, 'operation')
  if (operation !== 'prepare_source' && operation !== 'attest_source' && operation !== 'attest_activation') return invalid()
  const row = record(value, ['state', 'operation', 'observation', ...(operation === 'prepare_source'
    ? ['source_snapshot'] : operation === 'attest_activation' ? ['activation_fence'] : [])])
  const observation = parseHostNativeRoomPreparationObservation(row.observation)
  if (observation.source.workspace_id !== observation.workspace_id) return invalid()
  const read: HostNativeRoomPreparationWorkerRead = operation === 'prepare_source'
    ? { state, operation, observation, source_snapshot: parseHostCollaborationSourceSnapshot(row.source_snapshot) }
    : operation === 'attest_activation'
      ? { state, operation, observation, activation_fence: parseHostGroupInputFenceValue(row.activation_fence) }
      : { state, operation, observation }
  if ('source_snapshot' in read && !sameSource(read.source_snapshot.descriptor, observation.source)) return invalid()
  if ('activation_fence' in read && (read.activation_fence.workspace_id !== observation.workspace_id ||
    read.activation_fence.session_id !== observation.source.session_id)) return invalid()
  if (Buffer.byteLength(JSON.stringify(read), 'utf8') > HOST_NATIVE_ROOM_PREPARATION_MAX_FRAME_BYTES) return invalid()
  return read
}
/** Bind already parsed worker facts to the original caller target before signing any artifact.
 * @param read Parsed private phase result.
 * @param target Original stage and selected participant.
 * @returns The same read after complete Source and phase matching.
 */
export function matchHostNativeRoomPreparationWorkerRead(read: HostNativeRoomPreparationWorkerRead,
  target: HostNativeRoomPreparationTarget): HostNativeRoomPreparationWorkerRead {
  if (read.state !== 'observed') return read
  const actual = read.observation
  if (read.operation !== target.operation || actual.bot_id !== target.bot_id || actual.room_id !== target.room_id ||
    actual.workspace_id !== target.workspace_id || actual.member_set_digest !== target.member_set_digest) return invalid()
  const expected = target.operation === 'prepare_source' ? target.expected_source
    : target.operation === 'attest_source' ? target.source_challenge : target.source
  if (expected && !sameSource(expected, actual.source)) return invalid()
  if (read.operation === 'attest_activation') {
    if (target.operation !== 'attest_activation' || read.activation_fence.group_id !== target.activation_challenge.group_id ||
      read.activation_fence.group_version !== target.activation_challenge.group_version) return invalid()
  }
  return read
}
