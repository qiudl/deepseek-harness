import { parseHostBotChatAttachmentTransferRequest, parseHostBotChatAttachmentTransferResult } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotChatAttachmentTransferRequest,
  HostBotChatAttachmentTransferResult } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

/** Transfer one visible private Bot attachment in the caller's current Account Profile. */
export async function transferAccountBotChatAttachment(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'transferBotChatAttachment'>,
  account: BotIdentityAccount, request: HostBotChatAttachmentTransferRequest,
  signal: AbortSignal,
): Promise<HostBotChatAttachmentTransferResult> {
  signal.throwIfAborted()
  const target = parseHostBotChatAttachmentTransferRequest(request)
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const result = parseHostBotChatAttachmentTransferResult(
    await workers.transferBotChatAttachment(profileId, target, signal), target)
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  return result
}
