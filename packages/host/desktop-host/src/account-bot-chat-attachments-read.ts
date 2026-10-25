import { parseHostBotChatAttachmentsPage, parseHostBotChatAttachmentsReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotChatAttachmentsPage, HostBotChatAttachmentsReadRequest } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/** Read one visible Bot attachment manifest only from the caller's current Account Profile. */
export async function readAccountBotChatAttachments(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'readBotChatAttachments'>,
  account: BotIdentityAccount, request: HostBotChatAttachmentsReadRequest, signal: AbortSignal,
): Promise<HostBotChatAttachmentsPage> {
  signal.throwIfAborted()
  const target = parseHostBotChatAttachmentsReadRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotChatAttachmentsPage(
    await workers.readBotChatAttachments(profileId, target, signal))
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  if (result.logical_id !== target.logical_id || result.part !== target.part)
    throw new HostAuthorityError('profile_mismatch')
  return result
}
