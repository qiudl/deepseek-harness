/** Private current-room facts and original-cycle projection acknowledgements. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostAccountBindingHandle, HostAuthorityEnvironmentId, HostControlNonce,
  HostControlPublicKey, HostControlSha256, HostControlSignature, HostInstanceId,
  HostProfileId, InstallationId } from './types.ts'
import { record, text, uuid, digest, id, version, time, array, sorted } from './twin-binding-validation.ts'
import { parseHostNativeRoomCommand, parseHostNativeRoomReply,
  type HostNativeRoomCommand, type HostNativeRoomReply } from './native-room-operations.ts'

/** Original Cloud twin relation selected by the caller; not Host authorization. */
export type HostTwinGroupBindingId = Branded<'HostTwinGroupBindingId'>
/** Exact captured relation generation; never converted through a JavaScript number. */
export type HostTwinGroupBindingGeneration = Branded<'HostTwinGroupBindingGeneration'>
/** Persistent native root Bot identity. */
export type HostBoundRoomBotId = Branded<'HostBoundRoomBotId'>
/** Native room identity, independent of its bridge Session. */
export type HostBoundRoomId = Branded<'HostBoundRoomId'>
/** Opaque inventory cursor owned by the current plugin snapshot. */
export type HostBoundRoomCursor = Branded<'HostBoundRoomCursor'>
/** Original Cloud group membership command. */
export type HostRoomProjectionCommandId = Branded<'HostRoomProjectionCommandId'>
type Challenge = Readonly<{
  challenge_nonce: HostControlNonce
  expires_at: number
  binding_id: HostTwinGroupBindingId
  binding_generation: HostTwinGroupBindingGeneration
}>
/** Minimal private Profile query; contains no Cloud authority fields. */
export type HostBoundBotRoomsQuery = Readonly<{
  bot_id: HostBoundRoomBotId
  limit: number
  cursor: HostBoundRoomCursor | null
}>
/** One exact read-only inventory page under a fresh Cloud nonce. */
export type HostBoundBotRoomsTarget = Challenge & HostBoundBotRoomsQuery
/** Detached current participation facts; revision is informational, not an authority epoch. */
export type HostBoundBotRoomsPage = Readonly<{
  state: 'page'
  bot_id: HostBoundRoomBotId
  workspace_id: Branded<'HostBoundRoomsWorkspaceId'>
  state_revision: number
  membership_snapshot: HostControlSha256
  items: readonly Readonly<{ room_id: HostBoundRoomId; member_set_digest: HostControlSha256 }>[]
  next_cursor: HostBoundRoomCursor | null
}>
type Authority = Readonly<{
  host_profile_id: HostProfileId
  authority_environment_id: HostAuthorityEnvironmentId
  account_binding_handle: HostAccountBindingHandle
  authority_binding_version: number
  account_issuer: string
  account_subject: Branded<'HostTwinGroupAccountSubject'>
  installation_id: InstallationId
  installation_public_key: HostControlPublicKey
  host_instance_id: HostInstanceId
  process_nonce: HostControlNonce
  issued_at: number
  signature: HostControlSignature
}>
/** Installation-signed current page from the actual authorized Account Profile. */
export type HostBoundBotRoomsProof = Authority & Readonly<{
  schema_version: 1
  purpose: 'bound_bot_rooms'
  target: HostBoundBotRoomsTarget
  page: HostBoundBotRoomsPage
}>
/** Private plugin result; only page is a complete inventory fact. */
export type HostBoundBotRoomsRead = HostBoundBotRoomsPage
  | Readonly<{ state: 'bot_unavailable' | 'snapshot_changed' | 'upgrade_required' | 'unavailable' | 'invalid' }>
/** A failed or changed read is distinct from a signed complete page. */
export type HostBoundBotRoomsResult = Readonly<{ state: 'page'; proof: HostBoundBotRoomsProof }>
  | Readonly<{ state: 'bot_unavailable' | 'snapshot_changed' }>
