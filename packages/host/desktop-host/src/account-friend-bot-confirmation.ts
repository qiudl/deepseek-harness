/** REQ-20261028-0025: sign one current Account Bot for a friend-only Slark challenge. */
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { encodeHostFriendBotConfirmationPayload,
  parseHostFriendBotConfirmationAssertion, parseHostFriendBotConfirmationChallenge,
  type HostFriendBotConfirmationAssertion,
  type HostFriendBotConfirmationChallenge } from '@deepseek-ai/dsh-host-control-protocol'
import { resolveAccountBotIdentity, type FriendBotSigningInput } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

const unavailable = (): never => { throw new HostAuthorityError('profile_mismatch') }
/**
 * Sign the current Account Bot only after a trusted Profile worker confirms its identity.
 * Slark owns challenge issuance, nonce consumption, route checks and the final write.
 * @param input - Current Host authority, Account grant, challenged Bot and installation key.
 * @returns Signed assertion for Slark to verify against its current server state.
 */
export async function signAccountFriendBotConfirmation(
  input: FriendBotSigningInput<HostFriendBotConfirmationChallenge>,
): Promise<HostFriendBotConfirmationAssertion> {
  input.signal.throwIfAborted()
  const c = parseHostFriendBotConfirmationChallenge(input.challenge)
  const { account, identity } = input
  const currentTime = input.now()
  const withinChallenge = Number.isSafeInteger(currentTime) &&
    currentTime >= c.issued_at && currentTime < c.expires_at
  const boundToAccount = [
    [c.owner_user_id, account.ownerId],
    [c.binding_id, account.accountBindingHandle],
    [c.binding_epoch, String(account.authorityBindingVersion)],
    [c.account_issuer, account.issuer],
    [c.account_subject, account.subject],
  ].every(([actual, expected]) => actual === expected)
  const boundToHost = [
    [c.host_installation_id, identity.installationId],
    [c.host_public_key, identity.installationPublicKey],
    [c.host_instance_id, identity.hostInstanceId],
    [c.process_nonce, identity.processNonce],
  ].every(([actual, expected]) => actual === expected)
  if (!withinChallenge || !boundToAccount || !boundToHost)
    return unavailable()
  input.host.authorizeCollaborationRegistration(account)
  const profileId = input.host.authorizeAccountModelText(account)
  const bot = await resolveAccountBotIdentity(input.host, input.workers, account, c.bot_id, input.signal)
  input.signal.throwIfAborted()
  const afterReadTime = input.now()
  if (!bot || bot.bot_id !== c.bot_id || bot.actor_ref !== `deepseek-bot:${c.bot_id}` ||
    createHash('sha256').update(bot.display_name, 'utf8').digest('hex') !== c.display_name_digest ||
    !Number.isSafeInteger(afterReadTime) || afterReadTime < c.issued_at || afterReadTime >= c.expires_at)
    return unavailable()
  input.host.authorizeCollaborationRegistration(account)
  if (input.host.authorizeAccountModelText(account) !== profileId) return unavailable()
  const key = identity.installationPrivateKey instanceof Object &&
    'type' in identity.installationPrivateKey ? identity.installationPrivateKey :
    createPrivateKey(identity.installationPrivateKey)
  const signature = sign(null, encodeHostFriendBotConfirmationPayload(c), key).toString('base64url')
  input.signal.throwIfAborted()
  return parseHostFriendBotConfirmationAssertion({ schema_version: 1, challenge: c, signature })
}
