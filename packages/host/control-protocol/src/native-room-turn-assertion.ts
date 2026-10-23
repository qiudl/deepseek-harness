/** Installation-signed selection of Slark Agent turns from one native DS Bot room. */
import { parseHostNativeRoomReply } from './native-room-operations.js'

/** Signed Host selection for one native room turn page and Account binding. */
export interface HostNativeRoomTurnAssertion {
  readonly schema_version: 1
  readonly after_seq: number
  readonly selection: Extract<ReturnType<typeof parseHostNativeRoomReply>, { state: 'turns' }>
  readonly authority_environment_id: string
  readonly account_binding_handle: string
  readonly authority_binding_version: number
  readonly account_issuer: string
  readonly account_subject: string
  readonly installation_id: string
  readonly installation_public_key: string
  readonly host_instance_id: string
  readonly process_nonce: string
  readonly issued_at: number
  readonly signature: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'

/**
 * Strictly parse the signed page before checking the installation signature.
 * @param value - untrusted turn assertion.
 * @returns the exact assertion and selected turn page.
 */
export function parseHostNativeRoomTurnAssertion(value: unknown): HostNativeRoomTurnAssertion {
  const keys = ['schema_version', 'after_seq', 'selection', 'authority_environment_id',
    'account_binding_handle', 'authority_binding_version', 'account_issuer',
    'account_subject', 'installation_id', 'installation_public_key',
    'host_instance_id', 'process_nonce', 'issued_at', 'signature']
  if (!record(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    value.schema_version !== 1 || !Number.isSafeInteger(value.after_seq) ||
    Number(value.after_seq) < 0 || !UUID.test(String(value.authority_environment_id)) ||
    !id(value.account_binding_handle) ||
    !Number.isSafeInteger(value.authority_binding_version) ||
    Number(value.authority_binding_version) < 1 ||
    typeof value.account_issuer !== 'string' ||
    !/^https:\/\/[^\s/]+$/u.test(value.account_issuer) ||
    !UUID.test(String(value.account_subject)) || !UUID.test(String(value.installation_id)) ||
    typeof value.installation_public_key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.installation_public_key) ||
    !UUID.test(String(value.host_instance_id)) ||
    typeof value.process_nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.process_nonce) ||
    !Number.isSafeInteger(value.issued_at) || Number(value.issued_at) < 1 ||
    typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/u.test(value.signature))
    throw Error('native_room_turn_assertion_invalid')
  let selection: ReturnType<typeof parseHostNativeRoomReply>
  try { selection = parseHostNativeRoomReply(value.selection) }
  catch { throw Error('native_room_turn_assertion_invalid') }
  if (selection.state !== 'turns' || selection.next_seq < Number(value.after_seq) ||
    selection.turns.some(turn => turn.trigger_room_seq <= Number(value.after_seq)))
    throw Error('native_room_turn_assertion_invalid')
  return { schema_version: 1, after_seq: value.after_seq as number, selection,
    authority_environment_id: value.authority_environment_id as string,
    account_binding_handle: value.account_binding_handle as string,
    authority_binding_version: value.authority_binding_version as number,
    account_issuer: value.account_issuer, account_subject: value.account_subject as string,
    installation_id: value.installation_id as string,
    installation_public_key: value.installation_public_key,
    host_instance_id: value.host_instance_id as string,
    process_nonce: value.process_nonce, issued_at: value.issued_at as number,
    signature: value.signature }
}

/**
 * Encode the stable Ed25519 payload without the signature bytes.
 * @param value - validated turn assertion.
 * @returns bytes to sign or verify.
 */
export function encodeHostNativeRoomTurnAssertionPayload(value: HostNativeRoomTurnAssertion): Buffer {
  const a = parseHostNativeRoomTurnAssertion(value), s = a.selection
  return Buffer.from(`dsh-native-room-turns/v1\0${JSON.stringify([
    a.schema_version, a.after_seq, s.room_id, s.group_id, s.member_id,
    s.cycle, s.next_seq, s.turns.map(turn => [turn.turn_id,
      turn.trigger_room_seq, turn.turn_order]), a.authority_environment_id,
    a.account_binding_handle, a.authority_binding_version, a.account_issuer,
    a.account_subject, a.installation_id, a.installation_public_key,
    a.host_instance_id, a.process_nonce, a.issued_at,
  ])}`, 'utf8')
}
