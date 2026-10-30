/** REQ-20261028-0025: sign a friend-only registration assertion for the current Account Bot. */
import { createPrivateKey, sign } from 'node:crypto'
import { encodeHostFriendBotEnrollmentPayload,
  parseHostFriendBotEnrollmentAssertion, parseHostFriendBotEnrollmentChallenge,
  type HostFriendBotEnrollmentAssertion, type HostFriendBotEnrollmentChallenge,
} from '@deepseek-ai/dsh-host-control-protocol'
import { resolveAccountBotIdentity, type FriendBotSigningInput } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

const unavailable = (): never => { throw new HostAuthorityError('profile_mismatch') }
/** Slark issues and consumes the challenge; this signs only a currently resolved Account Bot. */
export async function signAccountFriendBotEnrollment(input: FriendBotSigningInput<HostFriendBotEnrollmentChallenge>):
Promise<HostFriendBotEnrollmentAssertion> {
  input.signal.throwIfAborted()
  const c = parseHostFriendBotEnrollmentChallenge(input.challenge)
  const { account,identity } = input
  const before = input.now()
  if (!Number.isSafeInteger(before) || before < c.issued_at || before >= c.expires_at ||
      c.owner_user_id !== account.ownerId ||
      c.authority_environment_id !== account.authorityEnvironmentId ||
      c.binding_id !== account.accountBindingHandle ||
      c.binding_epoch !== String(account.authorityBindingVersion) ||
      c.account_issuer !== account.issuer || c.account_subject !== account.subject ||
      c.host_installation_id !== identity.installationId ||
      c.host_public_key !== identity.installationPublicKey ||
      c.host_instance_id !== identity.hostInstanceId || c.process_nonce !== identity.processNonce)
    return unavailable()
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