/** Only the existing join and leave operations may create a projection acknowledgement. */
export type HostRoomProjectionCommand = Extract<HostNativeRoomCommand, { operation: 'join' | 'leave' }>
/** A fresh nonce binds the complete original Cloud command and native member cycle. */
export type HostNativeRoomProjectionTarget = Challenge & Readonly<{
  command_request_id: HostRoomProjectionCommandId
  command: HostRoomProjectionCommand
}>
/** Successful durable projection reply; absence and unknown acceptance are not acknowledgements. */
export type HostRoomProjectionReply = Extract<HostNativeRoomReply, { state: 'joined' | 'left' }>
/** Installation-signed acknowledgement of the original native projection operation. */
export type HostNativeRoomProjectionProof = Authority & Readonly<{
  schema_version: 1
  purpose: 'native_room_projection'
  target: HostNativeRoomProjectionTarget
  reply: HostRoomProjectionReply
}>
/** Complete original join identity used only to close its native cycle. */
export type HostNativeRoomRetirementCommand = Extract<HostRoomProjectionCommand, { operation: 'join' }>
/** Original join/leave pair retained across unknown acceptance and retries. */
export type HostNativeRoomRetirementTarget = Challenge & Readonly<{
  join_command_request_id: HostRoomProjectionCommandId
  join_command: HostNativeRoomRetirementCommand
  leave_command_request_id: HostRoomProjectionCommandId
  leave_command: Extract<HostRoomProjectionCommand, { operation: 'leave' }>
}>
/** Private plugin result; only left acknowledges a durable cycle fence. */
export type HostNativeRoomRetirementReply = Extract<HostNativeRoomReply, { state: 'left' }>
  | Readonly<{ state: 'upgrade_required' | 'conflict' | 'unavailable' | 'invalid' }>
/** Independent signed guarantee that the exact original member cycle stays closed. */
export type HostNativeRoomRetirementProof = Authority & Readonly<{
  schema_version: 1
  purpose: 'native_room_retirement'
  target: HostNativeRoomRetirementTarget
  reply: Extract<HostNativeRoomReply, { state: 'left' }>
}>
const challengeKeys = ['challenge_nonce', 'expires_at', 'binding_id', 'binding_generation']
const authorityKeys = ['host_profile_id', 'authority_environment_id', 'account_binding_handle',
  'authority_binding_version', 'account_issuer', 'account_subject', 'installation_id',
  'installation_public_key', 'host_instance_id', 'process_nonce', 'issued_at', 'signature']
const invalid = (): never => { throw Error('host_twin_group_proof_invalid') }
function parse<T>(work: () => T): T {
  try { return work() } catch { return invalid() }
}
function base64(value: unknown, bytes: number): string {
  const result = text(value, /^[A-Za-z0-9_-]+$/u)
  if (result.length !== Math.ceil(bytes * 8 / 6)) return invalid()
  const decoded = Buffer.from(result, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== result) return invalid()
  return result
}
function cursor(value: unknown): HostBoundRoomCursor | null {
  return value === null ? null : text(value, /^[A-Za-z0-9_-]{1,2048}$/u) as HostBoundRoomCursor
}
function positive(value: unknown): number {
  const result = time(value)
  return result > 0 ? result : invalid()
}
function issuer(value: unknown): string {
  const result = text(value, /^https:\/\/[!-~]{1,2040}$/u), parsed = new URL(result)
  if (parsed.origin !== result || parsed.username || parsed.password) return invalid()
  return result
}
function challenge(value: Record<string, unknown>): Challenge {
  return { challenge_nonce: base64(value.challenge_nonce, 32) as HostControlNonce,
    expires_at: positive(value.expires_at), binding_id: uuid(value.binding_id) as HostTwinGroupBindingId,
    binding_generation: version(value.binding_generation) as HostTwinGroupBindingGeneration }
}
function authority(value: Record<string, unknown>): Authority {
  return { host_profile_id: uuid(value.host_profile_id) as HostProfileId,
    authority_environment_id: uuid(value.authority_environment_id) as HostAuthorityEnvironmentId,
    account_binding_handle: id(value.account_binding_handle) as HostAccountBindingHandle,
    authority_binding_version: positive(value.authority_binding_version), account_issuer: issuer(value.account_issuer),
    account_subject: uuid(value.account_subject) as Authority['account_subject'], installation_id: uuid(value.installation_id) as InstallationId,
    installation_public_key: base64(value.installation_public_key, 32) as HostControlPublicKey,
    host_instance_id: uuid(value.host_instance_id) as HostInstanceId, process_nonce: base64(value.process_nonce, 32) as HostControlNonce,
    issued_at: time(value.issued_at), signature: base64(value.signature, 64) as HostControlSignature }
}
/** Capture only the public selection forwarded to the private Profile plugin.
 * @param value Untrusted private query.
 * @returns Detached bounded Bot and page selector.
 */
