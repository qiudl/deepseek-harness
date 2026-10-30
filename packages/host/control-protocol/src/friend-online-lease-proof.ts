/** REQ-20261028-0025 Task 25613: Host-signed issue/renew proof, separate from Bot enrollment. */
const USER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const isSlarkUserId = (v: unknown): v is string => typeof v === 'string' && USER.test(v)

export interface HostFriendOnlineLeaseChallenge {
  readonly schema_version: 1
  readonly operation: 'issue' | 'renew'
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
  readonly device_id: string
  readonly key_epoch: string
  readonly expected_lease_epoch: string
  readonly issued_at: number
  readonly expires_at: number
  readonly nonce: string
}
export interface HostFriendOnlineLeaseAssertion {
  readonly schema_version: 1
  readonly challenge: HostFriendOnlineLeaseChallenge
  readonly signature: string
}
const FIELDS = [
  'schema_version','operation','environment_id','authority_environment_id','request_id','owner_user_id',
  'account_issuer','account_subject','profile_id','profile_epoch','identity_id','identity_epoch',
  'binding_id','binding_epoch','computer_id','computer_installation_id',
  'computer_authorization_version','host_installation_id','host_public_key','host_instance_id',
  'process_nonce','connection_id','device_id','key_epoch','expected_lease_epoch',
  'issued_at','expires_at','nonce',
] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^[1-9][0-9]{0,18}$/u
const ENV = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u
const fail = (): never => { throw Error('invalid_friend_online_lease_proof') }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length)
    return fail()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (keys.some((key) => { const field = fields[key]
    return !field?.enumerable || !('value' in field) })) return fail()
  return Object.fromEntries(keys.map(key => [key, fields[key]?.value]))
}
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const version = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v) &&
  BigInt(v) <= 9223372036854775807n
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
function assertHostFriendOnlineLeaseChallenge(
  r: Record<string,unknown>,
): asserts r is Record<string,unknown> & HostFriendOnlineLeaseChallenge {
  if (r.schema_version !== 1 || (r.operation !== 'issue' && r.operation !== 'renew') ||
      typeof r.environment_id !== 'string' || !ENV.test(r.environment_id) ||
      !isSlarkUserId(r.owner_user_id) || !origin(r.account_issuer) ||
      typeof r.binding_id !== 'string' || !OPAQUE.test(r.binding_id) ||
      typeof r.computer_id !== 'string' || !OPAQUE.test(r.computer_id) ||
      typeof r.computer_installation_id !== 'string' || r.computer_installation_id.length>128 ||
      !OPAQUE.test(r.computer_installation_id) ||
      !['authority_environment_id','request_id','account_subject','profile_id','identity_id',
        'host_installation_id','host_instance_id','connection_id','device_id'].every(key => uuid(r[key])) ||
      !['profile_epoch','identity_epoch','binding_epoch','computer_authorization_version','key_epoch']
        .every(key => version(r[key])) ||
      !(r.expected_lease_epoch === '0' || version(r.expected_lease_epoch)) ||
      (r.operation === 'issue') !== (r.expected_lease_epoch === '0') ||
      !raw(r.host_public_key,32) || !raw(r.process_nonce,32) || !raw(r.nonce,32) ||
      !Number.isSafeInteger(r.issued_at) || Number(r.issued_at)<0 ||
      !Number.isSafeInteger(r.expires_at) || Number(r.expires_at)<=Number(r.issued_at) ||
      Number(r.expires_at)-Number(r.issued_at)>10_000) return fail()
}
export function parseHostFriendOnlineLeaseChallenge(value: unknown): HostFriendOnlineLeaseChallenge {
  const r = exact(value,FIELDS)
  assertHostFriendOnlineLeaseChallenge(r)
  return Object.freeze(r)
}
export function parseHostFriendOnlineLeaseAssertion(value: unknown): HostFriendOnlineLeaseAssertion {
  const r = exact(value,['schema_version','challenge','signature'])
  const challenge = parseHostFriendOnlineLeaseChallenge(r.challenge)
  if (r.schema_version !== 1 || !raw(r.signature,64)) return fail()
  return Object.freeze({ schema_version:1,challenge,signature:r.signature }) as HostFriendOnlineLeaseAssertion
}
export function encodeHostFriendOnlineLeasePayload(value: unknown): Buffer {
  const assertion = parseHostFriendOnlineLeaseAssertion(value)
  return Buffer.from('slark-dsh-friend-online-lease/v1\0'+JSON.stringify(
    FIELDS.map(key => assertion.challenge[key])),'utf8')
}
