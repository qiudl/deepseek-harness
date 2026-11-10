/** Authenticated worker factory for the original Source step; only retained object identity can wake its Agent. */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RuntimeEntryConsumerHost } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-consumer-host'
import type { RuntimeEntryLoadedSession } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry'
import type { PairedTaskStepCapability, PairedTaskStepLease, PairedTaskTargetConsumerHost } from '@deepseek-ai/dsh-api-session-controller/host/paired-task-target-consumer-host'
import type { PairedTaskTargetAdmission, PairedTaskTargetJournal } from '@deepseek-ai/dsh-api-session-controller/host/paired-task-target-journal'
import { captureHostTaskTargetCall, captureHostTaskTargetResult, hostTaskTargetCallHeader,
  encodeHostTaskTargetPrepareDirective, encodeHostTaskReadyAdmissionDirective, encodeHostTaskTargetConsumeReceipt,
  encodeHostTaskTargetObserveDirective, encodeHostTaskTargetDescriptor, encodeHostTaskTargetConsumeChallenge,
  hostTaskTargetDescriptorDigest, hostTaskTargetOriginalStepHash, hostTaskTargetProviderDigest,
  hostTaskReadyAdmissionDirectiveDigest, parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective,
  hostTaskTargetObserveDirectiveDigest, hostTaskTargetInventoryDigest, parseHostTaskTargetObservation,
  parseHostTaskTargetObservationItem, type HostTaskTargetObservationItem,
  parseHostTaskTargetConsumeChallengeForProposal, parseHostTaskTargetConsumeReceiptForChallenge,
  parseHostTaskTargetStepBody, parseHostRemoteSessionJson,
  type HostTaskTargetCall, type HostTaskTargetDescriptor,
  type HostTaskCoordinationEnvironment, type HostRemoteSessionJson, type HostRuntimeEntryOriginsConfiguration,
} from '@deepseek-ai/dsh-host-control-protocol'
import { parseTaskCoordinationActualAccount, parseTaskCoordinationActualPeer,
  type TaskCoordinationActualAccount, type TaskCoordinationActualPeer } from './desktop-task-coordination.ts'
import type { DesktopTaskCoordinationNative } from './desktop-task-coordination-native.ts'
import { PairedTaskTargetFiles } from './desktop-task-target-files.ts'
import { DesktopTaskTargetRuns } from './desktop-task-target-runs.ts'

function unavailable(): never { throw Error('paired_target_unavailable') }
const hash = (value: unknown) => createHash('sha256').update('dsh.paired-task-target.private/v1\0' + JSON.stringify(value)).digest('hex')
const original = (value: unknown): unknown => value && typeof value === 'object' ? Reflect.get(value, symbols.original) ?? value : value
interface BotProducer {
  readLocalBotChat(botId: string): Promise<unknown>
  describeLocalBotSession(input: { sessionId: string }): Promise<unknown>
}
interface LoadedTarget {
  readonly agent: Agent
  readonly tools: Context['tools']
  readonly executor: ReturnType<Context['tools']['inspectExecutor']>
  readonly snapshot: RuntimeEntryLoadedSession
  readonly descriptor: HostTaskTargetDescriptor
  readonly producer: BotProducer
  invalidated: boolean
}
interface CapturedCall {
  readonly input: HostTaskTargetCall
  readonly account: TaskCoordinationActualAccount
  readonly peer: TaskCoordinationActualPeer
  readonly binding: string
  current(): void
}
function installationSignature(preimage: string, signature: string, key: string): boolean {
  try {
    return verify(null, Buffer.from(preimage), createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'base64url')]), type: 'spki', format: 'der' }),
    Buffer.from(signature, 'base64url'))
  } catch { return false }
}
/** One actual bootstrap owns its private capability objects, durable records and active long requests. */
export class DesktopTaskTargetHost {
  /** Opaque one-use consumer access; the worker retains its factory and all signing/request inputs privately. */
  readonly service: PairedTaskTargetConsumerHost
  private readonly capabilities = new WeakMap<PairedTaskStepCapability, PairedTaskStepLease>()
  private readonly loaded = new Map<string, LoadedTarget>()
  private readonly runs: DesktopTaskTargetRuns
  private readonly provider: RuntimeEntryConsumerHost
  private readonly configuration: HostRuntimeEntryOriginsConfiguration
  private readonly native: DesktopTaskCoordinationNative
  private journalPromise?: Promise<PairedTaskTargetJournal>
  private closed = false
  private readonly inventories = new Map<string, { binding: string
    expiresAt: number
    items: readonly HostTaskTargetObservationItem[]
    digest: string
    coverage: 'complete' | 'unknown' }>()
  private readonly cursors = new Map<string, { inventoryId: string; offset: number }>()

