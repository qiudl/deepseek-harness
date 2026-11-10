/** Trusted original-feedback composition: original metadata -> opaque actual driver -> private durable entry. */
import { randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { Agent, OriginalInvocationEntryDriver, OriginalInvocationEntryRuntime, OriginalInvocationEntryOccurrence } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { parseRuntimeEntryBinding, runtimeEntryBindingDigest, type RuntimeEntryBinding } from '@deepseek-ai/dsh-host-control-protocol'
import { RuntimeEntryJournal, type RuntimeEntryWitness } from './runtime-entry-journal.ts'
import { runtimeEntryMetadataDigest } from './runtime-entry-manifest.ts'

/** Body-free original metadata returned only by the trusted current-origin reader. Not a caller request. */
export interface RuntimeEntryOriginalMetadata {
  readonly binding: RuntimeEntryBinding
  /** Original Cloud execution task; its exact value is covered by originalAuthorityDigest. */
  readonly taskRef: Branded<'ProjectOperationTaskRef'> | null
  /** Original admission project, independently of the executor project's historical identity. */
  readonly projectId: Branded<'ProjectOperationProjectId'>
  readonly dispatchGranted: boolean
  readonly sourceKind: 'primary_human' | 'live_reference' | 'restricted' | 'unknown'
  readonly originalAuthorityDigest: string
  readonly accountAuthorityDigest: string
  /** @returns Whether the captured current original-authority lease still owns this exact dispatch. */
  isCurrent(): boolean
}
/** Actual loaded backend/ownership witness; cold history reads cannot manufacture this capability. */
export interface RuntimeEntryLoadedSession {
  readonly session: Session
  readonly birthReceiptDigest: string
  readonly instanceGeneration: string
  readonly sessionAuthorityDigest: string
  readonly logOffset: number
  /** Original durable logical prefix digest, carried by the actual backend startup witness. */
  readonly prefixLogDigest?: string | undefined
  readonly surfaceGeneration: number
  /** @returns Whether this same loaded Session still has its original exclusive backend writer. */
  isCurrent(): boolean
}
/** Trusted bootstrap inputs. No public observer or DTO can mint a supported composition. */
export interface RuntimeEntryFactoryOptions {
  readonly journal: RuntimeEntryJournal
  readonly workerLifetimeId: string
  readonly implementationDigest: string
  readonly compositionDigest: string
  readonly registryGeneration: string
  readonly compositionAuthorityDigest: string
  /** Read current original metadata before any body materialization.
   * @param agent - Actual registered primary Bot runtime.
   * @param commandId - Original accepted consumer command.
   * @param signal - Current command cancellation.
   * @returns Metadata only, or undefined when this path is unsupported.
   */
  readOriginalMetadata(agent: Agent, commandId: string, signal: AbortSignal): Promise<RuntimeEntryOriginalMetadata | undefined>
  /** @param agent - Actual already-loaded Agent; this reader must not resume or scan private history.
   * @returns Its actual durable birth/backend ownership metadata, or undefined when unavailable.
   */
  readLoadedSession(agent: Agent): Promise<RuntimeEntryLoadedSession | undefined>
  /** Final synchronous check of fixed implementation, current registry and actual Agent membership.
   * @param agent - Exact registered runtime object, never a caller-selected ID.
   * @returns True only for this bootstrap's verified current composition.
   */
  isCurrentComposition(agent: Agent): boolean
}
/** A historical receipt/gap is not completion or current permission to execute. */
export type RuntimeEntryResult = Readonly<{ kind: 'entered'; witness: RuntimeEntryWitness }>
  | Readonly<{ kind: 'gap'; reason: 'fence_lost' | 'journal_failed' | 'cancelled' }>
/** One prepared original command; unsupported returns to the original business path without another start grant. */
export type RuntimeEntryPreparation = Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'historical'; witness: RuntimeEntryWitness }>
  | Readonly<{ kind: 'prepared'; start(materialize: (signal: AbortSignal) => Promise<UserMessage>): Promise<RuntimeEntryResult> }>

