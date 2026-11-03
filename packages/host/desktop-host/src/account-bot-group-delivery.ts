import { matchesHostBotGroupResponse, parseHostBotGroupCommand,
  type HostBotGroupCommand, type HostBotGroupResponse } from '@deepseek-ai/dsh-host-control-protocol'
import { confirmBotGroupTicket, confirmBotGroupResultTicket, confirmBotGroupResultAckTicket,
  confirmBotGroupStopTicket,
  type BotGroupPublicKeyring, type BotGroupTicketExpected,
  type BotGroupStopTicketExpected } from './bot-group-ticket.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'

type DeliverCommand = Extract<HostBotGroupCommand, { operation: 'deliver' }>
type Confirmation = typeof confirmBotGroupTicket
type ResultConfirmation = typeof confirmBotGroupResultTicket
type ResultAckConfirmation = typeof confirmBotGroupResultAckTicket
type StopConfirmation = typeof confirmBotGroupStopTicket

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
  resultConfirm?: ResultConfirmation
  resultAckConfirm?: ResultAckConfirmation
}

export function accountBindingIdentity(input: Pick<AccountBotGroupInput,
  'account' | 'computerId' | 'installationId' | 'slarkAudience'>) {
  return {
    computerId: input.computerId,
    accountIssuer: input.account.issuer, accountSubject: input.account.subject,
    environmentId: input.account.authorityEnvironmentId,
    accountBindingHandle: input.account.accountBindingHandle,
    accountBindingEpoch: input.account.authorityBindingVersion,
    installationId: input.installationId, slarkAudience: input.slarkAudience,
  }
}

function ticketIdentity(input: Pick<AccountBotGroupInput,
  'account' | 'computerId' | 'installationId' | 'slarkAudience'>,
command: { groupId: string; deliveryId: string; botId: string; memberCycle: number }) {
  return {
    ...accountBindingIdentity(input),
    groupId: command.groupId, deliveryId: command.deliveryId,
    botId: command.botId, memberCycle: command.memberCycle,
  }
}

function checkedWorkerReply(input: Pick<AccountBotGroupInput, 'signal' | 'host' | 'account'>,
  profileId: string,
  command: HostBotGroupCommand, result: HostBotGroupResponse): HostBotGroupResponse {
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostBotGroupResponse(result, command)) throw new HostAuthorityError('stale')
  return result
}

async function authorizeDelivery(input: AccountBotGroupInput,
  purpose: 'delivery' | 'result' | 'result-ack' = 'delivery') {
  input.signal.throwIfAborted()
  const command = parseHostBotGroupCommand(input.command)
  if (command.operation !== 'deliver') throw new HostAuthorityError('invalid_input')
  input.host.authorizeCollaborationRegistration(input.account)
  const profileId = input.host.authorizeAccountModelText(input.account)
  const expected: BotGroupTicketExpected = {
    ...ticketIdentity(input, command),
    messageSeq: command.messageSeq,
    text: command.text,
  }
  const confirmation = purpose === 'result'
    ? input.resultConfirm ?? confirmBotGroupResultTicket
    : purpose === 'result-ack'
      ? input.resultAckConfirm ?? confirmBotGroupResultAckTicket
      : input.confirm ?? confirmBotGroupTicket
  const claim = await confirmation(input.ticket, input.keyring, expected, input.signal)
  if (claim.payloadDigest !== command.payloadDigest) throw new HostAuthorityError('profile_mismatch')
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId)
    throw new HostAuthorityError('stale')
  return { profileId, ownerUserId: claim.ownerUserId }
}

/** Accept one Bot group message only after Account and live Slark authority agree. */
export async function deliverAccountBotGroup(input: AccountBotGroupInput): Promise<HostBotGroupResponse> {
  const { profileId } = await authorizeDelivery(input)
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

/** The result reader confirms result-only Slark authority before exposing Bot output. */
export async function readAccountBotGroupResultPage(input: AccountBotGroupInput & {
  after: number
}): Promise<{ reply: HostBotGroupResponse; ownerUserId: string }> {
  if (!Number.isSafeInteger(input.after) || input.after < 0)
    throw new HostAuthorityError('invalid_input')
  const { profileId, ownerUserId } = await authorizeDelivery(input, 'result')
  const query: HostBotGroupCommand = { operation: 'result_page', groupId: input.command.groupId,
    botId: input.command.botId, memberCycle: input.command.memberCycle,
    after: input.after, limit: 1 }
  const result = await input.workers.operateBotGroup(profileId, query, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId ||
      !matchesHostBotGroupResponse(result, query)) throw new HostAuthorityError('stale')
  return { reply: result, ownerUserId }
}

/** Clear only the result whose Slark receipt was recorded by the caller. */
export async function acknowledgeAccountBotGroupResult(input: AccountBotGroupInput & {
  resultId: string
}): Promise<HostBotGroupResponse> {
  if (input.resultId !== `${input.command.deliveryId}:final`)
    throw new HostAuthorityError('invalid_input')
  const { profileId } = await authorizeDelivery(input, 'result-ack')
  const command: HostBotGroupCommand = { operation: 'ack_result',
    groupId: input.command.groupId, botId: input.command.botId,
    memberCycle: input.command.memberCycle, deliveryId: input.command.deliveryId,
    resultId: input.resultId }
  const result = await input.workers.operateBotGroup(profileId, command, input.signal)
  return checkedWorkerReply(input, profileId, command, result)
}

/** Apply one owner-authorized stop request to its exact Bot delivery. */
export async function stopAccountBotGroupDelivery(input: Omit<AccountBotGroupInput,
  'command' | 'confirm'> & {
    command: Extract<HostBotGroupCommand, { operation: 'stop_delivery' }>
    messageSeq: number
    payloadDigest: string
    confirm?: StopConfirmation
  }): Promise<HostBotGroupResponse> {
  input.signal.throwIfAborted()
  const command = parseHostBotGroupCommand(input.command)
  if (command.operation !== 'stop_delivery' ||
      !Number.isSafeInteger(input.messageSeq) || input.messageSeq < 1 ||
      !/^[0-9a-f]{64}$/u.test(input.payloadDigest))
    throw new HostAuthorityError('invalid_input')
  input.host.authorizeCollaborationRegistration(input.account)
  const profileId = input.host.authorizeAccountModelText(input.account)
  const expected: BotGroupStopTicketExpected = {
    ...ticketIdentity(input, command), messageSeq: input.messageSeq,
    payloadDigest: input.payloadDigest, requestId: command.requestId,
  }
  await (input.confirm ?? confirmBotGroupStopTicket)(input.ticket, input.keyring,
    expected, input.signal)
  input.signal.throwIfAborted()
  input.host.authorizeCollaborationRegistration(input.account)
  if (input.host.authorizeAccountModelText(input.account) !== profileId)
    throw new HostAuthorityError('stale')
  const result = await input.workers.operateBotGroup(profileId, command, input.signal)
  return checkedWorkerReply(input, profileId, command, result)
}
