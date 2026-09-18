import type { LegacyModelClaimDocuments } from './legacy-migration-source.ts'
import { LegacyClaimLedger } from './legacy-claim-ledger.ts'
import { ProfileClaimMarker } from './legacy-claim-marker.ts'
import { LegacyClaimRecoveryStore, type LegacyClaimRecovery } from './legacy-claim-recovery.ts'
import { LegacyClaimTarget } from './legacy-claim-target.ts'
import { HostAuthorityError } from './types.ts'

const SHA256 = /^[0-9a-f]{64}$/u

interface Operation {
  readonly candidateId: string
  readonly operationId: string
  /** Inventory digest confirmed in the trusted Desktop view. */
  readonly expectedSourceDigest: string
  /** Must resolve only a live, writable Account Profile view owned by Main. */
  authorizeAccountProfile(): string
  readonly signal?: AbortSignal
}

interface RestoreOperation extends Pick<Operation, 'candidateId' | 'operationId' | 'authorizeAccountProfile' | 'signal'> {}
interface StatusOperation extends Pick<Operation, 'candidateId' | 'authorizeAccountProfile'> {}

export interface LegacyClaimCoordinatorDependencies {
  readonly ledger: LegacyClaimLedger
  readonly marker: ProfileClaimMarker
  readonly recovery: LegacyClaimRecoveryStore
  readSource(signal?: AbortSignal): Promise<LegacyModelClaimDocuments>
  targetGeneration(profileId: string): Promise<number>
  target(profileId: string, generation: number): LegacyClaimTarget
  stopWorker(profileId: string): Promise<void>
  startWorker(profileId: string): Promise<void>
}

export interface LegacyClaimOutcome {
  readonly state: 'committed' | 'restored'
  readonly cleanupPending: boolean
}

/** Secret-free receipt available only to the Account that owns the candidate. */
export interface LegacyClaimReceipt {
  readonly candidateId: string
  readonly operationId: string
  readonly sourceDigest: string
  readonly status: 'pending' | 'committed' | 'restored'
}