  /** @param ctx - Actual injected worker, with the original Controller and verified Native bootstrap.
   * @param environments - Parent-pinned Source public signing policy.
   * @param profileId - Original parent-selected Profile identity.
   * @param workerId - Original parent-selected physical worker identity.
   * @param lifetime - Actual worker lifetime; the parent separately owns every long Account request.
   * @param configuration - Exact installed-origin configuration also used by the actual Native bootstrap; absence refuses.
   * @param native - Same worker's actual native observer; absence refuses without opening a writer.
   * @param provider - Actual Native owner retained by this bootstrap; consuming calls require its active published identity.
   */
  constructor(private readonly ctx: Context, private readonly environments: readonly HostTaskCoordinationEnvironment[],
    private readonly profileId: string, private readonly workerId: string, private readonly lifetime: AbortSignal,
    configuration: HostRuntimeEntryOriginsConfiguration | undefined, native: DesktopTaskCoordinationNative | undefined,
    provider: RuntimeEntryConsumerHost | undefined) {
    if (!provider || !environments.length || !profileId || !workerId || configuration?.schemaVersion !== 3 || !native
      || !ctx.get('agentLoop') || !ctx.get('sessionPersistence') || !ctx.get('sessionController')) unavailable()
    this.provider = provider; this.configuration = configuration; this.native = native
    this.runs = new DesktopTaskTargetRuns(lifetime)
    this.service = Object.freeze({ take: (capability: PairedTaskStepCapability, signal: AbortSignal) => {
      signal.throwIfAborted(); lifetime.throwIfAborted()
      const lease = this.capabilities.get(capability)
      if (!lease) return unavailable()
      lease.assertCurrent(); this.capabilities.delete(capability); return lease
    } })
  }

