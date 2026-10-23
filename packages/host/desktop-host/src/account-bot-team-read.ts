import { parseHostBotTeamPage, parseHostBotTeamReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotTeamPage, HostBotTeamReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/**
 * Read a bounded team page from the current Account's exclusive-writer Profile.
 * @param host - Host that checks the caller's Account binding.
 * @param workers - Current Profile worker selector.
 * @param account - Caller connection's Account binding and identity.
 * @param request - Exact team page selector.
 * @param signal - Caller cancellation.
 * @returns A validated page from the same Account and Profile generation.
 */
export async function readAccountBotTeam(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'readBotTeam'>,
  account: BotIdentityAccount, request: HostBotTeamReadRequest, signal: AbortSignal,
): Promise<HostBotTeamPage> {
  signal.throwIfAborted()
  const target = parseHostBotTeamReadRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotTeamPage(await workers.readBotTeam(profileId, target, signal))
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  return result
}
