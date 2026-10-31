/** Shared, strict coordinates for one-use Slark friend proofs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const VERSION = /^[1-9][0-9]{0,18}$/u
const ENV = /^[a-z0-9][a-z0-9_-]{0,127}$/u
const USER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u

/** Account, Profile, Computer, and Host coordinates shared by friend proof challenges. */
export interface HostFriendProofCoreChallenge {
  readonly schema_version: 1
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
  readonly issued_at: number
  readonly expires_at: number
  readonly nonce: string
}

/** Ordered fields shared by the enrollment and online lease signature tuples. */
export const FRIEND_PROOF_CORE_FIELDS = [
  'schema_version','operation','environment_id','authority_environment_id','request_id','owner_user_id',
  'account_issuer','account_subject','profile_id','profile_epoch','identity_id','identity_epoch',
  'binding_id','binding_epoch','computer_id','computer_installation_id',
  'computer_authorization_version','host_installation_id','host_public_key','host_instance_id',
  'process_nonce','connection_id',
] as const

/**
 * Read an exact plain record without invoking accessors or accepting hidden fields.
 * @param value - untrusted record.
 * @param keys - required own field names.
 * @param fail - caller-specific rejection function.
 * @returns a detached record containing the ordered field values.
 */
export function exactFriendProofRecord(value: unknown, keys: readonly string[], fail: () => never): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length)
    return fail()
  const fields = Object.getOwnPropertyDescriptors(value)
  if (keys.some(key => !fields[key]?.enumerable || !('value' in fields[key]))) return fail()
  return Object.fromEntries(keys.map(key => [key, fields[key]?.value]))
}

/**
 * Check a canonical UUID coordinate.
 * @param v - untrusted value.
 * @returns whether the value is a canonical UUID.
 */
export const friendProofUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
/**
 * Check a positive signed 64-bit generation.
 * @param v - untrusted value.
 * @returns whether the value is a canonical generation.
 */
export const friendProofVersion = (v: unknown): v is string => typeof v === 'string' &&
  VERSION.test(v) && BigInt(v) <= 9223372036854775807n
/**
 * Check exact unpadded base64url key or nonce bytes.
 * @param v - untrusted value.
 * @param length - required byte length.
 * @returns whether the value has the required canonical encoding.
 */
export function friendProofRaw(v: unknown, length: number): v is string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(v)) return false
  const bytes = Buffer.from(v,'base64url')
  return bytes.length === length && bytes.toString('base64url') === v
}

function friendProofOrigin(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2048) return false
  try { const url = new URL(v); return url.protocol === 'https:' && url.origin === v }
  catch { return false }
}

const friendProofOpaque = (v: unknown, max = 256): boolean => typeof v === 'string' &&
  v.length <= max && OPAQUE.test(v)

/**
 * Validate shared Account, Profile, Computer, Host, and time coordinates.
 * @param r - detached challenge record.
 * @returns whether every shared coordinate is valid.
 */
export function validFriendProofCore(r: Record<string,unknown>): boolean {
  return r.schema_version === 1 && typeof r.environment_id === 'string' && ENV.test(r.environment_id) &&
    typeof r.owner_user_id === 'string' && USER.test(r.owner_user_id) && friendProofOrigin(r.account_issuer) &&
    friendProofOpaque(r.binding_id) && friendProofOpaque(r.computer_id) &&
    friendProofOpaque(r.computer_installation_id,128) &&
    ['authority_environment_id','request_id','account_subject','profile_id','identity_id',
      'host_installation_id','host_instance_id','connection_id'].every(key => friendProofUuid(r[key])) &&
    ['profile_epoch','identity_epoch','binding_epoch','computer_authorization_version']
      .every(key => friendProofVersion(r[key])) &&
    friendProofRaw(r.host_public_key,32) && friendProofRaw(r.process_nonce,32) && friendProofRaw(r.nonce,32) &&
    Number.isSafeInteger(r.issued_at) && Number(r.issued_at) >= 0 &&
    Number.isSafeInteger(r.expires_at) && Number(r.expires_at) > Number(r.issued_at) &&
    Number(r.expires_at)-Number(r.issued_at) <= 10_000
}