interface Claim {
  readonly agent: OriginalInvocationEntryRuntime
  readonly original: RuntimeEntryOriginalMetadata
  readonly binding: RuntimeEntryBinding
  readonly loaded: RuntimeEntryLoadedSession
  readonly signal: AbortSignal
  readonly occurrenceId: string
  readonly preparationGeneration: string
  used: boolean
  selected: boolean
}

/** Worker-owned capability registry. Its actual writer consumes a private token, never a caller receipt/manifest. */
export class RuntimeEntryFactory {
  private readonly claims = new WeakMap<object, Claim>()
  private readonly attempts = new Set<string>()
  private closed = false
  /** @param options - Actual bootstrap-owned readers, journal and supported implementation composition. */
  constructor(private readonly options: RuntimeEntryFactoryOptions) {}

  private eligible(agent: Agent, signal: AbortSignal): boolean {
    return !this.closed && !signal.aborted && this.options.isCurrentComposition(agent) && agent.status === 'idle'
      && 'startOriginalInvocationEntry' in agent && typeof agent.startOriginalInvocationEntry === 'function'
      && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
      && agent.session.header.parentSession === undefined && !agent.session.header.isSeeded
      && agent.session.header.origin === undefined && this.attempts.size < 10000
  }

  /** Capture an original command once, without fetching feedback content or waking another driver.
   * @param agent - Actual loaded primary Bot runtime.
   * @param commandId - Original consumer command, not an invocation fabricated by a caller.
   * @param signal - Actual current consumer job cancellation.
   * @returns Opaque preparation, historical original receipt, or explicit unsupported fallback.
   */
  async prepare(agent: Agent, commandId: string, signal: AbortSignal): Promise<RuntimeEntryPreparation> {
    const o = this.options
    if (!this.eligible(agent, signal)) return { kind: 'unsupported' }
    const runtime = agent as OriginalInvocationEntryRuntime
    const preparationGeneration = runtime.originalInvocationEntryGeneration
    const original = await o.readOriginalMetadata(agent, commandId, signal)
    if (original === undefined) return { kind: 'unsupported' }
    const binding = parseRuntimeEntryBinding(original.binding)
    if (binding.consumerCommandId !== commandId || String(binding.sessionId) !== agent.id ||
      original.sourceKind !== 'primary_human' || !original.isCurrent()) return { kind: 'unsupported' }
    const historical = o.journal.byAttempt(binding.consumerAttemptId)
    if (historical !== undefined) {
      if (runtimeEntryBindingDigest(historical.receipt.binding) !== runtimeEntryBindingDigest(binding)) throw new Error('runtime_entry_original_conflict')
      return { kind: 'historical', witness: historical }
    }
    if (!original.dispatchGranted || this.attempts.has(binding.consumerAttemptId)) return { kind: 'unsupported' }
    const loaded = await o.readLoadedSession(agent)
    if (loaded === undefined || loaded.session !== agent.session || !loaded.isCurrent() ||
      loaded.logOffset !== agent.session.seq || loaded.surfaceGeneration !== agent.session.surface.contentGeneration ||
      runtime.originalInvocationEntryGeneration !== preparationGeneration ||
      !this.eligible(agent, signal) || !original.isCurrent() || this.attempts.has(binding.consumerAttemptId) ||
      Date.now() < binding.grantIssuedAt || Date.now() >= binding.grantExpiresAt)
      return { kind: 'unsupported' }
    const token = Object.freeze({}), claim: Claim = { agent: runtime,
      original, binding, loaded, signal, occurrenceId: randomUUID(), preparationGeneration, used: false, selected: false }
    this.claims.set(token, claim)
    this.attempts.add(binding.consumerAttemptId)
    return Object.freeze({ kind: 'prepared', start: (materialize: (signal: AbortSignal) => Promise<UserMessage>) => this.start(token, materialize) })
  }

