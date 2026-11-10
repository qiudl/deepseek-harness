/** Current parent Account and installation signer for the private task-coordination worker. */
import { createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseHostRemoteSessionJson, type HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostTaskCoordinationInput, parseHostTaskCoordinationReply, parseHostTaskCoordinationFenceAck,
  encodeHostTaskCoordinationDirective, encodeHostTaskCoordinationFenceAck, encodeHostTaskCoordinationObservation,
  hostTaskCoordinationDirectiveDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationInput, HostTaskCoordinationReply, HostTaskCoordinationPeer } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskCoordinationEnvironment } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import { HostAuthorityError } from './types.ts'

/** Actual supervisor-captured worker, retained through read, installation signing and Ack persistence. */
export interface TaskCoordinationReceiver {
  readonly workerId: string
  /** Refuse replaced, disposed or detached original worker generations. */
  assertCurrent(): void
  /** @param command - Parent-owned private action and exact current/original metadata.
   * @param signal - Current Account/request cancellation.
   * @returns The actual original worker reply.
   */
  execute(command: HostRemoteSessionJson, signal: AbortSignal): Promise<HostRemoteSessionJson>
}
/** Parent-only signing dependencies; no key or caller-supplied authority enters the worker. */
export interface AccountTaskCoordinationOptions {
  readonly host: Pick<DesktopHost, 'withCollaborationAccountRequest'>
  readonly environments: readonly HostTaskCoordinationEnvironment[]
  readonly peer: Pick<HostTaskCoordinationPeer, 'installationId' | 'publicKey' | 'hostInstanceId' | 'processNonce'>
  readonly receiver: (profileId: string) => TaskCoordinationReceiver
  /** Process-owned replay denial, claimed only after current Account/worker checks. */
  readonly claimNonce: (input: HostTaskCoordinationInput) => void
  readonly sign: (bytes: Uint8Array) => string
  readonly now: () => number
}
const bad = (code: ConstructorParameters<typeof HostAuthorityError>[0] = 'profile_mismatch'): never => { throw new HostAuthorityError(code) }
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length)
    return bad()
  const fields = Object.getOwnPropertyDescriptors(value)
  return Object.fromEntries(keys.map((key) => {
    const field = fields[key]
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return bad()
    return [key, field.value]
  }))
}
function cloudRequest(input: HostTaskCoordinationInput, environments: readonly HostTaskCoordinationEnvironment[]): void {
  const d = input.directive, environment = environments.find(entry => entry.environmentKey === d.scope.environmentKey
    && entry.keyring.environmentId === d.scope.authorityEnvironmentId), key = environment?.keyring.keys.find(entry => entry.kid === d.keyId)
  if (!environment || !key || environment.keyring.issuer !== d.issuer || d.issuedAt < key.validFrom || d.expiresAt > key.validUntil
    || !verify(null, Buffer.from(encodeHostTaskCoordinationDirective(d)), createPublicKey(key.publicKeyPem),
      Buffer.from(d.signature, 'base64url')))
    return bad('unauthorized')
}
function installationKey(raw: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'base64url')]),
    type: 'spki', format: 'der' })
}
function workerReply(value: unknown): { reply: HostTaskCoordinationReply; originalCut: unknown } {
  if (!value || typeof value !== 'object') return bad()
  const hasCut = Object.hasOwn(value, 'originalCut'), result = row(value, hasCut ? ['kind', 'record', 'originalCut'] : ['kind', 'record'])
  if (result.kind !== 'task_coordination') return bad()
  return { reply: parseHostTaskCoordinationReply(result.record), originalCut: hasCut ? result.originalCut : null }
}
/** Authenticate one current private task operation and durably complete installation-signed original cuts.
 * @param options - Real Host, captured worker receiver, pinned environment and installation signer.
 * @param account - Actual Account verified on the current transport connection.
 * @param value - Strict signed Cloud request; Root admission alone never substitutes for it.
 * @param bindingKey - Actual current authenticated Main/peer/Account private binding.
 * @param signal - Original owned transport cancellation.
 * @returns Exact public reply only after original cut signature persistence succeeds.
 */