export function parseHostBoundBotRoomsQuery(value: unknown): HostBoundBotRoomsQuery {
  return parse(() => {
    const r = record(value, ['bot_id', 'limit', 'cursor'])
    if (typeof r.limit !== 'number' || !Number.isSafeInteger(r.limit) || r.limit < 1 || r.limit > 20) return invalid()
    return { bot_id: text(r.bot_id, /^[A-Za-z0-9_-]{1,200}$/u) as HostBoundRoomBotId,
      limit: r.limit, cursor: cursor(r.cursor) }
  })
}
/** Capture one exact nonce-bound inventory request, without authenticating its selector.
 * @param value Untrusted inventory target.
 * @returns Detached bounded target.
 */
export function parseHostBoundBotRoomsTarget(value: unknown): HostBoundBotRoomsTarget {
  return parse(() => {
    const r = record(value, [...challengeKeys, 'bot_id', 'limit', 'cursor'])
    return { ...challenge(r), ...parseHostBoundBotRoomsQuery({ bot_id: r.bot_id, limit: r.limit, cursor: r.cursor }) }
  })
}
/** Capture current metadata only; a non-page result is never a complete empty inventory.
 * @param value Untrusted private plugin page.
 * @returns Detached bounded page in strict room order.
 */
export function parseHostBoundBotRoomsPage(value: unknown): HostBoundBotRoomsPage {
  return parse(() => {
    // Bounded fields imply a page below16KiB; the frame codec owns the raw64KiB ceiling.
    const r = record(value, ['state', 'bot_id', 'workspace_id', 'state_revision', 'membership_snapshot', 'items', 'next_cursor'])
    if (r.state !== 'page') return invalid()
    const items = sorted(array(r.items, 20, (item) => {
      const entry = record(item, ['room_id', 'member_set_digest'])
      return { room_id: id(entry.room_id) as HostBoundRoomId, member_set_digest: digest(entry.member_set_digest) as HostControlSha256 }
    }), item => item.room_id)
    return { state: 'page', bot_id: text(r.bot_id, /^[A-Za-z0-9_-]{1,200}$/u) as HostBoundRoomBotId,
      workspace_id: uuid(r.workspace_id) as HostBoundBotRoomsPage['workspace_id'], state_revision: time(r.state_revision),
      membership_snapshot: digest(r.membership_snapshot) as HostControlSha256, items, next_cursor: cursor(r.next_cursor) }
  })
}
function resultState(value: unknown): unknown {
  if (!value || typeof value !== 'object') return invalid()
  const descriptor = Object.getOwnPropertyDescriptor(value, 'state')
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid()
  return descriptor.value
}
/** Preserve explicit private plugin failures instead of fabricating an empty page.
 * @param value Untrusted Profile-private read.
 * @returns Parsed page or fixed non-page state.
 */
export function parseHostBoundBotRoomsRead(value: unknown): HostBoundBotRoomsRead {
  return parse(() => {
    const state = resultState(value)
    if (state === 'page') return parseHostBoundBotRoomsPage(value)
    if (state !== 'bot_unavailable' && state !== 'snapshot_changed' && state !== 'upgrade_required' && state !== 'unavailable' && state !== 'invalid') return invalid()
    record(value, ['state'])
    return { state }
  })
}
/** Capture an inventory proof; its signature, nonce lifetime and current connection still require verification.
 * @param value Untrusted signed metadata.
 * @returns Canonical proof bound to the original target.
 */
export function parseHostBoundBotRoomsProof(value: unknown): HostBoundBotRoomsProof {
  return parse(() => {
    const r = record(value, ['schema_version', 'purpose', 'target', 'page', ...authorityKeys])
    if (r.schema_version !== 1 || r.purpose !== 'bound_bot_rooms') return invalid()
    const target = parseHostBoundBotRoomsTarget(r.target), page = parseHostBoundBotRoomsPage(r.page), a = authority(r)
    if (target.bot_id !== page.bot_id || page.items.length > target.limit || a.issued_at > target.expires_at ||
      page.next_cursor !== null && page.next_cursor === target.cursor) return invalid()
    return { schema_version: 1, purpose: 'bound_bot_rooms', target, page, ...a }
  })
}
/** Capture the private read result without turning a failed read into an empty page.
 * @param value Untrusted method result.
 * @returns A signed page or explicit non-page state.
 */