  private journal(): Promise<PairedTaskTargetJournal> {
    return this.journalPromise ??= this.ctx.sessionController.openPairedTaskTargetJournal()
  }
  private capture(value: unknown, accountValue: unknown, peerValue: unknown, bindingKey: string, signal: AbortSignal): CapturedCall {
    const input = captureHostTaskTargetCall(value), header = hostTaskTargetCallHeader(input),
      account = parseTaskCoordinationActualAccount(accountValue), peer = parseTaskCoordinationActualPeer(peerValue)
    if (!/^[a-f0-9]{64}$/u.test(bindingKey) || account.authorityEnvironmentId !== header.scope.authorityEnvironmentId
      || account.accountIssuer !== header.scope.accountIssuer || account.accountSubject !== header.scope.accountSubject
      || account.hostProfileId !== this.profileId || header.scope.hostProfileId !== this.profileId
      || header.accountBindingId !== null && account.accountBindingId !== header.accountBindingId
      || header.accountBindingVersion !== null && account.accountBindingVersion !== header.accountBindingVersion
      || !isDeepStrictEqual(peer, { installationId: header.peer.installationId, publicKey: header.peer.publicKey,
        hostInstanceId: header.peer.hostInstanceId, processNonce: header.peer.processNonce })) unavailable()
    const envelope = input.operation === 'ready_start' ? input.receipt : input.directive
    const environment = this.environments.find(e => e.environmentKey === header.scope.environmentKey
      && e.keyring.environmentId === header.scope.authorityEnvironmentId)
    const key = environment?.keyring.keys.find(k => k.kid === envelope.keyId)
    const bytes = input.operation === 'prepare' ? encodeHostTaskTargetPrepareDirective(input.directive)
      : input.operation === 'ready_prepare' ? encodeHostTaskReadyAdmissionDirective(input.directive)
        : input.operation === 'ready_start' ? encodeHostTaskTargetConsumeReceipt(input.receipt)
          : encodeHostTaskTargetObserveDirective(input.directive)
    if (!environment || !key || environment.keyring.issuer !== envelope.issuer || header.issuedAt < key.validFrom
      || header.expiresAt > key.validUntil || createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519'
      || !verify(null, Buffer.from(bytes), createPublicKey(key.publicKeyPem), Buffer.from(envelope.signature, 'base64url'))) unavailable()
    const current = () => {
      signal.throwIfAborted(); this.lifetime.throwIfAborted()
      if (this.closed || this.ctx.fiber.state !== FiberState.ACTIVE || this.ctx.get('pairedTaskTargetConsumerHost') !== this.service
        || Date.now() < header.issuedAt || Date.now() >= header.expiresAt) unavailable()
    }
    current()
    return { input, account, peer, binding: hash([bindingKey, account, peer, this.workerId, input]), current }
  }
  private targetCurrent(target: LoadedTarget): void {
    try {
      this.lifetime.throwIfAborted()
      if (target.invalidated || this.closed || this.ctx.get('runtimeEntryConsumerHost') !== this.provider
        || original(this.ctx.get('tools')) !== original(target.tools)
        || this.ctx.tools.inspectExecutor(target.agent) !== target.executor || !this.provider.supports(target.agent)
        || this.ctx.agents.get(target.agent.id) !== target.agent || this.ctx.sessions.get(target.agent.session.id) !== target.agent.session
        || original(this.ctx.get('dsBotSlarkExternalGroup') ?? {}) !== original(target.producer)) unavailable()
    } catch (error) {
      // Restoring a replaced provider cannot revive an already invalidated projection.
      target.invalidated = true
      throw error
    }
  }
  private result(record: unknown, input: HostTaskTargetCall): HostRemoteSessionJson {
    return parseHostRemoteSessionJson({ kind: 'task_target', record: captureHostTaskTargetResult(record, input) })
  }
  private prepared(descriptor: HostTaskTargetDescriptor, input: HostTaskTargetCall): HostRemoteSessionJson {
    return this.result({ ok: true, peer: descriptor.peer, record: { status: 'prepared', descriptor } }, input)
  }
  private previousProjection(journal: PairedTaskTargetJournal, input: HostTaskTargetCall): HostRemoteSessionJson | undefined {
    if (input.operation !== 'prepare') return unavailable()
    const previous = journal.findProjection(input.directive)
    if (!previous) return
    const target = this.loaded.get(previous.itemId)
    if (!target) return unavailable()
    this.targetCurrent(target)
    return this.prepared(parseHostTaskTargetDescriptor(JSON.parse(previous.descriptorJson)), input)
  }
  private async projection(call: CapturedCall, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    const { input } = call
    if (input.operation !== 'prepare') return unavailable()
    const d = input.directive
    if (this.journalPromise) {
      const journal = await this.journalPromise; call.current()
      const previous = this.previousProjection(journal, input)
      if (previous) return previous
    }
    if (this.loaded.size >= 10000) return unavailable()
    const producerValue: unknown = this.ctx.get('dsBotSlarkExternalGroup')
    if (!producerValue || typeof producerValue !== 'object' || !('readLocalBotChat' in producerValue)
      || typeof producerValue.readLocalBotChat !== 'function' || !('describeLocalBotSession' in producerValue)
      || typeof producerValue.describeLocalBotSession !== 'function') return unavailable()
    const producer = producerValue as BotProducer, description: unknown = await producer.readLocalBotChat(d.scope.botId)
    call.current()
    if (!description || typeof description !== 'object' || !('bot' in description) || !description.bot
      || typeof description.bot !== 'object' || !('sessionId' in description.bot) || typeof description.bot.sessionId !== 'string'
      || !('botId' in description.bot) || description.bot.botId !== d.scope.botId) return unavailable()
    const agent = this.ctx.agents.get(brandString<Agent['id']>(description.bot.sessionId))
    if (!agent || agent.status !== 'idle' || agent.inbox.nextStep.length || agent.inbox.nextTurn.length
      || !this.provider.supports(agent)) return unavailable()
    const tools = this.ctx.tools, executor = tools.inspectExecutor(agent)
    const snapshot = await this.provider.readLoadedSession(agent)
    const owned: unknown = await producer.describeLocalBotSession({ sessionId: agent.id })
    call.current()
    if (!snapshot || !snapshot.prefixLogDigest || !snapshot.isCurrent() || snapshot.session !== agent.session
      || !isDeepStrictEqual(owned, { botId: d.scope.botId, sessionId: agent.id })) return unavailable()
    const journal = await this.journal(); call.current()
    const previous = this.previousProjection(journal, input)
    if (previous) return previous
    const draft = { schemaVersion: 1, purpose: 'task_coordination_target_descriptor_v1', issuer: d.scope.accountIssuer,
      keyId: d.peer.installationId, scope: d.scope, transfer: d.transfer, originalStepHash: hostTaskTargetOriginalStepHash(d.originalStep),
      target: { hostProfileId: this.profileId, botId: d.scope.botId, sessionId: agent.id, commandId: randomUUID(),
        workerId: this.workerId, journalEpoch: journal.epoch, providerId: 'dsh.native-task-step/v1',
        providerDigest: hostTaskTargetProviderDigest(this.configuration.implementationDigest, this.configuration.compositionDigest),
        prefixEventCount: snapshot.logOffset, prefixLogDigest: snapshot.prefixLogDigest }, peer: d.peer,
      preparedAt: Date.now(), descriptorDigest: '0'.repeat(64), signature: 'A'.repeat(86) }
    const descriptor = parseHostTaskTargetDescriptor({ ...draft, descriptorDigest: hostTaskTargetDescriptorDigest(draft) })
    const retained = await journal.prepare(descriptor, signal); call.current()
    const target = { agent, tools, executor, snapshot, descriptor, producer, invalidated: false }; this.targetCurrent(target)
    this.loaded.set(retained.itemId, target)
    return this.prepared(descriptor, input)
  }
  private async intent(call: CapturedCall, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    if (call.input.operation !== 'ready_prepare') return unavailable()
    const proposal = call.input.directive, journal = await this.journal(); call.current()
    const inventory = journal.inventory(proposal.scope), projection = inventory.find(entry => entry.kind === 'projection'
      && entry.value.descriptorDigest === proposal.descriptorDigest)
    if (!projection || projection.kind !== 'projection') return unavailable()
    const loaded = this.loaded.get(projection.value.itemId)
    if (!loaded || !loaded.snapshot.isCurrent()) return unavailable()
    this.targetCurrent(loaded)
    const descriptor = parseHostTaskTargetDescriptor(JSON.parse(projection.value.descriptorJson))
    if (!installationSignature(encodeHostTaskTargetDescriptor(descriptor), descriptor.signature, call.peer.publicKey)) return unavailable()
    const old = inventory.find(entry => entry.kind === 'admission' && entry.value.admissionId === proposal.newSourceGrant.admissionId)
    let admission: PairedTaskTargetAdmission
    if (old?.kind === 'admission') {
      if (old.value.readyJson !== JSON.stringify(proposal) || old.value.state !== 'consume_intent') return unavailable()
      admission = old.value
    } else {
      const challenge = parseHostTaskTargetConsumeChallengeForProposal({ schemaVersion: 1,
        purpose: 'task_coordination_target_consume_challenge_v1', issuer: proposal.issuer, keyId: call.peer.installationId,
        scope: proposal.scope, transfer: proposal.transfer, admissionId: proposal.newSourceGrant.admissionId,
        readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(proposal), descriptorDigest: proposal.descriptorDigest,
        target: proposal.target, consumeIntentId: randomUUID(), nonce: randomBytes(32).toString('base64url'),
        issuedAt: Date.now(), expiresAt: proposal.expiresAt, peer: proposal.peer, signature: 'A'.repeat(86) }, proposal)
      admission = await journal.consumeIntent(projection.value.itemId, proposal, challenge, signal)
    }
    call.current()
    const challenge = parseHostTaskTargetConsumeChallengeForProposal(JSON.parse(admission.challengeJson), proposal)
    return this.result({ ok: true, peer: proposal.peer, record: { status: 'consume_intent', challenge } }, call.input)
  }
  private async originalAdmission(call: CapturedCall) {
    if (call.input.operation !== 'ready_start') return unavailable()
    const journal = await this.journal(); call.current()
    const admission = journal.admissionByIntent(call.input.receipt.consumeIntentId)
    if (!admission || admission.state === 'unknown') return unavailable()
    const proposal = parseHostTaskReadyAdmissionDirective(JSON.parse(admission.readyJson))
    const challenge = parseHostTaskTargetConsumeChallengeForProposal(JSON.parse(admission.challengeJson), proposal)
    parseHostTaskTargetConsumeReceiptForChallenge(call.input.receipt, proposal, challenge)
    if (proposal.accountBindingId !== call.account.accountBindingId || proposal.accountBindingVersion !== call.account.accountBindingVersion
      || !installationSignature(encodeHostTaskTargetConsumeChallenge(challenge), challenge.signature, call.peer.publicKey))
      return unavailable()
    // Re-authenticate the original Source proposal; a consume receipt never replaces its Account binding.
    this.capture({ operation: 'ready_prepare', directive: proposal }, call.account, call.peer,
      call.binding, new AbortController().signal)
    return { journal, admission, proposal, challenge }
  }

