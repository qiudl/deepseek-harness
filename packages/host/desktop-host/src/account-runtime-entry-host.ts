import { readRuntimeEntryInstalledSource, type RuntimeEntryInstalledSource } from './runtime-entry-installed-origin.ts'
/** Actual Main Account/worker fence for native entry. Source HTTP credentials and installation signing never enter the worker. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseHostRemoteSessionJson, type HostRemoteSessionJson, type HostBotGroupPublicKeyring, type HostProjectMemoryEnvironment,
  type HostProjectMemoryDirective, runtimeEntryBindingDigest } from '@deepseek-ai/dsh-host-control-protocol'
import { parseRuntimeEntryMetadataAuthorization, encodeRuntimeEntryMetadataAuthorization, parseRuntimeEntryConsumerGrant,
  type RuntimeEntryMetadataAuthorization } from '@deepseek-ai/dsh-host-control-protocol'
import { parseRuntimeEntryAnalysisCommand, parseRuntimeEntryOriginCommand,
  type RuntimeEntryOriginCommand } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRuntimeEntryOriginsConfiguration } from '@deepseek-ai/dsh-host-control-protocol'
import { readRuntimeEntryMetadataAuthorization, readRuntimeEntryWitness } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-journal'
import type { RuntimeEntryOriginalMetadata } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry'
import type { DesktopHost } from './desktop-host.ts'
import type { TaskCoordinationReceiver } from './account-task-coordination.ts'
import { verifyProjectOperationMemoryDirective } from './project-operation-memory-signatures.ts'
import { AccountRuntimeEntryOrigin, type RuntimeEntryMainLease } from './account-runtime-entry-origin.ts'
import { HostAuthorityError } from './types.ts'
function unavailable(): never { throw new HostAuthorityError('unavailable') }
type Account = Parameters<DesktopHost['authorizeCollaborationRegistration']>[0]
type Peer = { installationId: string; publicKey: string; hostInstanceId: string; processNonce: string }
/** Parent-only dependencies taken from real startup/registry/worker ownership, never operation fields. */
export interface AccountRuntimeEntryHostOptions {
  readonly host: Pick<DesktopHost, 'withCollaborationAccountRequest' | 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  readonly configuration: HostRuntimeEntryOriginsConfiguration
  readonly keyrings: readonly HostBotGroupPublicKeyring[]
  readonly peer: Peer
  readonly receiver: (profileId: string) => TaskCoordinationReceiver
  readonly profileRoot: (profileId: string) => string
  readonly sign: (bytes: Uint8Array) => string
  readonly now: () => number
}
function signature(proof: RuntimeEntryMetadataAuthorization, options: AccountRuntimeEntryHostOptions, fresh: boolean) {
  const ring = options.keyrings.find(r => r.environmentId === proof.authorityEnvironmentId && r.issuer === proof.issuer)
  const key = ring?.keys.find(k => k.kid === proof.keyId), now = options.now()
  if (!key || proof.issuedAt < key.validFrom || proof.expiresAt > key.validUntil || fresh && (now < proof.issuedAt
    || now >= proof.expiresAt)
    || !verify(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization(proof)), createPublicKey(key.publicKeyPem),
      Buffer.from(proof.signature, 'base64url'))) unavailable()
}
function identity(proof: RuntimeEntryMetadataAuthorization, options: AccountRuntimeEntryHostOptions,
  account: Account, profileId: string, fresh: boolean) {
  if (proof.authorityEnvironmentId !== account.authorityEnvironmentId || proof.accountIssuer !== account.issuer
    || proof.accountSubject !== account.subject || proof.metadata.binding.hostProfileId !== profileId
    || proof.peer.installationId !== options.peer.installationId || proof.peer.publicKey !== options.peer.publicKey
    || fresh && (proof.accountBindingId !== account.accountBindingHandle || proof.accountBindingVersion !== account.authorityBindingVersion
      || proof.peer.hostInstanceId !== options.peer.hostInstanceId || proof.peer.processNonce !== options.peer.processNonce)) unavailable()
}
function originalGrant(proof: RuntimeEntryMetadataAuthorization, value: unknown) {
  const g = parseRuntimeEntryConsumerGrant(value), m = proof.metadata.consumerGrantMetadata
  const expected = { root_task_id: m.rootTaskId, root_trace_id: m.rootTraceId, execution_command_id: m.executionCommandId,
    delivery_id: m.terminalDeliveryId, result_digest: m.terminalResultDigest, message_id: m.messageId,
    command_id: m.consumerCommandId, expected_event_count: m.expectedEventCount, expected_log_digest: m.expectedLogDigest,
    task_revision: 1, session_id: m.sessionId, command_digest: m.commandDigest, consumer_attempt_id: m.consumerAttemptId,
    consumer_step_id: m.consumerStepGrantId, issued_at: new Date(m.grantIssuedAt).toISOString(),
    expires_at: new Date(m.grantExpiresAt).toISOString(), dispatch_granted: proof.metadata.dispatchGranted }
  if (Object.entries(expected).some(([key, item]) => g[key as keyof typeof g] !== item)) unavailable()
}
function rootMatches(proof: RuntimeEntryMetadataAuthorization, query: RuntimeEntryOriginCommand) {
  const b = proof.metadata.binding, t = query.target, s = b.sourceCoordinates
  if (b.namespaceId !== t.namespace_id || String(b.rootCommandId) !== String(t.command_id) || b.terminalDeliveryId !== query.delivery_id
    || String(s.workspaceId) !== String(t.workspace_id) || String(s.sessionId) !== String(t.session_id)
      || s.sourceMessageId !== t.source_message_id
    || s.sourceRevision !== t.source_revision) unavailable()
}
function originalOrigin(options: AccountRuntimeEntryHostOptions, account: Account, profileId: string,
  peer: RuntimeEntryMainLease['peer'], current: () => void, source: RuntimeEntryInstalledSource): AccountRuntimeEntryOrigin {
  const root = options.profileRoot(profileId), journal = join(root, 'runtime-entry.sqlite')
  const actualAccount = { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer,
    accountSubject: account.subject, accountBindingId: account.accountBindingHandle,
    accountBindingVersion: account.authorityBindingVersion, hostProfileId: profileId }
  const leaseAccount = actualAccount
  return new AccountRuntimeEntryOrigin({ profileRoot: root, pluginHome: join(root, 'bot'), entryJournalPath: journal,
    implementationDigest: options.configuration.implementationDigest, compositionDigest: options.configuration.compositionDigest,
    artifactPins: source.artifactPins, keyrings: options.keyrings,
    captureCurrentLease: () => ({ account: leaseAccount, peer, issuer: account.issuer,
      keyId: options.peer.installationId, assertCurrent: current }),
    readOriginalMetadata: (commandId): Promise<RuntimeEntryOriginalMetadata | undefined> => {
      current()
      const original = readRuntimeEntryMetadataAuthorization(journal, commandId)
      if (!original) return Promise.resolve(undefined)
      signature(original, options, false); identity(original, options, account, profileId, false)
      return Promise.resolve(Object.freeze({ binding: original.metadata.binding,
        projectId: brandString<RuntimeEntryOriginalMetadata['projectId']>(original.metadata.projectId),
        taskRef: original.metadata.taskRef === null ? null : brandString<NonNullable<RuntimeEntryOriginalMetadata['taskRef']>>(original.metadata.taskRef),
        dispatchGranted: false, sourceKind: original.metadata.sourceKind,
        originalAuthorityDigest: original.metadata.originalAuthorityDigest,
        accountAuthorityDigest: original.metadata.accountAuthorityDigest, isCurrent: () => { current(); return true } }))
    }, sign: options.sign, registerObservation: () => unavailable(),
  })
}