export function parseHostBoundBotRoomsResult(value: unknown): HostBoundBotRoomsResult {
  return parse(() => {
    const state = resultState(value)
    if (state === 'page') {
      const r = record(value, ['state', 'proof'])
      return { state, proof: parseHostBoundBotRoomsProof(r.proof) }
    }
    if (state !== 'bot_unavailable' && state !== 'snapshot_changed') return invalid()
    record(value, ['state'])
    return { state }
  })
}
function projectionCommand(value: unknown): HostRoomProjectionCommand {
  if (!value || typeof value !== 'object') return invalid()
  const operation = Object.getOwnPropertyDescriptor(value, 'operation')
  if (!operation?.enumerable || !Object.hasOwn(operation, 'value') || typeof operation.value !== 'string' || !['join', 'leave'].includes(operation.value)) return invalid()
  const r = record(value, operation.value === 'join'
    ? ['operation', 'room_id', 'group_id', 'member_id', 'cycle', 'project_id', 'agent_id', 'name']
    : ['operation', 'room_id', 'member_id', 'cycle'])
  for (const part of Object.values(r)) if (typeof part === 'string' && !part.isWellFormed()) return invalid()
  uuid(r.member_id)
  if (r.operation === 'join') uuid(r.group_id)
  // The exact operation was restricted before the shared parser captures its fields.
  return parseHostNativeRoomCommand(r) as HostRoomProjectionCommand
}
/** Capture only an original join or leave; never a model turn or a new identity.
 * @param value Untrusted projection target.
 * @returns Detached exact original command and nonce.
 */
export function parseHostNativeRoomProjectionTarget(value: unknown): HostNativeRoomProjectionTarget {
  return parse(() => {
    const r = record(value, [...challengeKeys, 'command_request_id', 'command'])
    return { ...challenge(r), command_request_id: uuid(r.command_request_id) as HostRoomProjectionCommandId,
      command: projectionCommand(r.command) }
  })
}
/** Capture a matching successful durable reply; signature and current authority are checked by its consumer.
 * @param value Untrusted projection acknowledgement.
 * @returns Canonical proof for exactly one original member cycle.
 */
export function parseHostNativeRoomProjectionProof(value: unknown): HostNativeRoomProjectionProof {
  return parse(() => {
    const r = record(value, ['schema_version', 'purpose', 'target', 'reply', ...authorityKeys])
    if (r.schema_version !== 1 || r.purpose !== 'native_room_projection') return invalid()
    const target = parseHostNativeRoomProjectionTarget(r.target), a = authority(r)
    const replyRow = record(r.reply, target.command.operation === 'join' ? ['state', 'joined_room_seq'] : ['state', 'left_room_seq'])
    const reply = parseHostNativeRoomReply(replyRow)
    if (a.issued_at > target.expires_at || !(target.command.operation === 'join' && reply.state === 'joined' || target.command.operation === 'leave' && reply.state === 'left')) return invalid()
    return { schema_version: 1, purpose: 'native_room_projection', target, reply, ...a }
  })
}
function challengeTuple(target: Challenge): readonly unknown[] {
  return [target.challenge_nonce, target.expires_at, target.binding_id, target.binding_generation]
}
function authorityTuple(proof: Authority): readonly unknown[] {
  return [proof.host_profile_id, proof.authority_environment_id, proof.account_binding_handle,
    proof.authority_binding_version, proof.account_issuer, proof.account_subject, proof.installation_id,
    proof.installation_public_key, proof.host_instance_id, proof.process_nonce, proof.issued_at]
}
/** Encode all original selector, page, Profile and peer fields under an inventory-only domain.
 * @param value Strictly captured inventory proof.
 * @returns Signature payload excluding the signature itself.
 */
export function encodeHostBoundBotRoomsProofPayload(value: HostBoundBotRoomsProof): Buffer {
  const p = parseHostBoundBotRoomsProof(value), t = p.target, page = p.page
  return Buffer.from('dsh-bound-bot-rooms/v1\0' + JSON.stringify([1, p.purpose,
    [...challengeTuple(t), t.bot_id, t.limit, t.cursor],
    [page.state, page.bot_id, page.workspace_id, page.state_revision, page.membership_snapshot,
      page.items.map(item => [item.room_id, item.member_set_digest]), page.next_cursor], authorityTuple(p)]), 'utf8')
}
/** Encode the original join/leave and exact successful reply; leave never claims a group ID.
 * @param value Strictly captured projection proof.
 * @returns Signature payload excluding the signature itself.
 */
