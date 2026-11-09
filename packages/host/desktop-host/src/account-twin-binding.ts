import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
/** REQ-20261031-0006 / Task26151: consent confirmation is separate from every execution or memory grant. */
import { verify } from 'node:crypto'
import {
  parseHostTwinBindingInput, parseHostTwinBindingAck, encodeHostTwinBindingDirective, encodeHostTwinBindingAck,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotGroupPublicKeyring, HostTwinBindingAck, HostTwinBindingPeer,
  HostTwinBindingResult, HostTwinBindingInput } from '@deepseek-ai/dsh-host-control-protocol'
import { resolveAccountBotIdentityV2, type BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import type { TwinBindingReceipts } from './twin-binding-receipts.ts'
import { HostAuthorityError } from './types.ts'

/**
 * Confirm only one signed complete offer under the same current Account and actual Profile Bot.
 * @param options - Host-owned authority, pinned keys, signer, current peer and private storage.
 * @param account - Current authenticated control connection's Account.
 * @param value - Untrusted directive and command; never a caller-supplied acknowledgement.
 * @param signal - Connection-owned cancellation.
 * @returns The first durable acknowledgement, or missing for a read-only receipt query.
 */
export async function operateAccountTwinBinding(options: {
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  workers: Pick<ProfileWorkerSupervisor, 'resolveBotIdentity'>
  peer: HostTwinBindingPeer
  trustedKeyrings: readonly HostBotGroupPublicKeyring[]
  store(profileId: string): TwinBindingReceipts
  sign(payload: Buffer): string
  now(): number
  memory?: {
    metadata(profileId: string): ProjectOperationMemoryMetadata | Promise<ProjectOperationMemoryMetadata>
    capture(profileId: string, input: HostTwinBindingInput,
      confirmation: ReturnType<ProjectOperationMemoryMetadata['begin']>['confirmation'], signal: AbortSignal): Promise<unknown>
  }
}, account: BotIdentityAccount, value: unknown, signal: AbortSignal): Promise<HostTwinBindingResult> {
  let input
  try { input = parseHostTwinBindingInput(value) } catch { throw new HostAuthorityError('invalid_input') }
  const { directive: d, command } = input
  // account.ownerId is the Host's random connection owner, not a Slark user identifier.
  // The pinned Cloud signature attests the Slark owner; this connection separately proves the exact Account.
  if (d.authorityEnvironmentId !== account.authorityEnvironmentId
    || d.accountIssuer !== account.issuer || d.accountSubject !== account.subject
    || d.accountBindingId !== account.accountBindingHandle || d.accountBindingVersion !== account.authorityBindingVersion
    || JSON.stringify(d.peer) !== JSON.stringify(options.peer)) throw new HostAuthorityError('profile_mismatch')
  try {
    const ring = options.trustedKeyrings.find(item => item.environmentId === d.authorityEnvironmentId && item.issuer === d.issuer)
    const key = ring?.keys.find(item => item.kid === d.keyId)
    if (!key || key.validFrom > d.issuedAt || key.validUntil < d.expiresAt
      || !verify(null, Buffer.from(encodeHostTwinBindingDirective(d)), key.publicKeyPem,
        Buffer.from(d.signature, 'base64url'))) throw Error('invalid_signature')
  } catch { throw new HostAuthorityError('unauthorized') }
  const authorizedProfile = () => {
    const now = options.now()
    if (signal.aborted || !Number.isSafeInteger(now) || now < 0
      || d.issuedAt > now + 5000 || now >= d.expiresAt) throw new HostAuthorityError('stale')
    options.host.authorizeCollaborationRegistration(account)
    return options.host.authorizeAccountModelText(account)
  }
  const profileId: string = authorizedProfile()
  const guard = () => {
    if (authorizedProfile() !== profileId) throw new HostAuthorityError('profile_mismatch')
  }
  const memory = await options.memory?.metadata(profileId)
  guard()
  if (command.operation === 'receipt') {
    const ack = options.store(profileId).read(d)
    const pending = memory?.confirmation(d)
    if (ack && pending?.anchor) memory?.acknowledge(pending.confirmation.anchorId, ack, guard)
    guard()
    return ack ? { state: 'acknowledged', ack } : { state: 'missing' }
  }
  const source = command.offer.directions[0].scope.sourceRef
  const botId = source.botRootId
  if (source.hostProfileId !== profileId || !botId) throw new HostAuthorityError('profile_mismatch')
  const currentBot = async () => {
    const identity = await resolveAccountBotIdentityV2(options.host, options.workers, account, botId, signal)
    guard()
    if (!identity || identity.host_profile_id !== profileId || identity.bot_id !== source.botRootId
      || identity.actor_ref !== source.actorRef) throw new HostAuthorityError('profile_mismatch')
    return identity
  }
  const identity = await currentBot()
  const receiptStore = options.store(profileId), prior = receiptStore.read(d)
  if (prior) {
    const pending = memory?.confirmation(d)
    if (pending?.anchor) memory?.acknowledge(pending.confirmation.anchorId, prior, guard)
    await currentBot(); guard()
    return { state: 'acknowledged', ack: prior }
  }
  const intent = memory?.begin(command.offer, d, guard)
  let captured = false
  if (intent && options.memory) {
    const anchor = await options.memory.capture(profileId, input, intent.confirmation, signal)
    guard()
    if (anchor !== null) { memory?.capture(intent.confirmation.anchorId, anchor, guard); captured = true }
  }
  const unsigned: HostTwinBindingAck = {
    schemaVersion: 1, purpose: 'twin_binding_acknowledged',
    authorityEnvironmentId: d.authorityEnvironmentId, ownerUserId: d.ownerUserId,
    accountIssuer: d.accountIssuer, accountSubject: d.accountSubject,
    accountBindingId: d.accountBindingId, accountBindingVersion: d.accountBindingVersion,
    hostProfileId: profileId, botId: identity.bot_id, requestId: d.requestId,
    bindingId: d.bindingId, bindingGeneration: d.bindingGeneration, scopeVersion: d.scopeVersion,
    scopeDigest: d.scopeDigest, payloadDigest: d.payloadDigest, peer: options.peer,
    durableAt: options.now(), signature: 'A'.repeat(86),
  }
  const candidate = parseHostTwinBindingAck({ ...unsigned,
    signature: options.sign(Buffer.from(encodeHostTwinBindingAck(unsigned))) })
  guard()
  const ack = receiptStore.commit(command.offer, candidate, guard)
  if (captured && intent) memory?.acknowledge(intent.confirmation.anchorId, ack, guard)
  await currentBot()
  guard()
  return { state: 'acknowledged', ack }
}
