/** REQ-20261028-0025: sign a friend-only registration assertion for the current Account Bot. */
import { createPrivateKey, sign } from 'node:crypto'
import { encodeHostFriendBotEnrollmentPayload,
  parseHostFriendBotEnrollmentAssertion, parseHostFriendBotEnrollmentChallenge,
  type HostFriendBotEnrollmentAssertion, type HostFriendBotEnrollmentChallenge,
} from '@deepseek-ai/dsh-host-control-protocol'
import { assertCurrentFriendProofAccountHost, resolveAccountBotIdentity,
  type FriendBotSigningInput } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

const unavailable = (): never => { throw new HostAuthorityError('profile_mismatch') }
/** Slark issues and consumes the challenge; this signs only a currently resolved Account Bot. */
export async function signAccountFriendBotEnrollment(input: FriendBotSigningInput<HostFriendBotEnrollmentChallenge>):
Promise<HostFriendBotEnrollmentAssertion> {
  input.signal.throwIfAborted()
  const c = parseHostFriendBotEnrollmentChallenge(input.challenge)
  const { account,identity } = input
  assertCurrentFriendProofAccountHost(c,account,identity,input.now())
  input.host.authorizeCollaborationRegistration(account)
  const profileId = input.host.authorizeAccountModelText(account)
  const bot = await resolveAccountBotIdentity(input.host,input.workers,account,c.bot_id,input.signal)
  input.signal.throwIfAborted()
  const after = input.now()
  if (!bot || bot.bot_id !== c.bot_id || bot.actor_ref !== `deepseek-bot:${c.bot_id}` ||
      !Number.isSafeInteger(after) || after < c.issued_at || after >= c.expires_at)
    return unavailable()
  input.host.authorizeCollaborationRegistration(account)
  if (input.host.authorizeAccountModelText(account) !== profileId) return unavailable()
  const unsigned = { schema_version:1 as const,challenge:c,bot_id:bot.bot_id,
    actor_ref:bot.actor_ref,display_name:bot.display_name,
    signature:Buffer.alloc(64).toString('base64url') }
  const parsed = parseHostFriendBotEnrollmentAssertion(unsigned)
  const key = identity.installationPrivateKey instanceof Object &&
    'type' in identity.installationPrivateKey ? identity.installationPrivateKey :
    createPrivateKey(identity.installationPrivateKey)
  const signature = sign(null,encodeHostFriendBotEnrollmentPayload(parsed),key).toString('base64url')
  input.signal.throwIfAborted()
  return parseHostFriendBotEnrollmentAssertion({ ...unsigned,signature })
}