interface CurrentInstalledSource extends RuntimeEntryInstalledSource { assertWorkerCurrent(): Promise<void> }
async function installedSource(options: AccountRuntimeEntryHostOptions, account: Account, profileId: string,
  receiver: TaskCoordinationReceiver, bindingKey: string, signal: AbortSignal,
  current: () => void): Promise<CurrentInstalledSource | null> {
  current()
  const request = parseHostRemoteSessionJson({ action: 'runtime_entry_installed_origin', binding_key: bindingKey,
    actualAccount: { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer, accountSubject: account.subject,
      accountBindingId: account.accountBindingHandle, accountBindingVersion: account.authorityBindingVersion, hostProfileId: profileId },
    actualPeer: options.peer, actualWorkerId: receiver.workerId })
  const response = await receiver.execute(request, signal)
  current()
  if (response === null) return null
  const source = await readRuntimeEntryInstalledSource(options.configuration, options.profileRoot(profileId), profileId,
    receiver.workerId, response)
  current(); source.assertCurrent()
  return Object.freeze({ ...source, async assertWorkerCurrent() {
    current()
    const next = await receiver.execute(request, signal)
    current(); source.assertCurrent()
    if (JSON.stringify(next) !== JSON.stringify(response)) unavailable()
  } })
}

/** Execute metadata reads/start only through one captured real Account and worker request.
 * @param options - Actual Main dependencies and trusted installed closure.
 * @param account - Current authenticated connection Account.
 * @param value - Closed new metadata purpose; old consumer grammar never selects it.
 * @param bindingKey - Real parent transport binding.
 * @param signal - Original owned request cancellation.
 * @returns Actual worker's existing execution/consumer result; Source completion is never fabricated here.
 */
