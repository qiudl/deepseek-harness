/** Actual worker bootstrap for the native metadata lane. Private request contexts never expose proof or token seeding. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectOperationOrigins, ProjectOperationRuntimeEntryPublication,
  ProjectOperationMemorySourceAuthorization } from '@deepseek-ai/dsh-api-session-controller'
import type { RuntimeEntryConsumerHost } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-consumer-host'
import type { RuntimeEntryConsumerOriginal } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-consumer'
import { RuntimeEntryJournal, readRuntimeEntryEffect, readRuntimeEntryWitnessByAttempt } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-journal'
import type { RuntimeEntryOriginalMetadata } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry'
import { parseHostRuntimeEntryOriginsJson, type HostRuntimeEntryOriginsConfiguration } from '@deepseek-ai/dsh-host-control-protocol'
import { parseRuntimeEntryConsumerGrant, parseRuntimeEntryMetadataAuthorization, encodeRuntimeEntryMetadataAuthorization,
  type RuntimeEntryMetadataAuthorization } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRuntimeEntryInstalledOrigin, HostBotGroupPublicKeyring } from '@deepseek-ai/dsh-host-control-protocol'
import { parseRuntimeEntryAnalysisCommand, parseRuntimeEntryOriginCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { parseRuntimeEntryObservation, parseRuntimeEntryAttribution, encodeRuntimeEntryAttribution,
  runtimeEntryAttributionDigest, runtimeEntryObservationDigest, runtimeEntrySourceEventMappingDigest,
  runtimeEntryBindingDigest } from '@deepseek-ai/dsh-host-control-protocol'
import { parseTaskCoordinationActualAccount, parseTaskCoordinationActualPeer } from './desktop-task-coordination.ts'
import { createRuntimeResolutionLookup } from '@deepseek-ai/dsh-app-boot'
import { readHostRuntimeEntryOwnerManifest, verifyHostRuntimeEntryOwners, runtimeEntrySealedRuntimeRoot,
  assertRuntimeEntryLoadedNativeBinding } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopRuntimeEntryInstalledOrigin } from '@deepseek-ai/dsh-web-app/installed-origin'
import { DesktopRuntimeEntryOrigin } from './desktop-runtime-entry-origin.ts'
function unavailable(): never { throw Error('runtime_entry_unavailable') }
function original(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, symbols.original) ?? value : value
}
type Account = { authorityEnvironmentId: string
  accountIssuer: string
  accountSubject: string
  accountBindingId: string
  accountBindingVersion: number
  hostProfileId: string }
type LocalPeer = { installationId: string
  publicKey: string
  hostInstanceId: string
  processNonce: string }
type Producer = { describeLocalBotSession(input: { sessionId: string }): unknown }
interface OriginalContext {
  readonly proof: RuntimeEntryMetadataAuthorization
  readonly signal: AbortSignal
  readonly generation: bigint
  readonly grant: ReturnType<typeof parseRuntimeEntryConsumerGrant> | undefined
  readonly publication: ProjectOperationRuntimeEntryPublication | null
  original?: RuntimeEntryOriginalMetadata
}
/** Actual file hashes, not module names, define this optional implementation. */
function artifacts(c: HostRuntimeEntryOriginsConfiguration, ctx?: Context): void {
  if (c.schemaVersion === 3) {
    if (!ctx) unavailable()
    const resolution = ctx.get('pluginPackages')?.resolution
    if (!resolution?.profileDir || resolution.linkedRoots.some(root => root.name === 'ds-bot')) unavailable()
    const m = readHostRuntimeEntryOwnerManifest(c)
    assertRuntimeEntryLoadedNativeBinding(m)
    verifyHostRuntimeEntryOwners(m, runtimeEntrySealedRuntimeRoot(c), realpathSync(resolution.profileDir),
      createRuntimeResolutionLookup(resolution))
    return
  }
  let total = 0
  for (const pin of c.artifactPins) {
    const before = lstatSync(pin.path)
    if (!before.isFile() || before.isSymbolicLink() || realpathSync(pin.path) !== pin.path || before.size > 64 * 1024 * 1024) unavailable()
    total += before.size
    if (total > 128 * 1024 * 1024 || createHash('sha256').update(readFileSync(pin.path)).digest('hex') !== pin.sha256) unavailable()
    const after = lstatSync(pin.path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) unavailable()
  }
}
/** Create only a cold original-attempt locator, independently of Native writer availability.
 * @param ctx - Actual injected SessionController owner; requests cannot supply a reader or record.
 * @param configuration - Parent-pinned implementation artifacts from this worker boot.
 * @param profileId - Actual fixed Profile identity from the parent bootstrap.
 * @param lifetime - Actual worker cancellation scope.
 * @returns A body-free read-only locator; it cannot start, publish or renew an original attempt.
 */
