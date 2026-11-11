/** Main-owned Account, Source-signature and installation-signature boundary for the paired original task step. */
import { createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  captureHostTaskTargetCall, captureHostTaskTargetResult, hostTaskTargetCallHeader, parseHostRemoteSessionJson,
  encodeHostTaskTargetPrepareDirective, encodeHostTaskReadyAdmissionDirective, encodeHostTaskTargetConsumeReceipt,
  encodeHostTaskTargetObserveDirective, encodeHostTaskTargetDescriptor, encodeHostTaskTargetConsumeChallenge,
  encodeHostTaskTargetObservation, parseHostTaskReadyAdmissionDirective, parseHostTaskTargetConsumeChallengeForProposal,
  parseHostTaskTargetConsumeReceiptForChallenge,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskTargetCall, HostTaskTargetResult, HostTaskCoordinationEnvironment,
  HostTaskCoordinationPeer } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { TaskCoordinationReceiver } from './account-task-coordination.ts'
import { HostAuthorityError } from './types.ts'

/** Parent-owned dependencies; neither an unsigned worker DTO nor a public parser supplies authority. */
export interface AccountTaskTargetOptions {
  readonly host: Pick<DesktopHost, 'withCollaborationAccountRequest'>
  readonly environments: readonly HostTaskCoordinationEnvironment[]
  readonly peer: Pick<HostTaskCoordinationPeer, 'installationId' | 'publicKey' | 'hostInstanceId' | 'processNonce'>
  readonly receiver: (profileId: string) => TaskCoordinationReceiver
  /** Claim the process-owned operation nonce after authenticating its current Account and original worker. */
  readonly claimNonce: (input: HostTaskTargetCall) => void
  readonly sign: (bytes: Uint8Array) => string
  readonly now: () => number
}
const bad = (code: ConstructorParameters<typeof HostAuthorityError>[0] = 'profile_mismatch'): never => {
  throw new HostAuthorityError(code)
}
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) return bad('unavailable')
  const fields = Object.getOwnPropertyDescriptors(value)
  return Object.fromEntries(keys.map((key) => {
    const field = fields[key]
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return bad('unavailable')
    return [key, field.value]
  }))
}
function cloudRequest(input: HostTaskTargetCall, environments: readonly HostTaskCoordinationEnvironment[]): void {
  const d = input.operation === 'ready_start' ? input.receipt : input.directive
  const header = hostTaskTargetCallHeader(input)
  const environment = environments.find(entry => entry.environmentKey === header.scope.environmentKey
    && entry.keyring.environmentId === header.scope.authorityEnvironmentId)
  const key = environment?.keyring.keys.find(entry => entry.kid === d.keyId)
  const encoded = input.operation === 'prepare' ? encodeHostTaskTargetPrepareDirective(input.directive)
    : input.operation === 'ready_prepare' ? encodeHostTaskReadyAdmissionDirective(input.directive)
      : input.operation === 'observe' ? encodeHostTaskTargetObserveDirective(input.directive)
        : encodeHostTaskTargetConsumeReceipt(input.receipt)
  try {
    if (!environment || !key || environment.keyring.issuer !== d.issuer || header.issuedAt < key.validFrom
      || header.expiresAt > key.validUntil || createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519'
      || !verify(null, Buffer.from(encoded), createPublicKey(key.publicKeyPem), Buffer.from(d.signature, 'base64url')))
      return bad('unauthorized')
  } catch { return bad('unauthorized') }
}
function installationSignature(bytes: string, signature: string, rawKey: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(rawKey, 'base64url')]), type: 'spki', format: 'der' })
    return verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url'))
  } catch { return false }
}
function workerResult(value: unknown, input: HostTaskTargetCall): HostTaskTargetResult {
  const result = row(value, ['kind', 'record'])
  if (result.kind !== 'task_target') return bad('unavailable')
  return captureHostTaskTargetResult(result.record, input)
}

/** Authenticate one paired original-step operation against the current Main Account and captured worker.
 * @param options - Actual Account lease owner, original receiver, pinned Source keys and installation signer.
 * @param account - Account authenticated on the original private transport connection.
 * @param value - Exact signed public request; no caller authority flags are accepted.
 * @param bindingKey - Current private Main/peer/Account transport binding.
 * @param signal - Original owned request cancellation.
 * @returns Exact durable metadata; a claimed run keeps its actual Main Account registration until worker cleanup.
 */