export async function operateAccountRuntimeEntryAnalysis(options: AccountRuntimeEntryHostOptions, account: Account,
  value: unknown, bindingKey: string, signal: AbortSignal): Promise<HostRemoteSessionJson> {
  const command = parseRuntimeEntryAnalysisCommand(value)
  return options.host.withCollaborationAccountRequest(account, signal, async (profileId, active) => {
    if (options.configuration.schemaVersion !== 3 && command.action === 'root_execution_journal') {
      active.throwIfAborted()
      return parseHostRemoteSessionJson({ supported: false, record: null })
    }
    const receiver = options.receiver(profileId)
    const captured: { source?: RuntimeEntryInstalledSource } = {}
    const current = () => { active.throwIfAborted(); receiver.assertCurrent(); captured.source?.assertCurrent() }
    const source = await installedSource(options, account, profileId, receiver, bindingKey, active, current)
    if (!source) {
      if (command.action === 'root_execution_journal') return parseHostRemoteSessionJson({ supported: false, record: null })
      unavailable()
    }
    captured.source = source
    const actualAccount = { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer,
      accountSubject: account.subject, accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion,
      hostProfileId: profileId }
    current()
    if (command.action === 'root_feedback' && command.operation.action === 'consumer_start') {
      const proof = parseRuntimeEntryMetadataAuthorization(command.metadataAuthorization)
      signature(proof, options, true); identity(proof, options, account, profileId, true); originalGrant(proof, command.operation.grant)
      if (!proof.metadata.dispatchGranted || options.now() >= proof.metadata.binding.grantExpiresAt) unavailable()
    }
    const result = await receiver.execute(parseHostRemoteSessionJson({ ...command, binding_key: bindingKey,
      actualAccount, actualPeer: options.peer, actualWorkerId: receiver.workerId }), active)
    await source.assertWorkerCurrent()
    current()
    return result
  })
}
/** Independently observe a candidate or verify the real Cloud pair before requesting actual DSBot publication.
 * @param options - Current Main, fixed installation paths and source keys.
 * @param account - Actual current connection Account.
 * @param value - Original metadata-only Root selectors and optional real Cloud pair.
 * @param bindingKey - Real private transport binding.
 * @param signal - Current Account/request lifetime.
 * @returns Fresh mapped observation or actual awaited publication acknowledgment, never entry/model success.
 */
export async function operateAccountRuntimeEntryOrigin(options: AccountRuntimeEntryHostOptions, account: Account,
  value: unknown, bindingKey: string, signal: AbortSignal): Promise<HostRemoteSessionJson> {
  const command = parseRuntimeEntryOriginCommand(value)
  return options.host.withCollaborationAccountRequest(account, signal, async (profileId, active) => {
    const receiver = options.receiver(profileId), journal = join(options.profileRoot(profileId), 'runtime-entry.sqlite')
    const actualAccount = { authorityEnvironmentId: account.authorityEnvironmentId, accountIssuer: account.issuer,
      accountSubject: account.subject, accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion,
      hostProfileId: profileId }
    const captured: { source?: RuntimeEntryInstalledSource } = {}
    const current = () => { active.throwIfAborted(); receiver.assertCurrent(); captured.source?.assertCurrent() }
    const source = await installedSource(options, account, profileId, receiver, bindingKey, active, current)
    if (!source) unavailable()
    captured.source = source
    current()
    const located = await receiver.execute(parseHostRemoteSessionJson({ action: 'runtime_entry_locate', operation: command,
      actualAccount, actualPeer: options.peer, actualWorkerId: receiver.workerId, binding_key: bindingKey }), active)
    current()
    if (!located || typeof located !== 'object' || Array.isArray(located) || Object.keys(located).length !== 1
      || !Object.hasOwn(located, 'entryId')) unavailable()
    const entryId: unknown = Reflect.get(located, 'entryId')
    if (entryId === null && command.purpose === 'runtime_entry_observe')
      return parseHostRemoteSessionJson({ purpose: command.purpose, observation: null })
    if (typeof entryId !== 'string') unavailable()
    const witness = readRuntimeEntryWitness(journal, entryId)
    if (!witness) unavailable()
    const proof = readRuntimeEntryMetadataAuthorization(journal, witness.receipt.binding.consumerCommandId)
    if (!proof) unavailable()
    signature(proof, options, false); identity(proof, options, account, profileId, false); rootMatches(proof, command)
    const fresh = command.metadataAuthorization
    if (fresh) {
      signature(fresh, options, true); identity(fresh, options, account, profileId, true); rootMatches(fresh, command)
      if (fresh.metadata.dispatchGranted
        || runtimeEntryBindingDigest(fresh.metadata.binding) !== runtimeEntryBindingDigest(witness.receipt.binding)
        || fresh.metadata.originalAuthorityDigest !== witness.inputs.originalAuthorityDigest) unavailable()
    }
    // Fresh Source routing facts never replace the original stored proof or witness inputs.
    const context = parseRuntimeEntryMetadataAuthorization({ ...proof,
      accountBindingId: actualAccount.accountBindingId, accountBindingVersion: actualAccount.accountBindingVersion,
      peer: { ...(fresh?.peer ?? proof.peer), ...options.peer } })
    const peer = context.peer
    const origin = originalOrigin(options, account, profileId, peer, current, source)
    if (command.purpose === 'runtime_entry_observe') {
      const observation = await origin.observeCandidate(entryId, active)
      await source.assertWorkerCurrent(); current()
      return parseHostRemoteSessionJson({ purpose: command.purpose, observation })
    }
    if (command.observation.receipt.entryId !== entryId) unavailable()
    const projection = await origin.bindPair(entryId, { observation: command.observation, attribution: command.attribution }, active)
    current()
    const result = await receiver.execute(parseHostRemoteSessionJson({ action: 'runtime_entry_publish', operation: command,
      actualAccount, actualPeer: options.peer, actualWorkerId: receiver.workerId, binding_key: bindingKey,
      actualPublication: projection }), active)
    await source.assertWorkerCurrent()
    current()
    const published: unknown = result !== null && typeof result === 'object' ? Reflect.get(result, 'published') : undefined
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
      || !Object.hasOwn(result, 'published') || typeof published !== 'boolean') unavailable()
    return parseHostRemoteSessionJson({ purpose: command.purpose, published })
  })
}

