import { matchesHostBotGroupResponse, parseHostBotGroupCommand,
  type HostBotGroupCommand, type HostBotGroupResponse } from '@deepseek-ai/dsh-host-control-protocol'
import { confirmBotGroupTicket, type BotGroupPublicKeyring,
  type BotGroupTicketExpected } from './bot-group-ticket.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'

type DeliverCommand = Extract<HostBotGroupCommand, { operation: 'deliver' }>
type Confirmation = typeof confirmBotGroupTicket

type AccountBotGroupInput = {
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  workers: Pick<ProfileWorkerSupervisor, 'operateBotGroup'>
  account: BotIdentityAccount
  installationId: string
  computerId: string
  slarkAudience: string
  keyring: BotGroupPublicKeyring
  ticket: string
  command: DeliverCommand
  signal: AbortSignal
  confirm?: Confirmation
}

async function authorizeDelivery(input: AccountBotGroupInput) {
  input.signal.throwIfAborted()
  const command = parseHostBotGroupCommand(input.command)
  if (command.operation !== 'deliver') throw new HostAuthorityError('invalid_input')
  input.host.authorizeCollaborationRegistration(input.account)
  const profileId = input.host.authorizeAccountModelText(input.account)
  const expected: BotGroupTicketExpected = {
    ownerUserId: input.account.ownerId,
    computerId: input.computerId,
    accountIssuer: input.account.issuer,
    accountSubject: input.account.subject,
    environmentId: input.account.authorityEnvironmentId,
    accountBindingHandle: input.account.accountBindingHandle,
    accountBindingEpoch: input.account.authorityBindingVersion,
    installationId: input.installationId,
    slarkAudience: input.slarkAudience,
    groupId: command.groupId,
    deliveryId: command.deliveryId,
    botId: command.botId,
    memberCycle: command.memberCycle,
    messageSeq: command.messageSeq,
    text: command.text,
  }
  const confirmation = input.confirm ?? confirmBotGroupTicket
  const claim = await confirmation(input.ticket, input.keyring, expected, input.signal)
  if (claim.payloadDigest !== command.payloadDigest) throw new HostAuthorityError('profile_mismatch')
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId)
    throw new HostAuthorityError('stale')
  return profileId
}

/** Accept one Bot group message only after Account and live Slark authority agree. */
export async function deliverAccountBotGroup(input: AccountBotGroupInput): Promise<HostBotGroupResponse> {
  const profileId = await authorizeDelivery(input)
  const { command } = input
  let result: HostBotGroupResponse
  try {
    result = await input.workers.operateBotGroup(profileId, command, input.signal)
  } catch (error) {
    // A lost write reply may follow a durable inbox commit. Read the same delivery ID.
    input.signal.throwIfAborted()
    input.host.authorizeCollaborationRegistration(input.account)
    if (input.host.authorizeAccountModelText(input.account) !== profileId)
      throw new HostAuthorityError('stale')
    const receipt = await input.workers.operateBotGroup(profileId, {
      operation: 'receipt', deliveryId: command.deliveryId, groupId: command.groupId,
      botId: command.botId, memberCycle: command.memberCycle,
    }, input.signal).catch(() => { throw error })
    if (receipt.state === 'missing' || receipt.state === 'invalid' ||
        receipt.state === 'unavailable') throw error
    result = receipt
  }
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostBotGroupResponse(result, command)) throw new HostAuthorityError('stale')
  return result
}

/** The result reader proves a current original delivery before exposing any Bot output. */
export async function readAccountBotGroupResultPage(input: AccountBotGroupInput & {
  after: number
}): Promise<HostBotGroupResponse> {
  if (!Number.isSafeInteger(input.after) || input.after < 0)
    throw new HostAuthorityError('invalid_input')
  const profileId = await authorizeDelivery(input)
  const query: HostBotGroupCommand = { operation: 'result_page', groupId: input.command.groupId,
    botId: input.command.botId, memberCycle: input.command.memberCycle,
    after: input.after, limit: 1 }
  const result = await input.workers.operateBotGroup(profileId, query, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostBotGroupResponse(result, query)) throw new HostAuthorityError('stale')
  return result
}

/** Clear only the result whose Slark receipt was recorded by the caller. */
export async function acknowledgeAccountBotGroupResult(input: AccountBotGroupInput & {
  resultId: string
}): Promise<HostBotGroupResponse> {
  if (input.resultId !== `${input.command.deliveryId}:final`)
    throw new HostAuthorityError('invalid_input')
  const profileId = await authorizeDelivery(input)
  const command: HostBotGroupCommand = { operation: 'ack_result',
    groupId: input.command.groupId, botId: input.command.botId,
    memberCycle: input.command.memberCycle, deliveryId: input.command.deliveryId,
    resultId: input.resultId }
  const result = await input.workers.operateBotGroup(profileId, command, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostBotGroupResponse(result, command)) throw new HostAuthorityError('stale')
  return result
}
