/** REQ-20261028-0025 Task 25613: Host-signed issue/renew proof, separate from Bot enrollment. */
import { exactFriendProofRecord, FRIEND_PROOF_CORE_FIELDS, friendProofRaw,
  friendProofUuid, friendProofVersion, type HostFriendProofCoreChallenge,
  validFriendProofCore } from './friend-proof-common.ts'

/** Slark's one-use issue or renewal challenge bound to a current Host socket. */
export interface HostFriendOnlineLeaseChallenge extends HostFriendProofCoreChallenge {
  readonly operation: 'issue' | 'renew'
  readonly device_id: string
  readonly key_epoch: string
  readonly expected_lease_epoch: string
}
/** Installation-key signature over one exact online lease challenge. */
export interface HostFriendOnlineLeaseAssertion {
  readonly schema_version: 1
  readonly challenge: HostFriendOnlineLeaseChallenge
  readonly signature: string
}
const FIELDS = [
  ...FRIEND_PROOF_CORE_FIELDS,'device_id','key_epoch','expected_lease_epoch',
  'issued_at','expires_at','nonce',
] as const
const fail = (): never => { throw Error('invalid_friend_online_lease_proof') }
function assertHostFriendOnlineLeaseChallenge(
  r: Record<string,unknown>,
): asserts r is Record<string,unknown> & HostFriendOnlineLeaseChallenge {
  if (!validFriendProofCore(r) || (r.operation !== 'issue' && r.operation !== 'renew') ||
      !friendProofUuid(r.device_id) || !friendProofVersion(r.key_epoch) ||
      !(r.expected_lease_epoch === '0' || friendProofVersion(r.expected_lease_epoch)) ||
      (r.operation === 'issue') !== (r.expected_lease_epoch === '0')) return fail()
}
/**
 * Validate the exact issue or renewal challenge before Host signing.
 * @param value - untrusted challenge received by the Host.
 * @returns the validated challenge.
 */
export function parseHostFriendOnlineLeaseChallenge(value: unknown): HostFriendOnlineLeaseChallenge {
  const r = exactFriendProofRecord(value,FIELDS,fail)
  assertHostFriendOnlineLeaseChallenge(r)
  return Object.freeze(r)
}
/**
 * Validate a Host lease response without accepting its signature as authority.
 * @param value - untrusted Host response.
 * @returns the structurally valid assertion for signature verification.
 */
export function parseHostFriendOnlineLeaseAssertion(value: unknown): HostFriendOnlineLeaseAssertion {
  const r = exactFriendProofRecord(value,['schema_version','challenge','signature'],fail)
  const challenge = parseHostFriendOnlineLeaseChallenge(r.challenge)
  if (r.schema_version !== 1 || !friendProofRaw(r.signature,64)) return fail()
  return Object.freeze({ schema_version:1,challenge,signature:r.signature })
}
/**
 * Encode the lease signature domain and ordered challenge fields.
 * @param value - the assertion whose challenge is signed.
 * @returns canonical signature bytes.
 */
export function encodeHostFriendOnlineLeasePayload(value: unknown): Buffer {
  const assertion = parseHostFriendOnlineLeaseAssertion(value)
  return Buffer.from('slark-dsh-friend-online-lease/v1\0'+JSON.stringify(
    FIELDS.map(key => assertion.challenge[key])),'utf8')
}
