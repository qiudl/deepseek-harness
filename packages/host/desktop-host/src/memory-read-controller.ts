/** REQ-20261021-0013: Host-local signed reads of a warmed, scoped memory index. */
import type { HostMemoryCandidateRef, HostMemoryProfileReader, HostMemoryScope,
  HostMemorySearchItem } from './memory-evidence-index.ts'
import { chunkHostMemoryEvidence, type HostMemoryEvidenceChunk } from './memory-evidence-chunk.ts'
import { HostMemoryIndexCache } from './memory-index-cache.ts'
import { MemoryDirectiveVerifier, type MemoryDirectiveContext } from './memory-directive-verifier.ts'
import { HostAuthorityError } from './types.ts'

/** Fresh authority from the authenticated Desktop connection and current Account Profile. */
export interface HostMemoryCurrentAuthority extends Omit<MemoryDirectiveContext, 'operation' | 'value' | 'limit'> {
  readonly reader: HostMemoryProfileReader
}

function capture(current: () => HostMemoryCurrentAuthority): HostMemoryCurrentAuthority {
  const value = current()
  if (![value.environmentId, value.ownerUserId, value.computerId,
    value.installationId, value.profileId, value.hostInstanceId, value.processNonce]
    .every(part => typeof part === 'string' && part.length > 0 && part.length <= 256
      && !/[\u0000-\u001f]/u.test(part))) throw new HostAuthorityError('unauthorized')
  value.reader.assertCurrent()
  return Object.freeze({ environmentId: value.environmentId, ownerUserId: value.ownerUserId,
    computerId: value.computerId, installationId: value.installationId,
    profileId: value.profileId, hostInstanceId: value.hostInstanceId,
    processNonce: value.processNonce, reader: value.reader })
}

function same(left: HostMemoryCurrentAuthority, right: HostMemoryCurrentAuthority): boolean {
  return left.environmentId === right.environmentId && left.ownerUserId === right.ownerUserId
    && left.computerId === right.computerId && left.installationId === right.installationId
    && left.profileId === right.profileId && left.hostInstanceId === right.hostInstanceId
    && left.processNonce === right.processNonce && left.reader === right.reader
}

function scopeOf(value: HostMemoryCurrentAuthority): HostMemoryScope {
  return { ownerUserId: value.ownerUserId, installationId: value.installationId,
    profileId: value.profileId }
}

/** A connection owner must clear this controller on logout, Profile switch and Host disposal. */
export class HostMemoryReadController {
  private readonly cache = new HostMemoryIndexCache()
  private epoch = 0

  constructor(private readonly verifier: MemoryDirectiveVerifier,
    private readonly current: () => HostMemoryCurrentAuthority) {}

  clear(): void {
    this.epoch += 1
    this.cache.clear()
  }

  /** Build before the 15-second query directive, using current authenticated identity. */
  async warm(signal: AbortSignal): Promise<void> {
    let before: HostMemoryCurrentAuthority
    try { before = capture(this.current) } catch (error) { this.clear(); throw error }
    const epoch = this.epoch
    try {
      await this.cache.warm(scopeOf(before), before.reader, signal)
      if (epoch !== this.epoch || !same(before, capture(this.current))) throw new HostAuthorityError('stale')
      signal.throwIfAborted()
    } catch (error) {
      if (epoch === this.epoch) this.clear()
      throw error
    }
  }

  private async read<T>(directive: unknown, operation: 'search' | 'evidence', value: string,
    limit: number, signal: AbortSignal,
    select: (scope: HostMemoryScope, reader: HostMemoryProfileReader) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    let before: HostMemoryCurrentAuthority
    try { before = capture(this.current) } catch (error) { this.clear(); throw error }
    const epoch = this.epoch
    const verified = this.verifier.verifyAndConsume(directive, { ...before, operation, value, limit })
    try {
      const result = await select(scopeOf(before), before.reader)
      if (epoch !== this.epoch || !same(before, capture(this.current))) throw new HostAuthorityError('stale')
      this.verifier.assertUnexpired(verified)
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (epoch === this.epoch) this.clear()
      throw error
    }
  }

  search(directive: unknown, query: string, limit: number, signal: AbortSignal): Promise<{
    readonly indexEpoch: string
    readonly generation: number
    readonly items: readonly HostMemorySearchItem[]
  }> {
    return this.read(directive, 'search', query, limit, signal,
      (scope, reader) => this.cache.search(scope, reader, query, limit, signal))
  }

  /** Resolve untrusted semantic references only under a signed search directive and matching index epoch. */
  resolveCandidates(directive: unknown, query: string, limit: number, indexEpoch: string, generation: number,
    candidates: readonly HostMemoryCandidateRef[], signal: AbortSignal): Promise<readonly HostMemorySearchItem[]> {
    return this.read(directive, 'search', query, limit, signal,
      (scope, reader) => this.cache.resolveCandidates(scope, reader, indexEpoch, generation, candidates, limit, signal))
  }

  /** Consume one signed search before invoking a semantic worker; resolve its untrusted refs under that same read. */
  semanticSearch(directive: unknown, query: string, limit: number,
    rank: (query: string, limit: number, signal: AbortSignal) => Promise<{
      readonly indexEpoch: string
      readonly generation: number
      readonly candidates: readonly HostMemoryCandidateRef[]
    }>, signal: AbortSignal): Promise<readonly HostMemorySearchItem[]> {
    return this.read(directive, 'search', query, limit, signal, async (scope, reader) => {
      if (typeof query !== 'string' || query.length < 1 || query.length > 500
        || /[\u0000-\u001f]/u.test(query)) throw new HostAuthorityError('invalid_input')
      const ranked = await rank(query, limit, signal)
      return this.cache.resolveCandidates(scope, reader, ranked.indexEpoch, ranked.generation,
        ranked.candidates, limit, signal)
    })
  }

  evidenceChunk(directive: unknown, sourceRef: string, offset: number,
    signal: AbortSignal): Promise<HostMemoryEvidenceChunk | null> {
    return this.read(directive, 'evidence', sourceRef, 1, signal,
      async (scope, reader) => {
        const evidence = await this.cache.evidence(scope, reader, sourceRef, signal)
        return evidence === null ? null : chunkHostMemoryEvidence(evidence, offset)
      })
  }
}
