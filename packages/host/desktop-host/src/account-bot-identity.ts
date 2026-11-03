import { parseHostBotIdentityTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'

/** Current Account binding accepted on the Host's authenticated owner connection. */
export type BotIdentityAccount = Parameters<DesktopHost['authorizeCollaborationRegistration']>[0]

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