  private async observe(call: CapturedCall): Promise<HostRemoteSessionJson> {
    if (call.input.operation !== 'observe') return unavailable()
    const d = call.input.directive, journal = await this.journal(); call.current()
    for (const [id, snapshot] of this.inventories) if (snapshot.expiresAt <= Date.now()) {
      this.inventories.delete(id)
      for (const [cursor, value] of this.cursors) if (value.inventoryId === id) this.cursors.delete(cursor)
    }
    const binding = hash([call.account, call.peer, d.scopeDigest, d.floorDigest, d.transfer])
    let inventoryId: string, offset = 0
    if (d.inventoryId === null) {
      if (this.inventories.size >= 8) return unavailable()
      inventoryId = randomUUID()
      const records = journal.inventory(d.scope)
      const descriptors = new Map(records.filter(entry => entry.kind === 'projection')
        .map(entry => [entry.value.itemId, parseHostTaskTargetDescriptor(JSON.parse(entry.value.descriptorJson))]))
      const items = records.map((entry) => {
        const admission = entry.kind === 'admission' ? entry.value : undefined
        const descriptor = descriptors.get(admission ? admission.projectionId : entry.value.itemId)
        if (!descriptor) return unavailable()
        const evidence = admission ? this.native.pairedEvidence(admission.admissionId) : null
        const disposition = evidence?.isCurrent() ? evidence.state : 'unknown'
        return parseHostTaskTargetObservationItem({ itemId: entry.value.itemId, kind: entry.kind,
          commandId: descriptor.target.commandId, transferRequestId: descriptor.transfer.requestId,
          coordinationEpoch: descriptor.scope.acceptedCoordinationEpoch, originalStepHash: descriptor.originalStepHash,
          descriptorDigest: descriptor.descriptorDigest, target: descriptor.target, state: admission?.state ?? 'prepared',
          admissionId: admission?.admissionId ?? null, consumeIntentId: admission?.consumeIntentId ?? null,
          sourceConsumeReceiptDigest: admission?.sourceConsumeReceiptDigest ?? null,
          messageId: admission?.messageId ?? null, turn: admission?.turn ?? null, step: admission?.step ?? null,
          recordDigest: hash([entry.value, evidence?.recordDigest ?? null]), disposition })
      }).sort((a, b) => Buffer.compare(Buffer.from(a.itemId), Buffer.from(b.itemId)))
      const coverage = records.length > 0 && records.every(entry => entry.kind === 'admission'
        || this.loaded.has(entry.value.itemId)) ? 'complete' : 'unknown'
      this.inventories.set(inventoryId, { binding, expiresAt: d.expiresAt, items,
        digest: hostTaskTargetInventoryDigest(items), coverage })
    } else {
      inventoryId = d.inventoryId
      const cursor = d.cursor && this.cursors.get(d.cursor)
      if (!cursor || cursor.inventoryId !== inventoryId) return unavailable()
      offset = cursor.offset
    }
    const snapshot = this.inventories.get(inventoryId)
    if (!snapshot || snapshot.binding !== binding || Date.now() >= snapshot.expiresAt) return unavailable()
    const page: HostTaskTargetObservationItem[] = []
    for (const item of snapshot.items.slice(offset, offset + 50)) {
      if (Buffer.byteLength(JSON.stringify([...page, item]), 'utf8') > 16384) break
      page.push(item)
    }
    if (!page.length && snapshot.items.length) return unavailable()
    const eof = offset + page.length === snapshot.items.length, nextCursor = eof ? null : randomUUID()
    if (nextCursor) {
      if (this.cursors.size >= 2048) return unavailable()
      this.cursors.set(nextCursor, { inventoryId, offset: offset + page.length })
    }
    call.current()
    // Prepared metadata and an empty list never establish that every producer has stopped.
    const observation = parseHostTaskTargetObservation({ schemaVersion: 1, purpose: 'task_coordination_target_observation_v1',
      issuer: d.issuer, keyId: d.peer.installationId, requestId: d.requestId,
      directiveDigest: hostTaskTargetObserveDirectiveDigest(d), issuedAt: d.issuedAt, expiresAt: d.expiresAt,
      scopeDigest: d.scopeDigest, floorDigest: d.floorDigest, transfer: d.transfer, journalEpoch: journal.epoch,
      inventoryId, inventoryDigest: snapshot.digest, totalCount: snapshot.items.length, items: page, nextCursor, eof,
      coverage: snapshot.coverage, quiescence: snapshot.items.some(item => item.disposition === 'in_flight') ? 'in_flight' : 'unknown',
      observedAt: Date.now(), workerId: this.workerId, peer: d.peer, signature: 'A'.repeat(86) })
    return this.result({ ok: true, peer: d.peer, record: { status: 'observed', observation } }, call.input)
  }

