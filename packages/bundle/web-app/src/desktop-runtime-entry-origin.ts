/** Worker-private actual-driver publication, completed before original feedback materialization. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ProjectOperationOrigins, ProjectOperationOriginToken, ProjectOperationRuntimeEntryCandidate,
  ProjectOperationRuntimeEntryPublication } from '@deepseek-ai/dsh-api-session-controller'
import { RuntimeEntryFactory, type RuntimeEntryFactoryOptions, type RuntimeEntryPreparation,
  type RuntimeEntryOriginalMetadata } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry'
import type { RuntimeEntryWitness } from '@deepseek-ai/dsh-api-session-controller/host/runtime-entry-journal'
import { runtimeEntryReceiptDigest, runtimeEntryBindingDigest } from '@deepseek-ai/dsh-host-control-protocol'

/** Parent transport coordinates only; every fact is read independently by Main. */
export interface OriginalRuntimeEntryBindingRequest {
  readonly originalCommandId: string
  readonly entryId: string
  readonly sourceEventId: string
  readonly sourceRevision: string
}
/** Bootstrap-owned dependencies; no plugin can supply a receipt or replace the original driver. */
export interface DesktopRuntimeEntryOriginOptions {
  readonly factoryOptions: RuntimeEntryFactoryOptions
  /** @param agent - Actual retained runtime.
   * @returns Whether its Account, Profile, worker and composition remain current. */
  isCurrent(agent: Agent): boolean
  /** Read original retained signed metadata only in the authenticated historical bind context.
   * @param commandId - Original consumer command independently derived from the private receipt.
   * @param signal - Current Account/Profile/worker metadata request.
   * @returns Original retained signed metadata and a live local publication fence; never an execution grant. */
  readHistoricalMetadata?(commandId: string, signal: AbortSignal): Promise<RuntimeEntryOriginalMetadata | undefined>
  /** @param request - Original coordinates only.
   * @param signal - Original cancellation.
   * @returns Independently verified Main/Cloud publication, or no grant.
   */
  bindOriginalEntry(request: OriginalRuntimeEntryBindingRequest,
    signal: AbortSignal): Promise<ProjectOperationRuntimeEntryPublication | null>
}
interface LiveEntry {
  readonly candidate: ProjectOperationRuntimeEntryCandidate
  readonly commandId: string
  readonly signal: AbortSignal
  readonly current: () => boolean
  binding: boolean
  publication: ProjectOperationRuntimeEntryPublication | null
}
/** Per-provider opaque tokens exist only inside the awaited actual-entry event. */
export class DesktopRuntimeEntryOrigin {
  private readonly tokens = new WeakMap<ProjectOperationOriginToken, LiveEntry>()
  private closed = false
  private reader: ProjectOperationOrigins | undefined
  private readonly factory: RuntimeEntryFactory
  private readonly metadata = new WeakMap<Agent, Map<string, RuntimeEntryOriginalMetadata>>()
  /** @param ctx - Actual worker context.
   * @param options - Trusted bootstrap dependencies. */
  constructor(private readonly ctx: Context, private readonly options: DesktopRuntimeEntryOriginOptions) {
    this.factory = new RuntimeEntryFactory({ ...options.factoryOptions,
      readOriginalMetadata: async (agent, commandId, signal) => {
        const original = await options.factoryOptions.readOriginalMetadata(agent, commandId, signal)
        if (original !== undefined) {
          let entries = this.metadata.get(agent)
          if (entries === undefined) { entries = new Map(); this.metadata.set(agent, entries) }
          entries.set(commandId, original)
        }
        return original
      } })
  }

