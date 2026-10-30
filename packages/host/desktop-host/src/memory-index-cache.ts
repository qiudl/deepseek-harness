/** REQ-20261021-0013: one process-local, generation-pinned memory index slot. */
import { buildHostMemoryEvidenceIndex, type HostMemoryEvidence,
  type HostMemoryCandidateRef, type HostMemoryEvidenceIndex, type HostMemoryProfileReader, type HostMemoryScope,
  type HostMemoryProjectedPage, type HostMemorySearchItem } from './memory-evidence-index.ts'
import { HostAuthorityError } from './types.ts'

interface ReadyIndex {
  readonly scope: HostMemoryScope
  readonly reader: HostMemoryProfileReader
  readonly index: HostMemoryEvidenceIndex
}

function sameScope(left: HostMemoryScope, right: HostMemoryScope): boolean {
  return left.ownerUserId === right.ownerUserId && left.installationId === right.installationId
    && left.profileId === right.profileId
}

/** The caller owns the pinned reader and must clear this slot on identity or worker changes. */
export class HostMemoryIndexCache {
  private generation = 0
  private warming: AbortController | undefined
  private ready: ReadyIndex | undefined

  clear(): void {
    this.generation += 1
    this.warming?.abort()
    this.warming = undefined
    this.ready = undefined
  }

  /** Complete warmup happens outside the short-lived signed query directive. */
  async warm(scope: HostMemoryScope, reader: HostMemoryProfileReader, signal: AbortSignal): Promise<void> {
    const ready = this.ready
    if (ready && sameScope(ready.scope, scope) && ready.reader === reader) {
      const generation = this.generation
      try {
        signal.throwIfAborted()
        reader.assertCurrent()
        await ready.index.assertCurrentInventory(scope, reader, signal)
        if (generation !== this.generation || this.ready !== ready) throw new HostAuthorityError('stale')
        signal.throwIfAborted()
        return
      } catch (error) {
        if (generation !== this.generation || this.ready !== ready) throw new HostAuthorityError('stale')
        if (!(error instanceof HostAuthorityError && error.code === 'stale')) {
          this.clear()
          throw error
        }
      }
    }
    this.clear()
    const pinnedScope = Object.freeze({ ownerUserId: scope.ownerUserId,
      installationId: scope.installationId, profileId: scope.profileId })
    const generation = this.generation
    const controller = new AbortController()
    this.warming = controller
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      combined.throwIfAborted()
      const index = await buildHostMemoryEvidenceIndex(pinnedScope, reader, combined)
      combined.throwIfAborted()
      reader.assertCurrent()
      if (generation !== this.generation || this.warming !== controller) throw new HostAuthorityError('stale')
      this.ready = { scope: pinnedScope, reader, index }
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new HostAuthorityError('stale')
      throw error
    } finally {
      if (this.warming === controller) this.warming = undefined
    }
  }

  private async withCurrent<T>(scope: HostMemoryScope, reader: HostMemoryProfileReader,
    signal: AbortSignal, select: (index: HostMemoryEvidenceIndex) => T): Promise<T> {
    signal.throwIfAborted()
    const ready = this.ready
    if (!ready) throw new HostAuthorityError('unavailable')
    if (!sameScope(ready.scope, scope) || ready.reader !== reader) {
      this.clear()
      throw new HostAuthorityError('unauthorized')
    }
    const generation = this.generation
    try {
      reader.assertCurrent()
      await ready.index.assertCurrentInventory(scope, reader, signal)
      if (generation !== this.generation || this.ready !== ready) throw new HostAuthorityError('stale')
      const result = select(ready.index)
      await ready.index.assertCurrentInventory(scope, reader, signal)
      if (generation !== this.generation || this.ready !== ready) throw new HostAuthorityError('stale')
      reader.assertCurrent()
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (generation === this.generation) this.clear()
      throw error
    }
  }

  search(scope: HostMemoryScope, reader: HostMemoryProfileReader, query: string, limit: number,
    signal: AbortSignal): Promise<{
    readonly indexEpoch: string
    readonly generation: number
    readonly items: readonly HostMemorySearchItem[]
  }> {
    return this.withCurrent(scope, reader, signal, index => index.search(scope, query, limit))
  }

  evidence(scope: HostMemoryScope, reader: HostMemoryProfileReader, sourceRef: string,
    signal: AbortSignal): Promise<HostMemoryEvidence | null> {
    return this.withCurrent(scope, reader, signal, index => index.evidence(scope, sourceRef))
  }

  projectedPage(scope: HostMemoryScope, reader: HostMemoryProfileReader, indexEpoch: string | null,
    generation: number | null, offset: number, signal: AbortSignal): Promise<HostMemoryProjectedPage> {
    return this.withCurrent(scope, reader, signal,
      index => index.projectedPage(scope, indexEpoch, generation, offset))
  }

  /** Recheck the current inventory around externally ranked references. */
  resolveCandidates(scope: HostMemoryScope, reader: HostMemoryProfileReader, indexEpoch: string, generation: number,
    candidates: readonly HostMemoryCandidateRef[], limit: number,
    signal: AbortSignal): Promise<readonly HostMemorySearchItem[]> {
    return this.withCurrent(scope, reader, signal,
      index => index.resolveCandidates(scope, indexEpoch, generation, candidates, limit))
  }
}