/** Host-only claim order; the production caller supplies Account authorization and worker quiescence. */
export class LegacyClaimCoordinator {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly deps: LegacyClaimCoordinatorDependencies) {}

  /** Reserve, fence, publish and verify one provider before releasing its worker. */
  claim(input: Operation): Promise<LegacyClaimOutcome> {
    const profileId = input.authorizeAccountProfile()
    return this.serial(profileId, () => this.claimOwned(profileId, input))
  }

  /** Retry only an operation already reserved for this Account Profile. */
  retry(input: Operation): Promise<LegacyClaimOutcome> {
    const profileId = input.authorizeAccountProfile()
    const receipt = this.deps.ledger.ownerState(input.candidateId, profileId)
    if (!receipt || receipt.status === 'restored' || receipt.operationId !== input.operationId
      || receipt.sourceDigest !== input.expectedSourceDigest) throw new HostAuthorityError('conflict')
    return this.serial(profileId, () => this.claimOwned(profileId, input))
  }

  /** Let the same Account find a durable operation after Host restart without reading any secret. */
  status(input: StatusOperation): LegacyClaimReceipt | null {
    const profileId = input.authorizeAccountProfile()
    const receipt = this.deps.ledger.ownerState(input.candidateId, profileId)
    if (!receipt || receipt.status === 'restored' && !this.deps.marker.pending(profileId)) return null
    return { candidateId: receipt.candidateId, operationId: receipt.operationId,
      sourceDigest: receipt.sourceDigest, status: receipt.status }
  }

  /** Discover interrupted operations after Desktop or Host restart, even when the worker cannot open. */
  pendingReceipts(input: { authorizeAccountProfile(): string }): readonly LegacyClaimReceipt[] {
    const profileId = input.authorizeAccountProfile()
    const receipts = [...this.deps.ledger.pendingReceipts(profileId)]
    const marker = this.deps.marker.pendingOperation(profileId)
    if (marker) {
      const marked = this.deps.ledger.ownerState(marker.candidateId, profileId)
      if (!marked || marked.operationId !== marker.operationId) throw new HostAuthorityError('unavailable')
      if (!receipts.some(receipt => receipt.candidateId === marker.candidateId)) receipts.push(marked)
    }
    if (receipts.length > 128) throw new HostAuthorityError('unavailable')
    return receipts.map(receipt => ({
      candidateId: receipt.candidateId, operationId: receipt.operationId,
      sourceDigest: receipt.sourceDigest, status: receipt.status,
    }))
  }

  /** Restore a pending claim's verified preimage and release its worker. */
  restore(input: RestoreOperation): Promise<LegacyClaimOutcome> {
    const profileId = input.authorizeAccountProfile()
    return this.serial(profileId, () => this.restoreOwned(profileId, input))
  }

  private guard(profileId: string, input: RestoreOperation): void {
    input.signal?.throwIfAborted()
    if (input.authorizeAccountProfile() !== profileId) throw new HostAuthorityError('profile_mismatch')
  }

  private async claimOwned(profileId: string, input: Operation): Promise<LegacyClaimOutcome> {
    const guard = () => { this.guard(profileId, input) }
    guard()
    if (!SHA256.test(input.expectedSourceDigest)) throw new HostAuthorityError('invalid_input')
    const key = { profileId, candidateId: input.candidateId, operationId: input.operationId }
    const prior = this.deps.ledger.ownerState(input.candidateId, profileId)
    if (prior?.status === 'committed') {
      if (prior.operationId !== input.operationId || prior.sourceDigest !== input.expectedSourceDigest) {
        throw new HostAuthorityError('idempotency_conflict')
      }
      const recovery = this.deps.recovery.read(profileId, input.operationId)
      if (this.deps.marker.pending(profileId)) {
        this.deps.marker.mark(key)
        await this.deps.stopWorker(profileId)
        guard()
        if (await this.deps.targetGeneration(profileId) !== prior.targetGeneration) throw new HostAuthorityError('stale')
        guard()
        if (!recovery || recovery.targetGeneration !== prior.targetGeneration) throw new HostAuthorityError('unavailable')
        this.deps.target(profileId, prior.targetGeneration).verify(recovery, guard)
        guard()
        this.deps.marker.clear(key)
      }
      await this.deps.startWorker(profileId)
      return this.finish('committed', recovery, guard)
    }
    const source = await this.deps.readSource(input.signal)
    guard()
    if (source.sourceDigest !== input.expectedSourceDigest) throw new HostAuthorityError('conflict')
    const generation = await this.deps.targetGeneration(profileId)
    guard()
    this.deps.marker.assertMarkable(key)
    await this.deps.stopWorker(profileId)
    let target: LegacyClaimTarget
    let prepared
    try {
      guard()
      if (await this.deps.targetGeneration(profileId) !== generation) throw new HostAuthorityError('stale')
      guard()
      target = this.deps.target(profileId, generation)
      prepared = target.prepare({ ...key, targetGeneration: generation,
        sourceSettings: source.settings, sourceCredentials: source.credentials, guard })
      guard()
      this.deps.ledger.reserve({ ...key, sourceDigest: source.sourceDigest, targetGeneration: generation })
      guard()
      this.deps.marker.mark(key)
    } catch (error) {
      // Nothing has touched the live documents before mark. Resume this worker if no pending marker was published.
      if (!this.deps.marker.pending(profileId)) await this.deps.startWorker(profileId)
      throw error
    }
    target.publish(prepared, guard)
    guard()
    this.deps.ledger.commit(key)
    guard()
    this.deps.marker.clear(key)
    await this.deps.startWorker(profileId)
    return this.finish('committed', prepared.recovery, guard)
  }

  private async restoreOwned(profileId: string, input: RestoreOperation): Promise<LegacyClaimOutcome> {
    const guard = () => { this.guard(profileId, input) }
    guard()
    const key = { profileId, candidateId: input.candidateId, operationId: input.operationId }
    const state = this.deps.ledger.ownerState(input.candidateId, profileId)
    if (!state || state.operationId !== input.operationId || state.status === 'committed') {
      throw new HostAuthorityError('conflict')
    }
    const pending = this.deps.marker.pending(profileId)
    if (state.status === 'pending' || pending) {
      this.deps.marker.mark(key)
      await this.deps.stopWorker(profileId)
      guard()
      if (await this.deps.targetGeneration(profileId) !== state.targetGeneration) throw new HostAuthorityError('stale')
      guard()
      const recovery = this.deps.recovery.read(profileId, input.operationId)
      if (!recovery || recovery.targetGeneration !== state.targetGeneration) throw new HostAuthorityError('unavailable')
      this.deps.target(profileId, state.targetGeneration).restore(recovery, guard)
      guard()
      if (state.status === 'pending') this.deps.ledger.restore(key)
      guard()
      this.deps.marker.clear(key)
      await this.deps.startWorker(profileId)
      return this.finish('restored', recovery, guard)
    }
    await this.deps.startWorker(profileId)
    return this.finish('restored', this.deps.recovery.read(profileId, input.operationId), guard)
  }

  private finish(state: LegacyClaimOutcome['state'], recovery: LegacyClaimRecovery | null, guard: () => void): LegacyClaimOutcome {
    if (!recovery) return { state, cleanupPending: false }
    try { this.deps.recovery.clear(recovery, guard) }
    catch { return { state, cleanupPending: true } }
    return { state, cleanupPending: false }
  }

  private serial<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(profileId) ?? Promise.resolve()
    const current = previous.then(operation)
    const settled = current.then(() => undefined, () => undefined).finally(() => {
      if (this.tails.get(profileId) === settled) this.tails.delete(profileId)
    })
    this.tails.set(profileId, settled)
    return current
  }
}