export async function operateAccountTaskTarget(options: AccountTaskTargetOptions,
  account: Parameters<DesktopHost['authorizeCollaborationRegistration']>[0], value: unknown, bindingKey: string,
  signal: AbortSignal): Promise<HostTaskTargetResult> {
  const input = captureHostTaskTargetCall(value), header = hostTaskTargetCallHeader(input)
  cloudRequest(input, options.environments)
  const actual = Object.freeze({ ...account }), localPeer = Object.freeze({ ...options.peer })
  const sameLocalPeer = () => isDeepStrictEqual(options.peer, localPeer)
  if (header.scope.canonicalRef.kind !== 'slark_issue' || actual.authorityEnvironmentId !== header.scope.authorityEnvironmentId
    || actual.issuer !== header.scope.accountIssuer || actual.subject !== header.scope.accountSubject
    || (header.accountBindingId !== null && actual.accountBindingHandle !== header.accountBindingId)
    || (header.accountBindingVersion !== null && actual.authorityBindingVersion !== header.accountBindingVersion)
    || !isDeepStrictEqual(localPeer, { installationId: header.peer.installationId, publicKey: header.peer.publicKey,
      hostInstanceId: header.peer.hostInstanceId, processNonce: header.peer.processNonce })) return bad()
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(15000, header.expiresAt - options.now())))
  const shortRequest = AbortSignal.any([signal, deadline]), accepted = Promise.withResolvers<HostTaskTargetResult>()
  void accepted.promise.catch(() => {}) // Non-start callers await accountScope; background failures are always observed.
  // The existing Host registration owns revocation/Profile changes. Source's unary is not the accepted task's lifetime.
  const accountSignal = input.operation === 'ready_start' ? new AbortController().signal : shortRequest
  const accountScope = options.host.withCollaborationAccountRequest(actual, accountSignal, async (profileId, owned) => {
    if (String(profileId) !== header.scope.hostProfileId) return bad()
    const receiver = options.receiver(profileId), workerId = receiver.workerId
    const admissionSignal = AbortSignal.any([owned, shortRequest])
    const lifetimeCurrent = () => {
      owned.throwIfAborted(); receiver.assertCurrent()
      if (receiver.workerId !== workerId) return bad()
      if (!sameLocalPeer()) return bad()
    }
    const current = () => {
      lifetimeCurrent(); admissionSignal.throwIfAborted()
      if (options.now() < header.issuedAt || options.now() >= header.expiresAt) return bad('stale')
    }
    current()
    const target = input.operation === 'ready_start' ? input.receipt.target
      : input.operation === 'ready_prepare' ? input.directive.target : null
    if (target && target.workerId !== workerId) return bad()
    options.claimNonce(input)
    current()
    const actualAccount = Object.freeze({ authorityEnvironmentId: actual.authorityEnvironmentId, accountIssuer: actual.issuer,
      accountSubject: actual.subject, accountBindingId: actual.accountBindingHandle,
      accountBindingVersion: actual.authorityBindingVersion, hostProfileId: profileId })
    const privateInput = { request: input, binding_key: bindingKey, actualAccount, actualPeer: localPeer,
      actualWorkerId: workerId }
    const first = await receiver.execute(parseHostRemoteSessionJson({ ...privateInput, action: 'task_target' }), admissionSignal)
    current()
    if (input.operation === 'ready_start') {
      // The first worker call is read-only. It cannot execute before Main checks the original proposal's current binding.
      if (first && typeof first === 'object' && Object.getOwnPropertyDescriptor(first, 'kind')?.value === 'task_target') {
        const refusal = workerResult(first, input)
        if (!refusal.ok) return refusal
        return bad('unavailable')
      }
      const original = row(first, ['kind', 'proposal', 'challenge'])
      if (original.kind !== 'task_target_original') return bad('unavailable')
      const proposal = parseHostTaskReadyAdmissionDirective(original.proposal)
      cloudRequest({ operation: 'ready_prepare', directive: proposal }, options.environments)
      if (proposal.accountBindingId !== actual.accountBindingHandle || proposal.accountBindingVersion !== actual.authorityBindingVersion
        || proposal.scope.hostProfileId !== String(profileId)) return bad()
      const challenge = parseHostTaskTargetConsumeChallengeForProposal(original.challenge, proposal)
      parseHostTaskTargetConsumeReceiptForChallenge(input.receipt, proposal, challenge)
      if (challenge.target.workerId !== workerId || challenge.issuedAt < proposal.issuedAt
        || input.receipt.consumedAt < challenge.issuedAt || options.now() < challenge.issuedAt
        || options.now() >= challenge.expiresAt
        || !installationSignature(encodeHostTaskTargetConsumeChallenge(challenge), challenge.signature, localPeer.publicKey))
        return bad('unauthorized')
      current()
      // The worker registers this exact private run before awaiting the short claim waiter. Its RPC remains live through cleanup.
      const run = receiver.execute(parseHostRemoteSessionJson({ ...privateInput, action: 'task_target_run' }), owned).then((value) => {
        lifetimeCurrent()
        return workerResult(value, input)
      })
      void run.catch((error: unknown) => {
        accepted.reject(error)
      })
      try {
        const result = workerResult(await receiver.execute(parseHostRemoteSessionJson({ ...privateInput,
          action: 'task_target_wait_claim' }), admissionSignal), input)
        current()
        accepted.resolve(result)
      } catch (error) {
        // Unknown/lost claim delivery cannot end Account control while the actual worker may still be running.
        accepted.reject(error)
      }
      return await run
    }
    const result = workerResult(first, input)
    if (!result.ok) return result
    const record = result.record
    if (input.operation === 'observe') {
      if (record.status !== 'observed' || record.observation.workerId !== workerId
        || record.observation.observedAt > options.now()) return bad()
      const observation = record.observation, bytes = encodeHostTaskTargetObservation(observation)
      if (observation.signature !== 'A'.repeat(86) && !installationSignature(bytes, observation.signature, localPeer.publicKey))
        return bad('unauthorized')
      current()
      const signature = options.sign(Buffer.from(bytes))
      current()
      if (!installationSignature(bytes, signature, localPeer.publicKey)) return bad('unauthorized')
      return captureHostTaskTargetResult({ ...result, record: { status: 'observed', observation: { ...observation, signature } } }, input)
    }
    if (record.status !== 'prepared' && record.status !== 'consume_intent') return bad('unavailable')
    const original = record.status === 'prepared' ? record.descriptor : record.challenge
    const bytes = record.status === 'prepared' ? encodeHostTaskTargetDescriptor(record.descriptor)
      : encodeHostTaskTargetConsumeChallenge(record.challenge)
    if (original.target.workerId !== workerId || original.target.hostProfileId !== String(profileId)
      || original.issuer !== actual.issuer || (record.status === 'prepared' ? record.descriptor.preparedAt > options.now()
      : record.challenge.issuedAt < input.directive.issuedAt || record.challenge.issuedAt > options.now()
          || record.challenge.expiresAt <= options.now())) return bad()
    const alreadySigned = installationSignature(bytes, original.signature, localPeer.publicKey)
    if (!alreadySigned && original.signature !== 'A'.repeat(86)) return bad('unauthorized')
    current()
    const signature = alreadySigned ? original.signature : options.sign(Buffer.from(bytes))
    current()
    if (!installationSignature(bytes, signature, localPeer.publicKey)) return bad('unauthorized')
    const signed = record.status === 'prepared' ? { kind: 'descriptor', value: { ...record.descriptor, signature } }
      : { kind: 'challenge', value: { ...record.challenge, signature } }
    const expected = captureHostTaskTargetResult({ ...result, record: record.status === 'prepared'
      ? { status: 'prepared', descriptor: signed.value } : { status: 'consume_intent', challenge: signed.value } }, input)
    const persisted = workerResult(await receiver.execute(parseHostRemoteSessionJson({ ...privateInput,
      action: 'task_target_commit', signed }), owned), input)
    current()
    if (!isDeepStrictEqual(persisted, expected)) return bad('unavailable')
    return persisted
  })
  // Consume every background completion/rejection. withCollaborationAccountRequest releases its real registration only here.
  void accountScope.then((result) => {
    accepted.resolve(result)
  }, (error: unknown) => {
    accepted.reject(error)
  })
  return input.operation === 'ready_start' ? accepted.promise : accountScope
}
