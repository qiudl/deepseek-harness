/** REQ-20261028-0025: friend-only Host proof for registering one Account Profile Bot. */
import { exactFriendProofRecord, FRIEND_PROOF_CORE_FIELDS, friendProofRaw,
  type HostFriendProofCoreChallenge, validFriendProofCore } from './friend-proof-common.ts'

/** Slark's one-use challenge for publishing a current Account Profile Bot. */
export interface HostFriendBotEnrollmentChallenge extends HostFriendProofCoreChallenge {
  readonly operation: 'register_bot'
  readonly bot_id: string
}
/** Host-signed Bot identity and public name bound to the enrollment challenge. */
export interface HostFriendBotEnrollmentAssertion {
  readonly schema_version: 1
  readonly challenge: HostFriendBotEnrollmentChallenge
  readonly bot_id: string
  readonly actor_ref: string
  readonly display_name: string
  readonly signature: string
}
const FIELDS = [
  ...FRIEND_PROOF_CORE_FIELDS,'bot_id','issued_at','expires_at','nonce',
] as const
const BOT = /^[A-Za-z0-9_-]{1,200}$/u
const fail = (): never => { throw Error('invalid_friend_bot_enrollment') }
function name(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v === v.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(v) && Buffer.byteLength(v,'utf8') <= 512
}
function assertHostFriendBotEnrollmentChallenge(
  r: Record<string,unknown>,
): asserts r is Record<string,unknown> & HostFriendBotEnrollmentChallenge {
  if (!validFriendProofCore(r) || r.operation !== 'register_bot' ||
      typeof r.bot_id !== 'string' || !BOT.test(r.bot_id)) return fail()
}
/**
 * Validate the exact enrollment challenge fields and their bounded values.
 * @param value - untrusted challenge received by the Host.
 * @returns the validated challenge.
 */
export function parseHostFriendBotEnrollmentChallenge(value: unknown): HostFriendBotEnrollmentChallenge {
  const r = exactFriendProofRecord(value,FIELDS,fail)
  assertHostFriendBotEnrollmentChallenge(r)
  return Object.freeze(r)
}
/**
 * Validate a signed enrollment response without granting registration authority.
 * @param value - untrusted Host response.
 * @returns the structurally valid assertion for signature verification.
 */
export function parseHostFriendBotEnrollmentAssertion(value: unknown): HostFriendBotEnrollmentAssertion {
  const r = exactFriendProofRecord(value,['schema_version','challenge','bot_id','actor_ref','display_name','signature'],fail)
  const challenge = parseHostFriendBotEnrollmentChallenge(r.challenge)
  if (r.schema_version !== 1 || r.bot_id !== challenge.bot_id ||
      r.actor_ref !== `deepseek-bot:${challenge.bot_id}` || !name(r.display_name) ||
      !friendProofRaw(r.signature,64)) return fail()
  return Object.freeze({ schema_version:1,challenge,bot_id:challenge.bot_id,
    actor_ref:r.actor_ref,display_name:r.display_name,signature:r.signature })
}
/**
 * Encode the enrollment signature domain, challenge, Bot identity and public name.
 * @param value - the assertion whose exact fields are signed.
 * @returns canonical signature bytes.
 */
export function encodeHostFriendBotEnrollmentPayload(value: unknown): Buffer {
  const a = parseHostFriendBotEnrollmentAssertion(value)
  return Buffer.from('slark-dsh-friend-bot-enrollment/v1\0'+JSON.stringify([
    ...FIELDS.map(key => a.challenge[key]),a.bot_id,a.actor_ref,a.display_name]),'utf8')
}
