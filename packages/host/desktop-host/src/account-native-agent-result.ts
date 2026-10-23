/** REQ-20261023-0013: only the signed and live Slark turn may write a native room result. */
import { matchesHostNativeRoomReply, type HostNativeRoomCommand,
  type HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotGroupPublicKeyring } from './bot-group-ticket.ts'
import { confirmNativeAgentResultTicket } from './native-agent-result-ticket.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'

type ChunkCommand = Extract<HostNativeRoomCommand, { operation: 'agent-result-chunk' }>
/**
 * Verify the current Account and Slark's live turn before the Profile writes one result chunk.
 * @param input - Host authority, signed receipt, exact room coordinates, and cancellation signal.
 * @returns the Profile's matched receipt after the Account remains current.
 */
export async function deliverAccountNativeAgentResultChunk(input: {
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  workers: Pick<ProfileWorkerSupervisor, 'operateNativeRoom'>
  account: BotIdentityAccount
  installationId: string
  computerId: string
  slarkAudience: string
  workspaceId: string
  sessionId: string
  keyring: BotGroupPublicKeyring
  ticket: string
  command: ChunkCommand
  signal: AbortSignal
  confirm?: typeof confirmNativeAgentResultTicket
}): Promise<HostNativeRoomReply> {
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  const profileId = input.host.authorizeAccountModelText(input.account)
  const command = input.command
  const expected = {
    ownerUserId: input.account.ownerId, computerId: input.computerId,
    accountIssuer: input.account.issuer, accountSubject: input.account.subject,
    environmentId: input.account.authorityEnvironmentId,
    accountBindingHandle: input.account.accountBindingHandle,
    accountBindingEpoch: input.account.authorityBindingVersion,
    installationId: input.installationId, slarkAudience: input.slarkAudience,
    groupId: command.group_id, workspaceId: input.workspaceId,
    sessionId: input.sessionId, roomId: command.room_id,
    memberId: command.member_id, memberCycle: command.cycle,
    turnId: command.turn_id, turnOrder: command.turn_order,
    triggerRoomSeq: command.trigger_room_seq, projectId: command.project_id,
    agentId: command.agent_id, replyMessageId: command.reply_message_id,
    status: command.status, resultDigest: command.result_digest,
    chunkIndex: command.chunk_index, chunkCount: command.chunk_count,
    chunkText: command.chunk_text,
  }
  await (input.confirm ?? confirmNativeAgentResultTicket)(input.ticket, input.keyring,
    expected, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId)
    throw new HostAuthorityError('stale')
  const reply = await input.workers.operateNativeRoom(profileId, command, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostNativeRoomReply(reply, command)) throw new HostAuthorityError('stale')
  return reply
}