  /** Extend the existing historical operation reader without replacing its read method.
   * @param existing - Reader owned by the existing operation-origin provider.
   * @returns Combined service, registered by the worker bootstrap.
   */
  readerWith(existing: ProjectOperationOrigins): ProjectOperationOrigins {
    if (this.reader !== undefined) throw Error('runtime_entry_reader_already_bound')
    this.reader = Object.freeze({ read: existing.read.bind(existing),
      readRuntimeEntry: (token: ProjectOperationOriginToken) => this.live(token)?.candidate ?? null,
      bindRuntimeEntry: (token: ProjectOperationOriginToken,
        reference: Parameters<NonNullable<ProjectOperationOrigins['bindRuntimeEntry']>>[1]) => this.bind(token, reference) })
    return this.reader
  }
  private live(token: ProjectOperationOriginToken): LiveEntry | undefined {
    const live = this.tokens.get(token)
    return live !== undefined && !live.signal.aborted && live.current() ? live : undefined
  }
  private async bind(token: ProjectOperationOriginToken,
    reference: Parameters<NonNullable<ProjectOperationOrigins['bindRuntimeEntry']>>[1]): Promise<ProjectOperationRuntimeEntryPublication | null> {
    const live = this.live(token)
    if (live === undefined || live.binding || reference.sourceEventId !== 'dsh-runtime-entry:' + live.candidate.entryId ||
      reference.sourceRevision !== '1') return null
    if (live.publication !== null) return live.publication
    live.binding = true
    try {
      const publication = await this.options.bindOriginalEntry({ originalCommandId: live.commandId,
        entryId: live.candidate.entryId, sourceEventId: reference.sourceEventId, sourceRevision: reference.sourceRevision }, live.signal)
      if (this.live(token) !== live || publication === null) return null
      if (publication.entryId !== live.candidate.entryId || publication.projectId !== live.candidate.projectId ||
        publication.sourceEventId !== reference.sourceEventId || publication.sourceRevision !== reference.sourceRevision ||
        publication.entryReceiptDigest !== live.candidate.entryReceiptDigest ||
          publication.manifestDigest !== live.candidate.manifestDigest) return null
      live.publication = Object.freeze({ ...publication })
      return live.publication
    } finally { live.binding = false }
  }
  /** Prepare the same original driver once; publication runs after actual commit/readback and before body resolution.
   * @param agent - Actual registered primary Agent.
   * @param commandId - Original accepted command.
   * @param signal - Original command and Profile cancellation.
   * @returns Original factory result with its materialization callback wrapped, without another wake.
   */
  async prepare(agent: Agent, commandId: string, signal: AbortSignal): Promise<RuntimeEntryPreparation> {
    const o = this.options
    this.metadata.get(agent)?.delete(commandId)
    const prepared = await this.factory.prepare(agent, commandId, signal)
    const entries = this.metadata.get(agent), metadata = entries?.get(commandId)
    entries?.delete(commandId)
    if (prepared.kind !== 'prepared' || metadata === undefined) return prepared
    return Object.freeze({ kind: 'prepared',
      start: (materialize: (signal: AbortSignal) => Promise<UserMessage>) => prepared.start(async (materializeSignal) => {
        const active = AbortSignal.any([signal, materializeSignal])
        const current = () => !this.closed && !active.aborted && metadata.isCurrent() && o.isCurrent(agent) &&
        Date.now() < metadata.binding.grantExpiresAt && this.reader !== undefined && this.ctx.get('projectOperationOrigins') === this.reader
        const witness = o.factoryOptions.journal.byAttempt(metadata.binding.consumerAttemptId)
        if (witness !== undefined && current() && witness.inputs.originalAuthorityDigest === metadata.originalAuthorityDigest &&
        runtimeEntryBindingDigest(witness.receipt.binding) === runtimeEntryBindingDigest(metadata.binding)) {
          const candidate = this.candidate(witness, metadata)
          const token = Object.freeze({}) as ProjectOperationOriginToken
          const entry: LiveEntry = { candidate, commandId, signal: active, current, binding: false, publication: null }
          this.tokens.set(token, entry)
          try {
          // Event failures cannot cause a second dispatch or erase the already committed original entry.
            await this.ctx.serial('project-operation/runtime-entry', token, active)
          } catch (error) {
            if (active.aborted) throw error
          } finally { this.tokens.delete(token) }
        }
        active.throwIfAborted()
        if (this.closed || !metadata.isCurrent() || !o.isCurrent(agent) || Date.now() >= metadata.binding.grantExpiresAt) throw Error('runtime_entry_origin_authority_lost')
        return materialize(materializeSignal)
      }) })
  }
  private candidate(witness: RuntimeEntryWitness, metadata: RuntimeEntryOriginalMetadata): ProjectOperationRuntimeEntryCandidate {
    const b = witness.receipt.binding
    return Object.freeze({ profileId: brandString<ProjectOperationRuntimeEntryCandidate['profileId']>(b.hostProfileId),
      botRootId: brandString<ProjectOperationRuntimeEntryCandidate['botRootId']>(b.botId), sessionId: brandString<ProjectOperationRuntimeEntryCandidate['sessionId']>(b.sessionId), ownerUserId: brandString<ProjectOperationRuntimeEntryCandidate['ownerUserId']>(b.ownerUserId),
      projectId: metadata.projectId, taskRef: metadata.taskRef,
      invocationRef: brandString<ProjectOperationRuntimeEntryCandidate['invocationRef']>(b.invocationId), entryId: brandString<ProjectOperationRuntimeEntryCandidate['entryId']>(witness.receipt.entryId),
      entryEffectAt: witness.receipt.entryEffectAt,
      entryReceiptDigest: runtimeEntryReceiptDigest(witness.receipt), manifestDigest: witness.receipt.manifestDigest })
  }

