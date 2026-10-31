/** REQ-20261028-0025: Host counterpart of Slark's fixed friend Bot confirmation tuple. */
export interface HostFriendBotConfirmationChallenge {
  readonly schema_version: 1
  readonly role: 'inviter' | 'applicant'
  readonly environment_id: string
  readonly invite_id: string
  readonly invite_version: string
  readonly application_id: string
  readonly application_version: string
  readonly owner_user_id: string
  readonly account_issuer: string
  readonly account_subject: string
  readonly profile_id: string
  readonly profile_epoch: string
  readonly identity_id: string
  readonly identity_epoch: string
  readonly binding_id: string
  readonly binding_epoch: string
  readonly bot_ref: string
  readonly bot_epoch: string
  readonly bot_id: string
  readonly device_id: string
  readonly key_epoch: string
  readonly certificate_fingerprint: string
  readonly computer_id: string
  readonly computer_installation_id: string
  readonly computer_authorization_version: string
  readonly host_installation_id: string
  readonly host_public_key: string
  readonly host_instance_id: string
  readonly process_nonce: string
  readonly connection_id: string
  readonly account_display_version: string
  readonly bot_display_version: string
  readonly display_name_digest: string
  readonly issued_at: number
  readonly expires_at: number
  readonly nonce: string
}
/** One signed copy of the exact Slark-issued challenge. */
export interface HostFriendBotConfirmationAssertion {
  readonly schema_version: 1
  readonly challenge: HostFriendBotConfirmationChallenge
  readonly signature: string
}
const FIELDS = ['schema_version','role','environment_id','invite_id','invite_version',
  'application_id','application_version','owner_user_id','account_issuer','account_subject',
  'profile_id','profile_epoch','identity_id','identity_epoch','binding_id','binding_epoch',
  'bot_ref','bot_epoch','bot_id','device_id','key_epoch','certificate_fingerprint',
  'computer_id','computer_installation_id','computer_authorization_version',
  'host_installation_id','host_public_key','host_instance_id','process_nonce','connection_id',
  'account_display_version','bot_display_version','display_name_digest',
  'issued_at','expires_at','nonce'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^[1-9][0-9]{0,18}$/u
const USER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const ENV = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const BOT = /^[A-Za-z0-9_-]{1,200}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u
const fail = (): never => { throw Error('invalid_friend_bot_confirmation') }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return fail()
  const properties = Object.getOwnPropertyDescriptors(value)
  if (keys.some((key) => {
    const descriptor = properties[key]
    return !descriptor || !descriptor.enumerable || !('value' in descriptor)
  })) return fail()
  return Object.fromEntries(keys.map(key => [key, properties[key]?.value]))
}
function matched(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail()
  return value
}
function bounded(value: unknown, maximum = 256): string {
  const text = matched(value, OPAQUE)
  if (text.length > maximum) return fail()
  return text
}
function version(value: unknown): string {
  const text = matched(value, VERSION)
  if (BigInt(text) > 9223372036854775807n) return fail()
  return text
}
function bytes(value: unknown, length: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return fail()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== length || decoded.toString('base64url') !== value) return fail()
  return value
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return fail()
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== value) return fail()
    return value
  } catch { return fail() }
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return fail()
  return Number(value)
}
/**
 * Parse one exact server challenge; issuance and one-time use remain Slark responsibilities.
 * @param value - Untrusted challenge value.
 * @returns Frozen challenge with validated fields.
 */
export function parseHostFriendBotConfirmationChallenge(value: unknown): HostFriendBotConfirmationChallenge {
  const r = exact(value, FIELDS)
  const issuedAt = timestamp(r.issued_at), expiresAt = timestamp(r.expires_at)
  if (r.schema_version !== 1 || (r.role !== 'inviter' && r.role !== 'applicant') ||
    expiresAt <= issuedAt || expiresAt-issuedAt > 10_000) return fail()
  return Object.freeze({ schema_version: 1, role: r.role,
    environment_id: matched(r.environment_id, ENV), invite_id: matched(r.invite_id, UUID),
    invite_version: version(r.invite_version), application_id: matched(r.application_id, UUID),
    application_version: version(r.application_version), owner_user_id: matched(r.owner_user_id, USER),
    account_issuer: origin(r.account_issuer), account_subject: matched(r.account_subject, UUID),
    profile_id: matched(r.profile_id, UUID), profile_epoch: version(r.profile_epoch),
    identity_id: matched(r.identity_id, UUID), identity_epoch: version(r.identity_epoch),
    binding_id: bounded(r.binding_id), binding_epoch: version(r.binding_epoch),
    bot_ref: matched(r.bot_ref, UUID), bot_epoch: version(r.bot_epoch), bot_id: matched(r.bot_id, BOT),
    device_id: matched(r.device_id, UUID), key_epoch: version(r.key_epoch),
    certificate_fingerprint: matched(r.certificate_fingerprint, DIGEST),
    computer_id: bounded(r.computer_id), computer_installation_id: bounded(r.computer_installation_id, 128),
    computer_authorization_version: version(r.computer_authorization_version),
    host_installation_id: matched(r.host_installation_id, UUID), host_public_key: bytes(r.host_public_key, 32),
    host_instance_id: matched(r.host_instance_id, UUID), process_nonce: bytes(r.process_nonce, 32),
    connection_id: matched(r.connection_id, UUID),
    account_display_version: version(r.account_display_version),
    bot_display_version: version(r.bot_display_version),
    display_name_digest: matched(r.display_name_digest, DIGEST),
    issued_at: issuedAt, expires_at: expiresAt, nonce: bytes(r.nonce, 32) })
}
/**
 * Parse an exact assertion and canonical Ed25519 signature.
 * @param value - Untrusted assertion value.
 * @returns Frozen assertion with a validated challenge.
 */
export function parseHostFriendBotConfirmationAssertion(value: unknown): HostFriendBotConfirmationAssertion {
  const r = exact(value, ['schema_version','challenge','signature'])
  if (r.schema_version !== 1) return fail()
  return Object.freeze({ schema_version: 1,
    challenge: parseHostFriendBotConfirmationChallenge(r.challenge), signature: bytes(r.signature, 64) })
}
/**
 * Encode Slark's exact signing domain and tuple order without the signature.
 * @param value - Validated or untrusted challenge value.
 * @returns Bytes signed by the installation Ed25519 key.
 */
export function encodeHostFriendBotConfirmationPayload(value: HostFriendBotConfirmationChallenge): Uint8Array {
  const c = parseHostFriendBotConfirmationChallenge(value)
  return Buffer.from('slark-dsh-friend-bot-confirmation/v1\0'+JSON.stringify(FIELDS.map(key => c[key])), 'utf8')
}
