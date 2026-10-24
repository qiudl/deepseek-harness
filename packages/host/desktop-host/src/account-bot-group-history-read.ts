import { parseHostBotGroupHistoryPage, parseHostBotGroupHistoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotGroupHistoryPage, HostBotGroupHistoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/** Read a committed group page only from the caller's current Account Profile. */
export async function readAccountBotGroupHistory(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'readBotGroupHistory'>,
  account: BotIdentityAccount, request: HostBotGroupHistoryReadRequest, signal: AbortSignal,
): Promise<HostBotGroupHistoryPage> {
  signal.throwIfAborted()
  const target = parseHostBotGroupHistoryReadRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotGroupHistoryPage(await workers.readBotGroupHistory(profileId, target, signal))
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  if (result.logical_id !== target.logical_id) throw new HostAuthorityError('profile_mismatch')
  return result
}