export async function operateAccountTaskCoordination(options: AccountTaskCoordinationOptions,
  account: Parameters<DesktopHost['authorizeCollaborationRegistration']>[0], value: unknown, bindingKey: string,
  signal: AbortSignal): Promise<HostTaskCoordinationReply> {
  const input = parseHostTaskCoordinationInput(value), d = input.directive, command = input.command
  cloudRequest(input, options.environments)
  if (account.authorityEnvironmentId !== d.scope.authorityEnvironmentId || account.issuer !== d.scope.accountIssuer
    || account.subject !== d.scope.accountSubject || account.accountBindingHandle !== d.accountBindingId
    || account.authorityBindingVersion !== d.accountBindingVersion || !isDeepStrictEqual(options.peer, {
    installationId: d.peer.installationId, publicKey: d.peer.publicKey, hostInstanceId: d.peer.hostInstanceId,
    processNonce: d.peer.processNonce }))
    return bad('profile_mismatch')
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(15000, d.expiresAt - options.now())))
  return options.host.withCollaborationAccountRequest(account, AbortSignal.any([signal, deadline]), async (profileId, owned) => {
    if (String(profileId) !== d.scope.hostProfileId) return bad('profile_mismatch')
    const receiver = options.receiver(profileId)
    const current = () => {
      owned.throwIfAborted(); receiver.assertCurrent()
      if (options.now() < d.issuedAt || options.now() >= d.expiresAt) return bad('stale')
    }
    current()
    options.claimNonce(input)
    const actualAccount = { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer,
      accountSubject: account.subject, accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion,
      hostProfileId: profileId }
    const privateInput = { action: 'task_coordination', request: input, binding_key: bindingKey,
      actualAccount, actualPeer: options.peer }
    const output = workerReply(await receiver.execute(parseHostRemoteSessionJson(privateInput), owned))
    current()
    const reply = output.reply
    if (!reply.ok) return reply
    if (!isDeepStrictEqual(reply.peer, d.peer)) return bad('profile_mismatch')
    if (command.operation === 'attach') {
      if (reply.record.status !== 'attached' || reply.record.floorDigest !== d.floorDigest
        || reply.record.scopeDigest !== d.scopeDigest) return bad()
      return reply
    }
    if (command.operation === 'observe') {
      if (reply.record.status !== 'observed') return bad()
      const observation = reply.record.observation
      if (observation.issuer !== account.issuer || observation.transferRequestId !== command.transferRequestId
        || observation.scopeDigest !== d.scopeDigest
        || observation.floorDigest !== d.floorDigest || observation.requestId !== d.requestId
        || observation.directiveDigest !== hostTaskCoordinationDirectiveDigest(d) || observation.issuedAt !== d.issuedAt
        || observation.expiresAt !== d.expiresAt || observation.hostProfileId !== String(profileId)
          || observation.workerId !== receiver.workerId
        || !isDeepStrictEqual(observation.peer, d.peer)) return bad()
      current()
      return parseHostTaskCoordinationReply({ ...reply, record: { status: 'observed', observation: { ...observation,
        signature: options.sign(Buffer.from(encodeHostTaskCoordinationObservation(observation))) } } })
    }
    if (command.operation === 'receipt') {
      if (reply.record.status === 'missing') return reply
      if (reply.record.status !== 'found') return bad()
      const ack = reply.record.fenceAck
      if (ack.issuer !== account.issuer || ack.transferRequestId !== command.transferRequestId || ack.floorDigest !== d.floorDigest
        || ack.scopeDigest !== d.scopeDigest
        || ack.hostProfileId !== String(profileId) || !verify(null, Buffer.from(encodeHostTaskCoordinationFenceAck(ack)),
        installationKey(options.peer.publicKey), Buffer.from(ack.signature, 'base64url'))) return bad()
      return reply
    }
    if (reply.record.status !== 'closed') return bad()
    const cut = row(output.originalCut, ['input', 'ack']), original = parseHostTaskCoordinationInput(cut.input)
    cloudRequest(original, options.environments)
    if (original.command.operation !== 'fence' || original.command.transferRequestId !== command.transferRequestId
      || original.command.payloadDigest !== command.payloadDigest || original.directive.scopeDigest !== d.scopeDigest
      || original.directive.floorDigest !== d.floorDigest || original.directive.scope.hostProfileId !== String(profileId)
      || original.directive.scope.accountIssuer !== account.issuer || original.directive.scope.accountSubject !== account.subject
      || original.directive.scope.authorityEnvironmentId !== account.authorityEnvironmentId) return bad()
    const originalAck = parseHostTaskCoordinationFenceAck(cut.ack), ack = reply.record.fenceAck
    if (ack.issuer !== account.issuer || encodeHostTaskCoordinationFenceAck(originalAck) !== encodeHostTaskCoordinationFenceAck(ack)
      || ack.transferRequestId !== command.transferRequestId || ack.payloadDigest !== command.payloadDigest
      || ack.floorDigest !== d.floorDigest || ack.scopeDigest !== d.scopeDigest
        || ack.acceptedCoordinationEpoch !== d.scope.acceptedCoordinationEpoch
      || ack.hostProfileId !== String(profileId) || ack.closedAt < original.directive.issuedAt
        || ack.closedAt >= original.directive.expiresAt
      || !isDeepStrictEqual(ack.peer, original.directive.peer) || ack.peer.installationId !== options.peer.installationId
      || ack.peer.publicKey !== options.peer.publicKey || ack.peer.computerId !== d.peer.computerId
        || ack.peer.hostRegistryId !== d.peer.hostRegistryId)
      return bad()
    current()
    if (verify(null, Buffer.from(encodeHostTaskCoordinationFenceAck(ack)), installationKey(options.peer.publicKey),
      Buffer.from(ack.signature, 'base64url')))
      return reply
    if (ack.signature !== 'A'.repeat(86) || originalAck.signature !== 'A'.repeat(86)) return bad()
    const signed = parseHostTaskCoordinationFenceAck({ ...ack,
      signature: options.sign(Buffer.from(encodeHostTaskCoordinationFenceAck(ack))) })
    current()
    const committed = workerReply(await receiver.execute(parseHostRemoteSessionJson({ ...privateInput,
      action: 'task_coordination_commit_ack', fenceAck: signed }), owned)).reply
    current()
    if (!committed.ok || committed.record.status !== 'closed' || !isDeepStrictEqual(committed.peer, d.peer)
      || !isDeepStrictEqual(committed.record.fenceAck, signed)) return bad()
    return committed
  })
}