/** Read and revalidate an original published native event under this exact current signed memory directive.
 * @param options - Actual Main, installation, worker and fixed artifact closure.
 * @param account - Current authenticated parent Account.
 * @param environments - Explicit trusted memory signing policies, separate from Native metadata purpose.
 * @param directive - Original Source-signed current memory directive, never an SDK grant flag.
 * @param entryId - Exact existing event's original entry identity.
 * @param signal - Current Account/Profile request cancellation.
 * @returns Fresh independent installation observation and exact immutable original signed pair.
 */
export async function observeAccountRuntimeEntrySource(options: AccountRuntimeEntryHostOptions, account: Account,
  environments: readonly HostProjectMemoryEnvironment[], directive: HostProjectMemoryDirective, entryId: string, signal: AbortSignal) {
  return options.host.withCollaborationAccountRequest(account, signal, async (profileId, active) => {
    const receiver = options.receiver(profileId), peer = directive.peer
    const captured: { source?: RuntimeEntryInstalledSource } = {}
    const current = () => {
      active.throwIfAborted(); receiver.assertCurrent(); captured.source?.assertCurrent()
      options.host.authorizeCollaborationRegistration(account)
      if (options.host.authorizeAccountModelText(account) !== profileId) unavailable()
      verifyProjectOperationMemoryDirective(environments, directive, options.now())
      if (!peer || directive.direction !== 'dsh_to_slark' || directive.authorityEnvironmentId !== account.authorityEnvironmentId ||
        directive.accountIssuer !== account.issuer || directive.accountSubject !== account.subject ||
        directive.accountBindingId !== account.accountBindingHandle
          || directive.accountBindingVersion !== account.authorityBindingVersion ||
        directive.scope.sourceRef.hostProfileId !== profileId || peer.installationId !== options.peer.installationId ||
        peer.publicKey !== options.peer.publicKey || peer.hostInstanceId !== options.peer.hostInstanceId
          || peer.processNonce !== options.peer.processNonce)
        unavailable()
    }
    current()
    if (!peer) unavailable()
    const sourceKey = createHash('sha256').update('dsh.runtime-entry.source-view/v1\0'
      + JSON.stringify([profileId, receiver.workerId, entryId])).digest('hex')
    const source = await installedSource(options, account, profileId, receiver, sourceKey, active, current)
    if (!source) unavailable()
    captured.source = source
    const result = await originalOrigin(options, account, profileId, peer, current, source).observePublished(entryId, active)
    await source.assertWorkerCurrent()
    current(); result.assertCurrent()
    if (String(result.observation.receipt.binding.ownerUserId) !== String(directive.ownerUserId) ||
      String(result.observation.botId) !== String(directive.scope.sourceRef.botRootId) ||
      !Object.is(result.originalPair.attribution.projectId, directive.scope.projectId)) unavailable()
    return Object.freeze({ observation: result.observation, originalPair: result.originalPair,
      assertCurrent: () => { current(); result.assertCurrent() } })
  })
}