export function createDesktopRuntimeEntryLocator(ctx: Context, configuration: HostRuntimeEntryOriginsConfiguration,
  profileId: string, lifetime: AbortSignal): (operation: unknown, signal: AbortSignal) => Promise<{ entryId: string | null }> {
  artifacts(configuration, ctx)
  const root = process.env.DSH_HOME, controller = ctx.sessionController
  if (!root || realpathSync(root) !== root || !profileId) unavailable()
  const path = join(root, 'runtime-entry.sqlite')
  return async (operation, signal) => {
    const current = (): void => {
      signal.throwIfAborted(); lifetime.throwIfAborted()
      if (ctx.fiber.state !== FiberState.ACTIVE || original(ctx.get('sessionController')) !== original(controller)) unavailable()
      artifacts(configuration, ctx)
    }
    current()
    const command = parseRuntimeEntryOriginCommand(operation)
    const record = await controller.inspectRuntimeEntryConsumer(command, AbortSignal.any([signal, lifetime]))
    current()
    if (!record || record.state === 'prepared') return { entryId: null }
    const witness = readRuntimeEntryWitnessByAttempt(path, record.grant.consumer_attempt_id, record.command.command_id)
    current()
    if (witness && String(witness.receipt.binding.hostProfileId) !== profileId) unavailable()
    return { entryId: witness?.receipt.entryId ?? null }
  }
}