  /** Execute only actions supplied by authenticated Main; public requests never supply a lease or validator.
   * @param action - Closed private phase, with read-only original lookup preceding Main's signature checks.
   * @param value - Exact original signed public call.
   * @param account - Actual Account facts supplied on the private parent connection.
   * @param peer - Actual installation/process facts supplied by the parent.
   * @param bindingKey - Private current Main/Account/process binding.
   * @param signal - Actual parent request lifetime; run phases retain the long Account registration.
   * @param signed - Main's retained descriptor/challenge signature for commit; absent for other phases.
   * @returns Bounded metadata or completion after the original execution has drained.
   */
  async execute(action: 'task_target' | 'task_target_commit' | 'task_target_run' | 'task_target_wait_claim', value: unknown,
    account: unknown, peer: unknown, bindingKey: string, signal: AbortSignal, signed?: unknown): Promise<HostRemoteSessionJson> {
    const call = this.capture(value, account, peer, bindingKey, signal)
    if (action === 'task_target' && call.input.operation === 'prepare') return this.projection(call, signal)
    if (action === 'task_target' && call.input.operation === 'ready_prepare') return this.intent(call, signal)
    if (action === 'task_target' && call.input.operation === 'observe') return this.observe(call)
    if (action === 'task_target_commit') {
      const journal = await this.journal(); call.current()
      if (!signed || typeof signed !== 'object' || !('kind' in signed) || !('value' in signed)) return unavailable()
      if (call.input.operation === 'prepare' && signed.kind === 'descriptor') {
        const descriptor = parseHostTaskTargetDescriptor(signed.value), projection = journal.findProjection(call.input.directive)
        if (!projection || !installationSignature(encodeHostTaskTargetDescriptor(descriptor), descriptor.signature, call.peer.publicKey))
          return unavailable()
        const retained = await journal.commitProjection(projection.itemId, descriptor, signal); call.current()
        return this.prepared(parseHostTaskTargetDescriptor(JSON.parse(retained.descriptorJson)), call.input)
      }
      if (call.input.operation === 'ready_prepare' && signed.kind === 'challenge') {
        const proposal = call.input.directive, challenge = parseHostTaskTargetConsumeChallengeForProposal(signed.value, proposal)
        const admission = journal.admissionByIntent(challenge.consumeIntentId)
        if (!admission || !installationSignature(encodeHostTaskTargetConsumeChallenge(challenge), challenge.signature, call.peer.publicKey))
          return unavailable()
        const retained = await journal.commitChallenge(admission.itemId, challenge, signal); call.current()
        const committed = parseHostTaskTargetConsumeChallengeForProposal(JSON.parse(retained.challengeJson), proposal)
        return this.result({ ok: true, peer: proposal.peer, record: { status: 'consume_intent', challenge: committed } }, call.input)
      }
      return unavailable()
    }
    if (call.input.operation !== 'ready_start') return unavailable()
    const input = call.input, { journal, admission, proposal, challenge } = await this.originalAdmission(call)
    if (action === 'task_target') return parseHostRemoteSessionJson({ kind: 'task_target_original', proposal, challenge })
    const recorded = (record: PairedTaskTargetAdmission) => this.result({ ok: true, peer: input.receipt.peer,
      record: { status: 'recorded', commandId: proposal.target.commandId, admissionId: record.admissionId,
        consumeIntentId: record.consumeIntentId, journalEpoch: journal.epoch, workerId: this.workerId, state: record.state,
        messageId: record.messageId, turn: record.turn, step: record.step, recordDigest: hash(record) } }, input)
    if (action === 'task_target_wait_claim') return recorded(await this.runs.waitClaim(admission.consumeIntentId, call.binding, signal))
    if (admission.state !== 'consume_intent') return unavailable()
    const loaded = this.loaded.get(admission.projectionId)
    if (!loaded || !loaded.snapshot.isCurrent()) return unavailable()
    this.targetCurrent(loaded)
    return recorded(await this.runs.run(admission.consumeIntentId, call.binding, async (short) => {
      const body = parseHostTaskTargetStepBody(input.stepBody)
      const owned = AbortSignal.any([signal, this.lifetime, this.provider.lifetime])
      const current = () => {
        owned.throwIfAborted(); this.targetCurrent(loaded)
        if (this.ctx.get('pairedTaskTargetConsumerHost') !== this.service) unavailable()
      }
      current(); short.throwIfAborted()
      const files = new PairedTaskTargetFiles(this.ctx, loaded.agent, body.permissions, current, owned)
      let hooks: ReturnType<DesktopTaskCoordinationNative['bindPaired']>
      try { hooks = this.native.bindPaired({ agent: loaded.agent, session: loaded.agent.session, proposal, body,
        files, signal: owned, current }) }
      catch (error) { await files.close(); throw error }
      try {
        const consumed = await journal.recordSourceConsumption(admission.itemId, input.receipt, short)
        current(); short.throwIfAborted()
        const capability = Object.freeze({ kind: 'paired-task-step-capability' as const })
        this.capabilities.set(capability, { agent: loaded.agent, session: loaded.agent.session, admission: consumed,
          proposal, body, signal: owned, assertCurrent: current, ...hooks })
        return await this.ctx.sessionController.consumePairedTaskTarget(capability, short)
      } catch (error) { await hooks.finished(); throw error }
    }, signal))
  }

  /** Stop new private requests and drain actual runs before the owning Controller closes its journal.
   * The bootstrap aborts the original worker lifetime before calling this method.
   * @returns Completion after every accepted long run releases its actual Native resources.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.runs.close(); this.loaded.clear(); this.inventories.clear(); this.cursors.clear()
  }
}
