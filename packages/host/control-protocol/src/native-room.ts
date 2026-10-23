/** Bounded Source coordinates for one existing DS Bot room. */
export interface HostNativeRoomSource {
  readonly room_id: string
  readonly source: {
    readonly workspace_id: string
    readonly session_id: string
    readonly source_message_id: string
    readonly source_revision: '1'
  }
}

/** Installation-signed room-to-bridge Source observed in one Account Profile. */
export interface HostNativeRoomAssertion {
  readonly schema_version: 1
  readonly binding: HostNativeRoomSource
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

const id = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
const workspace = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/**
 * Parse one caller-selected native room ID without Profile or chat coordinates.
 * @param value - Exact room target from an untrusted caller.
 * @returns Bounded room ID.
 */
export function parseHostNativeRoomTarget(value: unknown): { readonly room_id: string } {
  if (!record(value) || Object.keys(value).join(',') !== 'room_id' || !id(value.room_id))
    throw Error('native_room_target_invalid')
  return { room_id: value.room_id }
}

/**
 * Reject a room Session reused as a Slark bridge or any extra Profile fields.
 * @param value - Private Profile service reply.
 * @returns Bounded Source coordinates for the requested room.
 */
export function parseHostNativeRoomSource(value: unknown): HostNativeRoomSource {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'room_id,source' ||
    !id(value.room_id) || !record(value.source) ||
    Object.keys(value.source).sort().join(',') !==
      'session_id,source_message_id,source_revision,workspace_id' ||
    !workspace(value.source.workspace_id) || !id(value.source.session_id) ||
    value.source.session_id === value.room_id || !id(value.source.source_message_id) ||
    value.source.source_revision !== '1') throw Error('native_room_source_invalid')
  return { room_id: value.room_id, source: {
    workspace_id: value.source.workspace_id, session_id: value.source.session_id,
    source_message_id: value.source.source_message_id, source_revision: '1',
  } }
}

/**
 * Validate the exact signed room assertion without trusting its signature.
 * @param value - Untrusted Host result.
 * @returns Bounded assertion fields.
 */
export function parseHostNativeRoomAssertion(value: unknown): HostNativeRoomAssertion {
  const keys = ['schema_version', 'binding', 'authority_environment_id', 'account_binding_handle',
    'authority_binding_version', 'account_issuer', 'account_subject', 'installation_id',
    'installation_public_key', 'host_instance_id', 'process_nonce', 'issued_at', 'signature']
  if (!record(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    value.schema_version !== 1 || !workspace(value.authority_environment_id) ||
    !id(value.account_binding_handle) || !Number.isSafeInteger(value.authority_binding_version) ||
    Number(value.authority_binding_version) < 1 ||
    typeof value.account_issuer !== 'string' ||
    !/^https:\/\/[^\s/]+$/u.test(value.account_issuer) ||
    !workspace(value.account_subject) || !workspace(value.installation_id) ||
    typeof value.installation_public_key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.installation_public_key) ||
    !workspace(value.host_instance_id) || typeof value.process_nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.process_nonce) ||
    !Number.isSafeInteger(value.issued_at) || Number(value.issued_at) < 1 ||
    typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(value.signature))
    throw Error('native_room_assertion_invalid')
  return { schema_version: 1, binding: parseHostNativeRoomSource(value.binding),
    authority_environment_id: value.authority_environment_id,
    account_binding_handle: value.account_binding_handle,
    authority_binding_version: value.authority_binding_version as number,
    account_issuer: value.account_issuer, account_subject: value.account_subject,
    installation_id: value.installation_id, installation_public_key: value.installation_public_key,
    host_instance_id: value.host_instance_id, process_nonce: value.process_nonce,
    issued_at: value.issued_at as number, signature: value.signature }
}

/**
 * Encode the stable room assertion bytes shared with Slark's verifier.
 * @param value - Strictly parsed assertion, excluding its signature from the bytes.
 * @returns Ed25519 payload for this operation only.
 */
export function encodeHostNativeRoomAssertionPayload(value: HostNativeRoomAssertion): Buffer {
  const a = parseHostNativeRoomAssertion(value), s = a.binding.source
  return Buffer.from(`dsh-native-room-binding/v1\0${JSON.stringify([
    a.schema_version, a.binding.room_id, s.workspace_id, s.session_id,
    s.source_message_id, s.source_revision, a.authority_environment_id,
    a.account_binding_handle, a.authority_binding_version, a.account_issuer,
    a.account_subject, a.installation_id, a.installation_public_key,
    a.host_instance_id, a.process_nonce, a.issued_at,
  ])}`, 'utf8')
}