  private current(claim: Claim, driver?: OriginalInvocationEntryDriver): boolean {
    const { options: o } = this
    return !this.closed && !claim.signal.aborted && claim.original.isCurrent() && claim.loaded.isCurrent() &&
      o.isCurrentComposition(claim.agent) && claim.loaded.session === claim.agent.session &&
      claim.loaded.logOffset === claim.agent.session.seq &&
      claim.loaded.surfaceGeneration === claim.agent.session.surface.contentGeneration &&
      Date.now() >= claim.binding.grantIssuedAt && Date.now() < claim.binding.grantExpiresAt &&
      (driver === undefined ? claim.agent.originalInvocationEntryGeneration === claim.preparationGeneration
        : driver.agent === claim.agent && driver.session === claim.loaded.session && driver.isCurrent()
          && BigInt(driver.queueGeneration) === BigInt(claim.preparationGeneration) + 1n)
  }

  private commitOriginalInvocationEntry(agent: Agent, token: object, driver: OriginalInvocationEntryDriver): RuntimeEntryResult {
    const claim = this.claims.get(token), o = this.options
    if (claim === undefined || claim.agent !== agent || !claim.used || claim.selected) throw new Error('runtime_entry_claim_invalid')
    claim.selected = true
    if (!this.current(claim, driver)) return { kind: 'gap', reason: 'fence_lost' }
    try {
      const witness = o.journal.commitOriginalInvocationEntry({ binding: claim.binding, implementationDigest: o.implementationDigest,
        compositionDigest: o.compositionDigest, queueOccurrenceId: claim.occurrenceId, queueGeneration: driver.queueGeneration,
        driverReservationId: driver.driverReservationId, workerLifetimeId: o.workerLifetimeId,
        sessionInstanceGeneration: claim.loaded.instanceGeneration, sessionBirthReceiptDigest: claim.loaded.birthReceiptDigest,
        manifestInputs: { originalAuthorityDigest: claim.original.originalAuthorityDigest,
          accountAuthorityDigest: claim.original.accountAuthorityDigest, sessionAuthorityDigest: claim.loaded.sessionAuthorityDigest,
          compositionAuthorityDigest: runtimeEntryMetadataDigest('composition-authority', [o.compositionAuthorityDigest, o.registryGeneration]),
          registryGeneration: o.registryGeneration },
      }, () => this.current(claim, driver))
      return Object.freeze({ kind: 'entered', witness })
    } catch (_error) {
      // A driver may continue its original business once, but publication cannot invent a successful source receipt.
      return Object.freeze({ kind: 'gap', reason: 'journal_failed' })
    }
  }

  private async start(token: object, materialize: (signal: AbortSignal) => Promise<UserMessage>): Promise<RuntimeEntryResult> {
    const claim = this.claims.get(token)
    if (claim === undefined || claim.used) throw new Error('runtime_entry_claim_replayed')
    claim.used = true
    if (!this.current(claim)) return { kind: 'gap', reason: 'fence_lost' }
    let result: RuntimeEntryResult | undefined
    const occurrence: OriginalInvocationEntryOccurrence = {
      occurrenceId: brandString<OriginalInvocationEntryOccurrence['occurrenceId']>(claim.occurrenceId),
      enter: (driver) => { result = this.commitOriginalInvocationEntry(claim.agent, token, driver) },
      materialize: async (signal) => {
        if (claim.signal.aborted || signal.aborted) throw new Error('runtime_entry_cancelled')
        if (!claim.original.isCurrent() || !claim.loaded.isCurrent() || !this.options.isCurrentComposition(claim.agent)
          || Date.now() >= claim.binding.grantExpiresAt) throw new Error('runtime_entry_origin_authority_lost')
        return materialize(signal)
      },
    }
    const abort = () =>{  claim.agent.cancel({ kind: 'hook', reason: 'original consumer cancelled' }) }
    claim.signal.addEventListener('abort', abort, { once: true })
    try {
      if (!claim.agent.startOriginalInvocationEntry(occurrence)) return { kind: 'gap', reason: 'fence_lost' }
      // enter is synchronous in the selected actual driver. A different implementation is ineligible.
      if (result === undefined) throw new Error('runtime_entry_driver_not_synchronous')
      await claim.agent.whenIdle()
      return result
    } finally { claim.signal.removeEventListener('abort', abort); this.claims.delete(token) }
  }

  /** Invalidate all outstanding worker-local capabilities; no receipt is replayed into execution. */
  close(): void { this.closed = true }
}
