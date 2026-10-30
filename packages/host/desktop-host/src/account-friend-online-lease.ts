/** REQ-20261028-0025: sign only a current Account's friend device lease challenge. */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { encodeHostFriendOnlineLeasePayload, parseHostFriendOnlineLeaseAssertion,
  parseHostFriendOnlineLeaseChallenge, type HostFriendOnlineLeaseAssertion,
  type HostFriendOnlineLeaseChallenge } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import { HostAuthorityError } from './types.ts'

interface SigningIdentity {
  readonly installationId: string
  readonly installationPublicKey: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly installationPrivateKey: KeyObject | string | Buffer
}
interface SigningInput {
  readonly host: Pick<DesktopHost, 'authorizeCollaborationRegistration'>
  readonly account: BotIdentityAccount
  readonly challenge: HostFriendOnlineLeaseChallenge
  readonly identity: SigningIdentity
  readonly signal: AbortSignal
  readonly now: () => number
}
const unavailable = (): never => { throw new HostAuthorityError('profile_mismatch') }
export function signAccountFriendOnlineLease(input: SigningInput): HostFriendOnlineLeaseAssertion {
  input.signal.throwIfAborted()
  const c = parseHostFriendOnlineLeaseChallenge(input.challenge)
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
  const after = input.now()
  if (!Number.isSafeInteger(after) || after < c.issued_at || after >= c.expires_at)
    return unavailable()
  input.host.authorizeCollaborationRegistration(account)
  const unsigned = { schema_version:1 as const,challenge:c,
    signature:Buffer.alloc(64).toString('base64url') }
  const parsed = parseHostFriendOnlineLeaseAssertion(unsigned)
  const key = identity.installationPrivateKey instanceof Object &&
    'type' in identity.installationPrivateKey ? identity.installationPrivateKey :
    createPrivateKey(identity.installationPrivateKey)
  const signature = sign(null,encodeHostFriendOnlineLeasePayload(parsed),key).toString('base64url')
  input.signal.throwIfAborted()
  return parseHostFriendOnlineLeaseAssertion({ ...unsigned,signature })
}
