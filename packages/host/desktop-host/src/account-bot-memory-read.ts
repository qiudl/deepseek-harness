import { parseHostBotMemoryPage, parseHostBotMemoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotMemoryPage, HostBotMemoryReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/**
 * Read a memory chunk only from the caller's current Account Profile.
 * @param host - Host that checks the caller's Account binding.
 * @param workers - Current Profile worker selector.
 * @param account - Caller connection's Account identity.
 * @param request - Exact logical memory selector.
 * @param signal - Caller cancellation.
 * @returns A bounded page from the same Account and Profile generation.
 */
export async function readAccountBotMemory(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'readBotMemory'>,
  account: BotIdentityAccount, request: HostBotMemoryReadRequest, signal: AbortSignal,
): Promise<HostBotMemoryPage> {
  signal.throwIfAborted()
  const target = parseHostBotMemoryReadRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotMemoryPage(await workers.readBotMemory(profileId, target, signal))
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  if (result.logical_id !== target.logical_id) throw new HostAuthorityError('profile_mismatch')
  return result
}
