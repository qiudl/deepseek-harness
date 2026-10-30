/** REQ-20261028-0025: friend-only Host proof for registering one Account Profile Bot. */
const USER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const isSlarkUserId = (v: unknown): v is string => typeof v === 'string' && USER.test(v)

export interface HostFriendBotEnrollmentChallenge {
  readonly schema_version: 1
  readonly operation: 'register_bot'
  readonly environment_id: string
  readonly authority_environment_id: string
  readonly request_id: string
  readonly owner_user_id: string
  readonly account_issuer: string
  readonly account_subject: string
  readonly profile_id: string
  readonly profile_epoch: string
  readonly identity_id: string
  readonly identity_epoch: string
  readonly binding_id: string
  readonly binding_epoch: string
  readonly computer_id: string
  readonly computer_installation_id: string
  readonly computer_authorization_version: string
  readonly host_installation_id: string
  readonly host_public_key: string
  readonly host_instance_id: string
  readonly process_nonce: string
  readonly connection_id: string
  readonly bot_id: string
  readonly issued_at: number
  readonly expires_at: number
  readonly nonce: string
}
export interface HostFriendBotEnrollmentAssertion {
  readonly schema_version: 1
  readonly challenge: HostFriendBotEnrollmentChallenge
  readonly bot_id: string
  readonly actor_ref: string
  readonly display_name: string
  readonly signature: string
}
const FIELDS = [
  'schema_version','operation','environment_id','authority_environment_id','request_id','owner_user_id',
  'account_issuer','account_subject','profile_id','profile_epoch','identity_id',
  'identity_epoch','binding_id','binding_epoch','computer_id','computer_installation_id',
  'computer_authorization_version','host_installation_id','host_public_key',
  'host_instance_id','process_nonce','connection_id','bot_id','issued_at','expires_at','nonce',
] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^[1-9][0-9]{0,18}$/u
const ENV = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const BOT = /^[A-Za-z0-9_-]{1,200}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u
const fail = (): never => { throw Error('invalid_friend_bot_enrollment') }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length)
    return fail()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (keys.some(key => !fields[key]?.enumerable || !('value' in fields[key]))) return fail()
  return Object.fromEntries(keys.map(key => [key, fields[key]?.value]))
}
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const version = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v) &&
  BigInt(v) <= 9223372036854775807n
const opaque = (v: unknown, max = 256): v is string => typeof v === 'string' &&
  v.length <= max && OPAQUE.test(v)
function raw(v: unknown, length: number): v is string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(v)) return false
  const bytes = Buffer.from(v,'base64url')
  return bytes.length === length && bytes.toString('base64url') === v
}
function origin(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false
  try { const url = new URL(v); return url.protocol === 'https:' && url.origin === v }
  catch { return false }
}
function name(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v === v.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(v) && Buffer.byteLength(v,'utf8') <= 512
}
export function parseHostFriendBotEnrollmentChallenge(value: unknown): HostFriendBotEnrollmentChallenge {
  const r = exact(value,FIELDS)
  if (r.schema_version !== 1 || r.operation !== 'register_bot' ||
      typeof r.environment_id !== 'string' || !ENV.test(r.environment_id) ||
      !isSlarkUserId(r.owner_user_id) || !origin(r.account_issuer) ||
      !opaque(r.binding_id) || !opaque(r.computer_id) ||
      !opaque(r.computer_installation_id,128) ||
      typeof r.bot_id !== 'string' || !BOT.test(r.bot_id) ||
      !['authority_environment_id','request_id','account_subject','profile_id','identity_id','host_installation_id',
        'host_instance_id','connection_id'].every(key => uuid(r[key])) ||
      !['profile_epoch','identity_epoch','binding_epoch','computer_authorization_version']
        .every(key => version(r[key])) ||
      !raw(r.host_public_key,32) || !raw(r.process_nonce,32) || !raw(r.nonce,32) ||
      !Number.isSafeInteger(r.issued_at) || Number(r.issued_at) < 0 ||
      !Number.isSafeInteger(r.expires_at) || Number(r.expires_at) <= Number(r.issued_at) ||
      Number(r.expires_at)-Number(r.issued_at) > 10_000) return fail()
  return Object.freeze(r) as unknown as HostFriendBotEnrollmentChallenge
}
export function parseHostFriendBotEnrollmentAssertion(value: unknown): HostFriendBotEnrollmentAssertion {
  const r = exact(value,['schema_version','challenge','bot_id','actor_ref','display_name','signature'])
  const challenge = parseHostFriendBotEnrollmentChallenge(r.challenge)
  if (r.schema_version !== 1 || r.bot_id !== challenge.bot_id ||
      r.actor_ref !== `deepseek-bot:${challenge.bot_id}` || !name(r.display_name) ||
      !raw(r.signature,64)) return fail()
  return Object.freeze({ schema_version:1,challenge,bot_id:challenge.bot_id,
    actor_ref:r.actor_ref,display_name:r.display_name,signature:r.signature })
}
/** Signed bytes include the Host-supplied exact public name and a distinct operation domain. */
export function encodeHostFriendBotEnrollmentPayload(value: unknown): Buffer {
  const a = parseHostFriendBotEnrollmentAssertion(value)
  return Buffer.from('slark-dsh-friend-bot-enrollment/v1\0'+JSON.stringify([
    ...FIELDS.map(key => a.challenge[key]),a.bot_id,a.actor_ref,a.display_name]),'utf8')
}