export function encodeHostNativeRoomProjectionProofPayload(value: HostNativeRoomProjectionProof): Buffer {
  const p = parseHostNativeRoomProjectionProof(value), t = p.target, c = t.command
  const command = c.operation === 'join' ? [c.operation, c.room_id, c.group_id, c.member_id, c.cycle, c.project_id, c.agent_id, c.name]
    : [c.operation, c.room_id, c.member_id, c.cycle]
  const reply = p.reply.state === 'joined' ? [p.reply.state, p.reply.joined_room_seq] : [p.reply.state, p.reply.left_room_seq]
  return Buffer.from('dsh-native-room-projection/v1\0' + JSON.stringify([1, p.purpose,
    [...challengeTuple(t), t.command_request_id, command], reply, authorityTuple(p)]), 'utf8')
}

/** Capture the complete original join without Cloud selectors or authority.
 * @param value Untrusted private retirement command.
 * @returns Detached original join identity.
 */
export function parseHostNativeRoomRetirementCommand(value: unknown): HostNativeRoomRetirementCommand {
  return parse(() => {
    const command = projectionCommand(value)
    if (command.operation !== 'join') return invalid()
    return command
  })
}
/** Bind both original requests to one room and member cycle.
 * @param value Untrusted retirement target.
 * @returns Exact original command pair and challenge.
 */
export function parseHostNativeRoomRetirementTarget(value: unknown): HostNativeRoomRetirementTarget {
  return parse(() => {
    const r = record(value, [...challengeKeys, 'join_command_request_id', 'join_command',
      'leave_command_request_id', 'leave_command'])
    const joined = parseHostNativeRoomRetirementCommand(r.join_command)
    const left = projectionCommand(r.leave_command)
    const joinId = uuid(r.join_command_request_id) as HostRoomProjectionCommandId
    const leaveId = uuid(r.leave_command_request_id) as HostRoomProjectionCommandId
    if (left.operation !== 'leave' || joinId === leaveId || joined.room_id !== left.room_id ||
      joined.member_id !== left.member_id || joined.cycle !== left.cycle) return invalid()
    return { ...challenge(r), join_command_request_id: joinId, join_command: joined,
      leave_command_request_id: leaveId, leave_command: left }
  })
}
/** Preserve explicit missing capability without certifying an unavailable member as retired.
 * @param value Untrusted private plugin reply.
 * @returns Strict durable left or explicit failure.
 */
export function parseHostNativeRoomRetirementReply(value: unknown): HostNativeRoomRetirementReply {
  return parse(() => {
    const state = resultState(value)
    if (state === 'left') {
      const r = record(value, ['state', 'left_room_seq'])
      return { state, left_room_seq: time(r.left_room_seq) }
    }
    if (state !== 'upgrade_required' && state !== 'conflict' && state !== 'unavailable' && state !== 'invalid') return invalid()
    record(value, ['state'])
    return { state }
  })
}
/** Capture a durable cycle-closing proof; its consumer verifies signature and current authority.
 * @param value Untrusted signed retirement acknowledgement.
 * @returns Detached proof of the exact original command pair.
 */
export function parseHostNativeRoomRetirementProof(value: unknown): HostNativeRoomRetirementProof {
  return parse(() => {
    const r = record(value, ['schema_version', 'purpose', 'target', 'reply', ...authorityKeys])
    if (r.schema_version !== 1 || r.purpose !== 'native_room_retirement') return invalid()
    const target = parseHostNativeRoomRetirementTarget(r.target), a = authority(r)
    const reply = parseHostNativeRoomRetirementReply(r.reply)
    if (reply.state !== 'left' || a.issued_at > target.expires_at) return invalid()
    return { schema_version: 1, purpose: 'native_room_retirement', target, reply, ...a }
  })
}
/** Encode both original commands and the durable left boundary under the retirement-only domain.
 * @param value Strictly captured retirement proof.
 * @returns Ed25519 payload excluding its signature.
 */
export function encodeHostNativeRoomRetirementProofPayload(value: HostNativeRoomRetirementProof): Buffer {
  const p = parseHostNativeRoomRetirementProof(value), t = p.target, j = t.join_command, l = t.leave_command
  return Buffer.from('dsh-native-room-retirement/v1\0' + JSON.stringify([1, p.purpose,
    [...challengeTuple(t), t.join_command_request_id,
      [j.operation, j.room_id, j.group_id, j.member_id, j.cycle, j.project_id, j.agent_id, j.name],
      t.leave_command_request_id, [l.operation, l.room_id, l.member_id, l.cycle]],
    [p.reply.state, p.reply.left_room_seq], authorityTuple(p)]), 'utf8')
}