  /** Publish the already committed candidate after actual Main/Cloud reconciliation, without another entry or materialization.
   * @param entryId - Existing private journal entry selected by the authenticated original consumer index.
   * @param signal - Current Account/Profile/worker metadata request.
   * @returns True only after the real consumer acknowledges its durable immutable publication.
   */
  async publishOriginalEntry(entryId: string, signal: AbortSignal): Promise<boolean> {
    const o = this.options, witness = o.factoryOptions.journal.read(entryId)
    if (this.closed || signal.aborted || !witness || !o.readHistoricalMetadata) return false
    const commandId = witness.receipt.binding.consumerCommandId
    const metadata = await o.readHistoricalMetadata(commandId, signal)
    const current = () => !this.closed && !signal.aborted && metadata !== undefined && metadata.isCurrent()
      && this.reader !== undefined && this.ctx.get('projectOperationOrigins') === this.reader
    if (!metadata || !current() || witness.inputs.originalAuthorityDigest !== metadata.originalAuthorityDigest
      || runtimeEntryBindingDigest(witness.receipt.binding) !== runtimeEntryBindingDigest(metadata.binding)) return false
    const candidate = this.candidate(witness, metadata)
    const publication = await o.bindOriginalEntry({ originalCommandId: commandId, entryId,
      sourceEventId: 'dsh-runtime-entry:' + entryId, sourceRevision: '1' }, signal)
    if (!publication || !current() || publication.entryId !== candidate.entryId || publication.projectId !== candidate.projectId
      || publication.sourceEventId !== 'dsh-runtime-entry:' + entryId || publication.sourceRevision !== '1'
      || publication.entryReceiptDigest !== candidate.entryReceiptDigest
        || publication.manifestDigest !== candidate.manifestDigest) return false
    const token = Object.freeze({}) as ProjectOperationOriginToken
    const live: LiveEntry = { candidate, commandId, signal, current, binding: false, publication: Object.freeze({ ...publication }) }
    this.tokens.set(token, live)
    try { return await this.ctx.serial('project-operation/runtime-entry', token, signal) === true && current() }
    catch { signal.throwIfAborted(); return false }
    finally { this.tokens.delete(token) }
  }

  /** Release worker-local preparations; historical entry records remain unchanged. */
  close(): void { this.closed = true; this.factory.close() }
}