/** One real boot owner: actual providers, driver, exclusive private journal and original authenticated request context. */
export class DesktopRuntimeEntryHost {
  private readonly installedSource: DesktopRuntimeEntryInstalledOrigin | undefined
  private readonly contexts = new Map<string, OriginalContext>()
  private readonly journal: RuntimeEntryJournal
  private readonly journalPath: string
  private readonly origin: DesktopRuntimeEntryOrigin
  private readonly providers
  private generation = 1n
  private readonly selected = new WeakMap<Agent, object>()
  /** API sees readonly readers/opaque preparation only, not the request-context owner below. */
  readonly service: RuntimeEntryConsumerHost
  /** @param ctx - Actual worker Context, with original loaded Session metadata readers.
   * @param configuration - Explicit parent-owned nonsecret artifact closure.
   * @param keyrings - Reserved pinned Source public keys.
   * @param profileId - Actual parent-selected Profile.
   * @param workerId - Actual owned worker lifetime UUID.
   * @param lifetime - Real worker owner cancellation.
   */
  constructor(private readonly ctx: Context, private readonly configuration: HostRuntimeEntryOriginsConfiguration,
    private readonly keyrings: readonly HostBotGroupPublicKeyring[], private readonly profileId: string,
    private readonly workerId: string, private readonly lifetime: AbortSignal) {
    artifacts(configuration, ctx)
    this.installedSource = ctx.get('runtimeEntryInstalledOrigin')
    const root = process.env.DSH_HOME
    if (!root || realpathSync(root) !== root || !profileId || !workerId || !keyrings.length) unavailable()
    this.providers = { tools: ctx.tools, loop: ctx.agentLoop, sessions: ctx.sessions, agents: ctx.agents,
      persistence: ctx.sessionPersistence }
    this.journalPath = join(root, 'runtime-entry.sqlite')
    this.journal = new RuntimeEntryJournal(this.journalPath)
    ctx.on('tools/change', () => { this.generation++ })
    const current = (agent: Agent) => this.supports(agent)
    const currentGeneration = () => this.generation.toString()
    this.origin = new DesktopRuntimeEntryOrigin(ctx, { factoryOptions: {
      journal: this.journal, workerLifetimeId: workerId, implementationDigest: configuration.implementationDigest,
      compositionDigest: configuration.compositionDigest,
      get registryGeneration() { return currentGeneration() },
      get compositionAuthorityDigest() {
        return createHash('sha256').update('dsh.runtime-entry.current-composition/v1\0' + JSON.stringify([
          workerId, configuration.implementationDigest, configuration.compositionDigest, configuration, currentGeneration(),
        ])).digest('hex')
      },
      readOriginalMetadata: async (agent, commandId, signal) => {
        if (!current(agent)) return undefined
        return (await this.readOriginal(commandId, signal)).metadata
      }, readLoadedSession: agent => this.providers.loop.readOriginalInvocationEntrySession(agent), isCurrentComposition: current,
    }, isCurrent: current,
    readHistoricalMetadata: (commandId, signal) => this.metadata(commandId, signal),
    bindOriginalEntry: (request, signal) => {
      const entry = this.contexts.get(request.originalCommandId)
      if (!entry || entry.signal.aborted || signal.aborted || !this.contextCurrent(entry)) return Promise.resolve(null)
      const p = entry.publication
      return Promise.resolve(p?.entryId === request.entryId && p.sourceEventId === request.sourceEventId
        && p.sourceRevision === request.sourceRevision ? p : null)
    } })
    this.service = Object.freeze({ lifetime, supports: current,
      canPrepare: (commandId?: string) => this.providersCurrent() && this.journal.canRetainMetadataAuthorization(commandId),
      readLoadedSession: (agent: Agent) => this.providers.loop.readOriginalInvocationEntrySession(agent),
      readOriginal: (commandId: string, signal: AbortSignal) => this.readOriginal(commandId, signal),
      prepareEntry: (agent: Agent, commandId: string, signal: AbortSignal) => this.origin.prepare(agent, commandId, signal),
    })
    ctx.effect(() => async () => {
      this.origin.close()
      const agents = [...this.contexts.values()].map(entry => this.providers.agents.get(brandString<Agent['id']>(entry.proof.metadata.binding.sessionId)))
        .filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'parent' }, { keepInbox: true })
      await Promise.all(agents.map(agent => agent.whenIdle()))
      this.contexts.clear(); this.journal.close()
    })
  }
  /** Return the original actual registration identity to the owned parent channel.
   * @returns Fixed code-source metadata, or null when source registration is absent or replaced. */
  installedOrigin(): HostRuntimeEntryInstalledOrigin | null { return this.installedSource?.read() ?? null }
  /** Compose the original operation reader with this owner's opaque entry reader.
   * @param reader - Actual original historical-operation reader.
   * @returns Its one composite reader, installed before either purpose can emit an opaque token. */
  readerWith(reader: ProjectOperationOrigins): ProjectOperationOrigins { return this.origin.readerWith(reader) }
  /** Read only an original private effect under the memory reader's current scoped token.
   * @param reference - Exact entry/receipt/manifest identity, never a sequence or path.
   * @param view - Actual immutable source view read inside the memory provider WeakMap.
   * @param signal - Current memory publication cancellation.
   * @returns Original effect metadata, or null; this is not a Source/export grant.
   */
  readEffect(reference: Readonly<{ entryId: string
    entryReceiptDigest: string
    manifestDigest: string }>,
  view: ProjectOperationMemorySourceAuthorization, signal: AbortSignal): NonNullable<ReturnType<typeof readRuntimeEntryEffect>> | null {
    signal.throwIfAborted()
    if (!this.providersCurrent() || Date.now() >= view.deadline) unavailable()
    view.signal.throwIfAborted()
    const witness = this.journal.read(reference.entryId)
    if (!witness) return null
    const b = witness.receipt.binding, proof = this.journal.metadataAuthorization(b.consumerCommandId)
    if (!proof || String(b.ownerUserId) !== String(view.ownerUserId)
      || String(b.authorityEnvironmentId) !== String(view.authorityEnvironmentId)
      || String(b.hostProfileId) !== String(view.local.hostProfileId)
        || String(b.hostProfileId) !== String(view.scope.sourceRef.hostProfileId)
      || String(b.botId) !== String(view.local.botId) || String(b.botId) !== String(view.scope.sourceRef.botRootId)
      || !Object.is(proof.metadata.projectId, view.projectId) || !Object.is(proof.metadata.projectId, view.scope.projectId)
      || proof.accountIssuer !== view.local.accountIssuer || proof.accountSubject !== String(view.local.accountSubject)) unavailable()
    this.signature(proof, false)
    this.identity(proof, view.local, view.local.peer, false)
    const effect = readRuntimeEntryEffect(this.journalPath, reference)
    signal.throwIfAborted()
    if (!this.providersCurrent()) unavailable()
    return effect ?? null
  }
  private providersCurrent(): boolean {
    if (this.configuration.schemaVersion !== 3 || !this.installedSource?.read()) return false
    return !this.lifetime.aborted && this.ctx.fiber.state === FiberState.ACTIVE && this.ctx.get('runtimeEntryConsumerHost') === this.service
      && original(this.ctx.get('tools')) === original(this.providers.tools) && original(this.ctx.get('agentLoop')) === original(this.providers.loop)
      && original(this.ctx.get('sessions')) === original(this.providers.sessions) && original(this.ctx.get('agents')) === original(this.providers.agents)
      && original(this.ctx.get('sessionPersistence')) === original(this.providers.persistence)
  }
  private supports(agent: Agent): boolean {
    if (this.configuration.schemaVersion !== 3 || !this.installedSource?.read()) return false
    if (!this.providersCurrent() || this.providers.agents.get(agent.id) !== agent
      || this.providers.sessions.get(agent.id) !== agent.session) return false
    try {
      artifacts(this.configuration, this.ctx)
      const selected = this.providers.tools.inspectExecutor(agent)
      if (!(selected instanceof NativeToolExecutor) || Object.getPrototypeOf(selected) !== NativeToolExecutor.prototype) return false
      const previous = this.selected.get(agent)
      if (previous && previous !== selected) this.generation++
      this.selected.set(agent, selected)
      return true
    } catch { return false }
  }
  private contextCurrent(entry: OriginalContext): boolean {
    if (this.configuration.schemaVersion !== 3 || !this.installedSource?.read()) return false
    if (!this.providersCurrent() || entry.signal.aborted || entry.generation !== this.generation
      || this.contexts.get(entry.proof.metadata.binding.consumerCommandId) !== entry) return false
    artifacts(this.configuration, this.ctx)
    return true
  }
  private async metadata(commandId: string, signal: AbortSignal): Promise<RuntimeEntryOriginalMetadata | undefined> {
    const entry = this.contexts.get(commandId)
    if (!entry || signal.aborted || !this.contextCurrent(entry)) return undefined
    if (entry.original) return entry.original
    const p = this.ctx.get('dsBotSlarkExternalGroup') as Producer | undefined
    if (!p || typeof p.describeLocalBotSession !== 'function') return undefined
    const result: unknown = await p.describeLocalBotSession({ sessionId: entry.proof.metadata.binding.sessionId })
    signal.throwIfAborted()
    if (!result || typeof result !== 'object' || !('botId' in result) || !('sessionId' in result)
      || result.botId !== entry.proof.metadata.binding.botId || result.sessionId !== entry.proof.metadata.binding.sessionId
      || this.ctx.get('dsBotSlarkExternalGroup') !== p || !this.contextCurrent(entry)) return undefined
    const m = entry.proof.metadata
    entry.original = Object.freeze({ binding: m.binding, projectId: brandString<RuntimeEntryOriginalMetadata['projectId']>(m.projectId),
      taskRef: m.taskRef === null ? null : brandString<NonNullable<RuntimeEntryOriginalMetadata['taskRef']>>(m.taskRef),
      dispatchGranted: m.dispatchGranted, sourceKind: m.sourceKind, originalAuthorityDigest: m.originalAuthorityDigest,
      accountAuthorityDigest: m.accountAuthorityDigest,
      isCurrent: () => this.ctx.get('dsBotSlarkExternalGroup') === p && this.contextCurrent(entry) })
    return entry.original
  }
  private async readOriginal(commandId: string, signal: AbortSignal): Promise<RuntimeEntryConsumerOriginal> {
    const metadata = await this.metadata(commandId, signal), entry = this.contexts.get(commandId)
    if (!metadata || !entry?.grant || !metadata.isCurrent()) unavailable()
    return Object.freeze({ metadata, consumerGrant: entry.grant, consumerGrantMetadata: entry.proof.metadata.consumerGrantMetadata })
  }
  private signature(proof: RuntimeEntryMetadataAuthorization, fresh: boolean): void {
    const ring = this.keyrings.find(r => r.environmentId === proof.authorityEnvironmentId && r.issuer === proof.issuer)
    const key = ring?.keys.find(k => k.kid === proof.keyId), now = Date.now()
    if (!key || proof.issuedAt < key.validFrom || proof.expiresAt > key.validUntil || proof.issuedAt > now
      || fresh && now >= proof.expiresAt || !verify(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization(proof)),
      createPublicKey(key.publicKeyPem), Buffer.from(proof.signature, 'base64url'))) unavailable()
  }
  private identity(proof: RuntimeEntryMetadataAuthorization, account: Account, peer: LocalPeer, fresh: boolean): void {
    const keys = ['authorityEnvironmentId', 'accountIssuer', 'accountSubject'] as const
    if (keys.some(key => proof[key] !== account[key]) || account.hostProfileId !== this.profileId
      || proof.metadata.binding.hostProfileId !== this.profileId || proof.peer.installationId !== peer.installationId
      || proof.peer.publicKey !== peer.publicKey || fresh && (proof.accountBindingId !== account.accountBindingId
        || proof.accountBindingVersion !== account.accountBindingVersion || proof.peer.hostInstanceId !== peer.hostInstanceId
        || proof.peer.processNonce !== peer.processNonce)) unavailable()
  }
  /** Dispatch only authenticated Parent metadata purposes under the reserved actual worker lifetime.
   * @param row - Private HTTP envelope after bearer/key admission, never a public caller context.
   * @param signal - Original Parent request cancellation.
   * @returns Body-free execution/read/preparation or the original real consumer result. */
  async analyze(row: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (row.actualWorkerId !== this.workerId) unavailable()
    const account = parseTaskCoordinationActualAccount(row.actualAccount), peer = parseTaskCoordinationActualPeer(row.actualPeer)
    const command = parseRuntimeEntryAnalysisCommand({ action: row.action, purpose: row.purpose, operation: row.operation,
      ...(Object.hasOwn(row, 'metadataAuthorization') ? { metadataAuthorization: row.metadataAuthorization } : {}) })
    if (command.action === 'root_execution_journal')
      return this.ctx.sessionController.collaborationRuntimeEntryExecution(command.operation, signal)
    const work = (active: AbortSignal) =>
      this.ctx.sessionController.collaborationRuntimeEntryConsumption(command.operation, active, account)
    return command.operation.action === 'consumer_start'
      ? this.withStart(command.metadataAuthorization, command.operation.grant, account, peer, signal, work) : work(signal)
  }

  /** Resolve only the original durable consumer attempt; it never opens reply or Source bodies.
   * @param operation - Closed native origin selectors.
   * @param signal - Current authenticated Main request.
   * @returns Existing entry identity or null; caller paths, sequences and candidate metadata are never accepted. */
  async locate(operation: unknown, signal: AbortSignal): Promise<{ entryId: string | null }> {
    const command = parseRuntimeEntryOriginCommand(operation)
    const original = await this.ctx.sessionController.inspectRuntimeEntryConsumer(command, signal)
    signal.throwIfAborted()
    if (!original || original.state === 'prepared') return { entryId: null }
    const witness = this.journal.byAttempt(original.grant.consumer_attempt_id)
    return { entryId: witness?.receipt.binding.consumerCommandId === original.command.command_id ? witness.receipt.entryId : null }
  }

  /** Await the actual DSBot immutable publisher with a new scoped token, preserving the original candidate and entry.
   * @param operation - Full original Source-signed observation/attribution pair.
   * @param actualPublication - Main's independently verified semantic projection, not a public request field.
   * @param account - Actual current Parent Account.
   * @param peer - Actual current Parent installation/process identity.
   * @param signal - Current original metadata request cancellation.
   * @returns Real publication acknowledgment; this never reenters a driver or materializes feedback. */
  async publish(operation: unknown, actualPublication: unknown, account: Account, peer: LocalPeer, signal: AbortSignal): Promise<boolean> {
    const command = parseRuntimeEntryOriginCommand(operation)
    if (command.purpose !== 'runtime_entry_bind') unavailable()
    const observation = parseRuntimeEntryObservation(command.observation), attribution = parseRuntimeEntryAttribution(command.attribution)
    const located = await this.locate(command, signal)
    if (located.entryId !== observation.receipt.entryId) unavailable()
    const proof = this.journal.metadataAuthorization(observation.receipt.binding.consumerCommandId)
    if (!proof) unavailable()
    this.signature(proof, false); this.identity(proof, account, peer, false)
    if (command.metadataAuthorization) {
      const fresh = command.metadataAuthorization
      this.signature(fresh, true); this.identity(fresh, account, peer, true)
      if (fresh.metadata.dispatchGranted
        || runtimeEntryBindingDigest(fresh.metadata.binding) !== runtimeEntryBindingDigest(proof.metadata.binding)
        || fresh.metadata.originalAuthorityDigest !== proof.metadata.originalAuthorityDigest) unavailable()
    }
    const ring = this.keyrings.find(r => r.environmentId === attribution.authorityEnvironmentId && r.issuer === attribution.issuer)
    const key = ring?.keys.find(k => k.kid === attribution.keyId)
    if (!key || attribution.issuedAt < key.validFrom || attribution.expiresAt > key.validUntil
      || !verify(null, Buffer.from(encodeRuntimeEntryAttribution(attribution)), createPublicKey(key.publicKeyPem),
        Buffer.from(attribution.signature, 'base64url'))) unavailable()
    const m = observation.sourceEventMapping
    if (!m) unavailable()
    const projection: ProjectOperationRuntimeEntryPublication = Object.freeze({
      attributionDigest: runtimeEntryAttributionDigest(attribution), observationDigest: runtimeEntryObservationDigest(observation),
      mappingDigest: runtimeEntrySourceEventMappingDigest(m), entryId: brandString<ProjectOperationRuntimeEntryPublication['entryId']>(observation.receipt.entryId),
      entryReceiptDigest: attribution.entryReceiptDigest, manifestDigest: attribution.manifestDigest,
      projectId: brandString<ProjectOperationRuntimeEntryPublication['projectId']>(proof.metadata.projectId),
      sourceEventId: brandString<ProjectOperationRuntimeEntryPublication['sourceEventId']>(attribution.sourceEventId),
      sourceRevision: attribution.sourceRevision, payloadDigest: attribution.payloadDigest })
    if (JSON.stringify(projection) !== JSON.stringify(actualPublication)) unavailable()
    const commandId = proof.metadata.binding.consumerCommandId
    if (this.contexts.has(commandId) || this.contexts.size >= 32) unavailable()
    const entry: OriginalContext = { proof, grant: undefined, signal: AbortSignal.any([signal, this.lifetime]),
      generation: this.generation, publication: projection }
    this.contexts.set(commandId, entry)
    try {
      this.journal.retainPublicationPair(observation.receipt.entryId, { observation, attribution }, () => this.contextCurrent(entry))
      return await this.origin.publishOriginalEntry(observation.receipt.entryId, entry.signal)
    }
    finally { if (this.contexts.get(commandId) === entry) this.contexts.delete(commandId) }
  }

  /** Bind the fresh signed metadata context only around the original authenticated Main start request.
   * @param proofValue - Main-verified Source wrapper, independently signature-checked here.
   * @param rawGrant - Original raw grant from that same response.
   * @param account - Actual Parent Account, never read from the public operation.
   * @param peer - Actual Parent installation/process facts.
   * @param signal - Original private request lifetime.
   * @param work - The real controller operation, with no caller-provided metadata/fence functions.
   * @returns Original controller result; finally permanently revokes this request's local context.
   */
  async withStart<T>(proofValue: unknown, rawGrant: unknown, account: Account, peer: LocalPeer, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const proof = parseRuntimeEntryMetadataAuthorization(proofValue), grant = parseRuntimeEntryConsumerGrant(rawGrant)
    this.signature(proof, true); this.identity(proof, account, peer, true)
    if (!proof.metadata.dispatchGranted || !grant.dispatch_granted || proof.metadata.binding.consumerCommandId !== grant.command_id)
      unavailable()
    const commandId = proof.metadata.binding.consumerCommandId
    if (this.contexts.has(commandId) || this.contexts.size >= 32) unavailable()
    const active = AbortSignal.any([signal, this.lifetime, AbortSignal.timeout(Math.max(1, proof.expiresAt - Date.now()))])
    const entry: OriginalContext = { proof, grant, signal: active, generation: this.generation, publication: null }
    this.contexts.set(commandId, entry)
    try {
      this.journal.retainMetadataAuthorization(proof, () => this.contextCurrent(entry) && Date.now() < proof.expiresAt)
      return await work(active)
    } finally { if (this.contexts.get(commandId) === entry) this.contexts.delete(commandId) }
  }
}

/** Parse the explicit embedding-owned Native entry configuration.
 * @param raw - Explicit reserved startup JSON.
 * @returns Parsed optional configuration; this function does not advertise a capability. */
export const runtimeEntryConfiguration = parseHostRuntimeEntryOriginsJson
