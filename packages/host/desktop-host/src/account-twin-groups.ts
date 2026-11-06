/** Account/Profile fences shared by private twin-room reads and original-cycle projection. */
import type { HostBoundBotRoomsQuery, HostBoundBotRoomsRead, HostRoomProjectionCommand,
  HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'
type Host = Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
async function currentProfile<T>(host: Host, account: BotIdentityAccount, signal: AbortSignal,
  operation: (profileId: string) => Promise<T>): Promise<{ profileId: string; value: T }> {
  signal.throwIfAborted()
  if (!account.ownerId) throw new HostAuthorityError('unauthorized')
  host.authorizeCollaborationRegistration(account)
  const profileId = host.authorizeAccountModelText(account)
  const value = await operation(profileId)
  signal.throwIfAborted()
  host.authorizeCollaborationRegistration(account)
  if (host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
  return { profileId, value }
}
/** Read only from the actual Account Profile and recheck it before its page can be signed.
 * @param host Current Account authority.
 * @param workers Current Profile worker registry.
 * @param account Authenticated Account binding and owner.
 * @param query Exact private Bot/page selector.
 * @param signal Caller cancellation.
 * @returns Actual Profile and current read outcome.
 */
export function readAccountBoundBotRooms(host: Host,
  workers: Pick<ProfileWorkerSupervisor, 'listBoundBotRooms'>, account: BotIdentityAccount,
  query: HostBoundBotRoomsQuery, signal: AbortSignal): Promise<{ profileId: string; value: HostBoundBotRoomsRead }> {
  return currentProfile(host, account, signal, profile => workers.listBoundBotRooms(profile, query, signal))
}
/** Project the original native member cycle; cleanup does not require a still-existing Bot.
 * @param host Current Account authority.
 * @param workers Current Profile worker registry.
 * @param account Authenticated Account binding and owner.
 * @param command Original join or leave command.
 * @param signal Caller cancellation.
 * @returns Actual Profile and the original native operation reply.
 */
export function projectAccountNativeRoom(host: Host,
  workers: Pick<ProfileWorkerSupervisor, 'operateNativeRoom'>, account: BotIdentityAccount,
  command: HostRoomProjectionCommand, signal: AbortSignal): Promise<{ profileId: string; value: HostNativeRoomReply }> {
  return currentProfile(host, account, signal, profile => workers.operateNativeRoom(profile, command, signal))
}
