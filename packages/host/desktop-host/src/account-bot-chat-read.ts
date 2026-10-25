import { parseHostBotChatPage, parseHostBotChatReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotChatPage, HostBotChatReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/** Read one private Bot chat part only from the caller's current Account Profile. */
export async function readAccountBotChat(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'readBotChat'>,
  account: BotIdentityAccount, request: HostBotChatReadRequest, signal: AbortSignal,
): Promise<HostBotChatPage> {
  signal.throwIfAborted()
  const target = parseHostBotChatReadRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotChatPage(await workers.readBotChat(profileId, target, signal))
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  if (result.logical_id !== target.logical_id || result.part !== target.part)
    throw new HostAuthorityError('profile_mismatch')
  return result
}
