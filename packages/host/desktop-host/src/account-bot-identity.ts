import type { KeyObject } from 'node:crypto'
import { parseHostBotIdentityTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'

/** Current Account binding accepted on the Host's authenticated owner connection. */
export type BotIdentityAccount = Parameters<DesktopHost['authorizeCollaborationRegistration']>[0]

/** Installation key and current Host process bound to a friend Bot proof. */
export interface FriendBotSigningIdentity {
  readonly installationId: string
  readonly installationPublicKey: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly installationPrivateKey: KeyObject | string | Buffer
}

/** Reject a proof when its Account, Host peer, or signing window is no longer current. */
export function assertCurrentFriendProofAccountHost(
  challenge: Readonly<{
    owner_user_id: string
    authority_environment_id: string
    binding_id: string
    binding_epoch: string
    account_issuer: string
    account_subject: string
    host_installation_id: string
    host_public_key: string
    host_instance_id: string
    process_nonce: string
    issued_at: number
    expires_at: number
  }>,
  account: BotIdentityAccount, identity: FriendBotSigningIdentity, now: number,
): void {
  if (!Number.isSafeInteger(now) || now < challenge.issued_at || now >= challenge.expires_at ||
      challenge.owner_user_id !== account.ownerId ||
      challenge.authority_environment_id !== account.authorityEnvironmentId ||
      challenge.binding_id !== account.accountBindingHandle ||
      challenge.binding_epoch !== String(account.authorityBindingVersion) ||
      challenge.account_issuer !== account.issuer || challenge.account_subject !== account.subject ||
      challenge.host_installation_id !== identity.installationId ||
      challenge.host_public_key !== identity.installationPublicKey ||
      challenge.host_instance_id !== identity.hostInstanceId ||
      challenge.process_nonce !== identity.processNonce)
    throw new HostAuthorityError('profile_mismatch')
}

/** Shared inputs for signing a Bot proof after Account and Profile checks. */
export interface FriendBotSigningInput<Challenge> {
  readonly host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  readonly workers: Pick<ProfileWorkerSupervisor, 'resolveBotIdentity'>
  readonly account: BotIdentityAccount
  readonly challenge: Challenge
  readonly identity: FriendBotSigningIdentity
  readonly signal: AbortSignal
  readonly now: () => number
}

/**
 * Resolve one Bot only in the currently verified Account Profile and recheck after the worker reply.
 * @param host - Host authority that owns current Account grants.
 * @param workers - Current Profile worker selector.
 * @param account - Caller connection's Account binding and identity.
 * @param botId - Exact Bot identifier.
 * @param signal - Caller cancellation.
 * @returns Public Bot identity or absence.
 */
export async function resolveAccountBotIdentity(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'resolveBotIdentity'>,
  account: BotIdentityAccount, botId: string, signal: AbortSignal,
): Promise<HostBotIdentity | null> {
  signal.throwIfAborted()
  const target = parseHostBotIdentityTarget({ bot_id: botId })
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = await workers.resolveBotIdentity(profileId, target.bot_id, signal)
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  return result
}
