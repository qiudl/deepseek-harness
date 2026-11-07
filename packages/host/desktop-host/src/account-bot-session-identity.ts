import { parseHostAccountBotSessionIdentity, parseHostBotSessionTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostAccountBotSessionIdentity, HostBotSessionCoordinates } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'

/**
 * Read coordinates in the original authorized Account Profile and retain its final publication guard.
 * @param host - Current Account authority.
 * @param workers - Original Profile worker selector.
 * @param account - Authenticated connection's verified Account binding.
 * @param target - Exact Bot/Session selectors.
 * @param signal - Caller cancellation.
 * @returns Coordinates or absence, plus a guard to call immediately before synchronous publication.
 */
export async function resolveAccountBotSessionIdentity(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'botSessionIdentityReceiver'>,
  account: BotIdentityAccount, target: HostBotSessionCoordinates, signal: AbortSignal,
): Promise<{ readonly identity: HostAccountBotSessionIdentity | null; assertCurrent(): void }> {
  const selected = parseHostBotSessionTarget(target)
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const receiver = workers.botSessionIdentityReceiver(profileId)
  const assertCurrent = () => {
    signal.throwIfAborted()
    host.authorizeCollaborationRegistration(account)
    if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
    receiver.assertCurrent()
  }
  const result = await receiver.read(selected, signal)
  assertCurrent()
  if (result !== null && (result.bot_id !== selected.bot_id || result.session_id !== selected.session_id))
    throw new HostAuthorityError('profile_mismatch')
  return { identity: result === null ? null : parseHostAccountBotSessionIdentity({ ...result, host_profile_id: profileId }), assertCurrent }
}
