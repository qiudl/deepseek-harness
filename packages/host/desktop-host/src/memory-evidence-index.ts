/** REQ-20261021-0013: process-local index of redacted Profile Session evidence. */
import { createHash, randomBytes } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { projectMemoryLogicalSession, projectMemorySession, type MemoryProjectedRecord } from './memory-session-projection.ts'
import type { HostMemorySessionPage, HostMemorySessionSnapshot } from './types.ts'
import { HostAuthorityError } from './types.ts'

const HASH = /^[0-9a-f]{64}$/u
const EPOCH = /^[0-9a-f]{32}$/u
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const MAX_TEXT_BYTES = 32 * 1024 * 1024
const MAX_RECORDS = 20_000
const MAX_GRAMS = 200_000
const MAX_SESSIONS = 10_000
const MAX_PROJECTED_PAGE_ITEMS = 16
const MAX_PROJECTED_PAGE_TEXT_BYTES = 256 * 1024

/** Identity that must match the active Account and Profile at each read. */
export interface HostMemoryScope {
  readonly ownerUserId: string
  readonly installationId: string
  readonly profileId: string
}

/** One current Profile worker generation, held for the full scan. */
export interface HostMemoryProfileReader {
  readonly list: (after: string | null, signal: AbortSignal) => Promise<HostMemorySessionPage>
  readonly read: (sessionId: string, signal: AbortSignal) => Promise<HostMemorySessionSnapshot>
  readonly assertCurrent: () => void
}

export interface HostMemoryEvidence {
  readonly sourceRef: string
  readonly sourceVersion: string
  readonly eventSeq: number
  readonly kind: MemoryProjectedRecord['kind']
  readonly text: string
  readonly source: HostMemoryScope & { readonly sessionId: string; readonly formatVersion: number }
}
export type HostMemorySearchItem = Omit<HostMemoryEvidence, 'text'> & { readonly snippet: string }

/** Untrusted semantic-search reference; it carries no authority or display text. */
export interface HostMemoryCandidateRef {
  readonly sourceRef: string
  readonly sourceVersion: string
}

/** One bounded page of redacted text for a generation-pinned semantic worker. */
export interface HostMemoryProjectedPage {
  readonly indexEpoch: string
  readonly generation: number
  readonly items: readonly (HostMemoryCandidateRef & { readonly text: string })[]
  readonly nextOffset: number | null
}

function parseCandidate(value: unknown): HostMemoryCandidateRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'sourceRef,sourceVersion'
    || !('sourceRef' in value) || typeof value.sourceRef !== 'string' || !HASH.test(value.sourceRef)
    || !('sourceVersion' in value) || typeof value.sourceVersion !== 'string'
    || !HASH.test(value.sourceVersion)) throw new HostAuthorityError('invalid_input')
  return { sourceRef: value.sourceRef, sourceVersion: value.sourceVersion }
}

interface IndexedSession {
  readonly version: string
  readonly records: readonly HostMemoryEvidence[]
  readonly postings: ReadonlyMap<string, readonly number[]>
  readonly textBytes: number
}

function gramsOf(value: string): string[] {
  const characters = Array.from(value.toLowerCase())
  const grams = new Set<string>()
  for (let index = 0; index + 2 < characters.length; index++)
    grams.add(characters.slice(index, index + 3).join(''))
  return [...grams]
}

function indexSession(scope: HostMemoryScope, records: readonly MemoryProjectedRecord[]): IndexedSession {
  const first = records[0]
  const version = first?.sourceVersion ?? ''
  const postings = new Map<string, number[]>()
  const evidence: HostMemoryEvidence[] = []
  let textBytes = 0
  for (const record of records) {
    textBytes += Buffer.byteLength(record.text, 'utf8')
    const sourceRef = createHash('sha256').update(JSON.stringify([
      scope.ownerUserId, scope.installationId, scope.profileId, record.sessionId,
      record.sourceVersion, record.eventSeq, record.kind,
    ])).digest('hex')
    evidence.push(Object.freeze({ sourceRef, sourceVersion: record.sourceVersion, eventSeq: record.eventSeq,
      kind: record.kind, text: record.text,
      source: Object.freeze({ ownerUserId: scope.ownerUserId, installationId: scope.installationId,
        profileId: scope.profileId, sessionId: record.sessionId, formatVersion: SESSION_FORMAT_VERSION }) }))
    for (const gram of gramsOf(record.text)) {
      let indices = postings.get(gram)
      if (!indices) {
        if (postings.size >= MAX_GRAMS) throw new HostAuthorityError('busy')
        indices = []
        postings.set(gram, indices)
      }
      indices.push(evidence.length - 1)
    }
  }
  return { version, records: evidence, postings, textBytes }
}

/** Keeps only redacted text in memory; Session input is discarded after projection. */
export class HostMemoryEvidenceIndex {
  private readonly sessions = new Map<string, IndexedSession>()
  private readonly scope: HostMemoryScope
  private readonly indexEpoch = randomBytes(16).toString('hex')
  private generation = 0

  constructor(scope: HostMemoryScope) {
    const supplied: unknown = scope
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || Object.keys(supplied).sort().join(',') !== 'installationId,ownerUserId,profileId'
      || Object.values(supplied).some(value => typeof value !== 'string' || value.length < 1
        || value.length > 256 || /[\u0000-\u001f]/u.test(value)))
      throw new HostAuthorityError('invalid_input')
    this.scope = Object.freeze({ ownerUserId: scope.ownerUserId,
      installationId: scope.installationId, profileId: scope.profileId })
  }

  private checkScope(scope: HostMemoryScope): void {
    if (scope.ownerUserId !== this.scope.ownerUserId || scope.installationId !== this.scope.installationId
      || scope.profileId !== this.scope.profileId) throw new HostAuthorityError('unauthorized')
  }

  /** Replace one Session atomically after bounded local projection and capacity checks. */
  replace(scope: HostMemoryScope, snapshot: HostMemorySessionSnapshot, expectedGeneration: number): number {
    this.checkScope(scope)
    if (expectedGeneration !== this.generation) throw new HostAuthorityError('stale')
    if (!SESSION_ID.test(snapshot.sessionId)) throw new HostAuthorityError('invalid_input')
    const version = createHash('sha256').update(snapshot.revision).digest('hex')
    if (this.sessions.get(snapshot.sessionId)?.version === version) return this.generation
    const projected = snapshot.text === undefined
      ? projectMemoryLogicalSession(snapshot) : projectMemorySession(snapshot)
    const indexed = indexSession(this.scope, projected)
    const next = { ...indexed, version }
    const old = this.sessions.get(snapshot.sessionId)
    const totals = [...this.sessions.values()].reduce((sum, session) => ({
      bytes: sum.bytes + session.textBytes, records: sum.records + session.records.length,
      grams: sum.grams + session.postings.size,
    }), { bytes: 0, records: 0, grams: 0 })
    if (this.sessions.size + (old ? 0 : 1) > MAX_SESSIONS
      || totals.bytes - (old?.textBytes ?? 0) + next.textBytes > MAX_TEXT_BYTES
      || totals.records - (old?.records.length ?? 0) + next.records.length > MAX_RECORDS
      || totals.grams - (old?.postings.size ?? 0) + next.postings.size > MAX_GRAMS)
      throw new HostAuthorityError('busy')
    this.sessions.set(snapshot.sessionId, next)
    return ++this.generation
  }

  /** Remove a deleted or no longer owned Session and all its references. */
  delete(scope: HostMemoryScope, sessionId: string, expectedGeneration: number): number {
    this.checkScope(scope)
    if (expectedGeneration !== this.generation) throw new HostAuthorityError('stale')
    if (!SESSION_ID.test(sessionId)) throw new HostAuthorityError('invalid_input')
    if (this.sessions.delete(sessionId)) this.generation += 1
    return this.generation
  }

  /** Return bounded literal matches and this index instance's random epoch for later candidate resolution. */
  search(scope: HostMemoryScope, query: string, limit: number): {
    readonly indexEpoch: string
    readonly generation: number
    readonly items: readonly HostMemorySearchItem[]
  } {
    this.checkScope(scope)
    if (typeof query !== 'string' || query.length < 1 || query.length > 500 || /[\u0000-\u001f]/u.test(query)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new HostAuthorityError('invalid_input')
    const needle = query.toLowerCase()
    const grams = gramsOf(needle)
    const items: HostMemorySearchItem[] = []
    for (const [, session] of [...this.sessions].sort(([left], [right]) => left < right ? -1 : 1)) {
      let candidates: readonly number[] | undefined
      for (const gram of grams) {
        const hits = session.postings.get(gram)
        if (!hits) { candidates = []; break }
        const set = new Set(hits)
        candidates = candidates ? candidates.filter(index => set.has(index)) : hits
        if (candidates.length === 0) break
      }
      for (const index of candidates ?? session.records.keys()) {
        const record = session.records[index] as HostMemoryEvidence
        const position = record.text.toLowerCase().indexOf(needle)
        if (position < 0) continue
        const { text, ...metadata } = record
        const start = Math.max(0, position - 150)
        items.push({ ...metadata, snippet: text.slice(start, start + 500) })
        if (items.length >= limit) return { indexEpoch: this.indexEpoch, generation: this.generation, items }
      }
    }
    return { indexEpoch: this.indexEpoch, generation: this.generation, items }
  }

  /** Read one exact redacted record; a replaced source version has no old reference. */
  evidence(scope: HostMemoryScope, sourceRef: string): HostMemoryEvidence | null {
    this.checkScope(scope)
    if (!HASH.test(sourceRef)) throw new HostAuthorityError('invalid_input')
    for (const session of this.sessions.values()) {
      const found = session.records.find(record => record.sourceRef === sourceRef)
      if (found) return found
    }
    return null
  }

  /** Copy only redacted text and opaque references from this exact index generation. */
  projectedPage(scope: HostMemoryScope, indexEpoch: string | null, generation: number | null,
    offset: number): HostMemoryProjectedPage {
    this.checkScope(scope)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HostAuthorityError('invalid_input')
    if (indexEpoch === null || generation === null) {
      if (indexEpoch !== null || generation !== null || offset !== 0)
        throw new HostAuthorityError('invalid_input')
    } else {
      if (typeof indexEpoch !== 'string' || !EPOCH.test(indexEpoch))
        throw new HostAuthorityError('invalid_input')
      if (indexEpoch !== this.indexEpoch || generation !== this.generation)
        throw new HostAuthorityError('stale')
    }
    const records = [...this.sessions].sort(([left], [right]) => left < right ? -1 : 1)
      .flatMap(([, session]) => session.records)
    if (offset >= records.length && (offset !== 0 || records.length !== 0))
      throw new HostAuthorityError('invalid_input')
    const items: (HostMemoryCandidateRef & { readonly text: string })[] = []
    let bytes = 0
    for (let index = offset; index < records.length && items.length < MAX_PROJECTED_PAGE_ITEMS; index++) {
      const record = records[index] as HostMemoryEvidence
      const nextBytes = Buffer.byteLength(record.text, 'utf8')
      if (bytes + nextBytes > MAX_PROJECTED_PAGE_TEXT_BYTES) {
        if (items.length === 0) throw new HostAuthorityError('busy')
        break
      }
      items.push({ sourceRef: record.sourceRef, sourceVersion: record.sourceVersion, text: record.text })
      bytes += nextBytes
    }
    const next = offset + items.length
    return { indexEpoch: this.indexEpoch, generation: this.generation, items,
      nextOffset: next < records.length ? next : null }
  }

  /** Resolve ranked external references only for this instance's epoch and current numeric generation. */
  resolveCandidates(scope: HostMemoryScope, indexEpoch: string, generation: number,
    candidates: readonly HostMemoryCandidateRef[], limit: number): readonly HostMemorySearchItem[] {
    this.checkScope(scope)
    if (typeof indexEpoch !== 'string' || !EPOCH.test(indexEpoch))
      throw new HostAuthorityError('invalid_input')
    if (indexEpoch !== this.indexEpoch || generation !== this.generation)
      throw new HostAuthorityError('stale')
    if (!Array.isArray(candidates) || candidates.length > 10
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      throw new HostAuthorityError('invalid_input')
    const seen = new Set<string>()
    const items: HostMemorySearchItem[] = []
    for (const candidate of candidates) {
      const checked = parseCandidate(candidate)
      if (seen.has(checked.sourceRef)) throw new HostAuthorityError('invalid_input')
      seen.add(checked.sourceRef)
      const record = this.evidence(scope, checked.sourceRef)
      if (!record || record.sourceVersion !== checked.sourceVersion)
        throw new HostAuthorityError('stale')
      if (items.length < limit) {
        const { text, ...metadata } = record
        items.push({ ...metadata, snippet: text.slice(0, 500) })
      }
    }
    return items
  }

  /** Reject cached results if any Session was added, removed or revised in the current worker. */
  async assertCurrentInventory(scope: HostMemoryScope, reader: HostMemoryProfileReader,
    signal: AbortSignal): Promise<void> {
    this.checkScope(scope)
    let checked = 0
    await scanMemoryInventory(reader, signal, (sessionId, revision) => {
      if (this.sessions.get(sessionId)?.version !== createHash('sha256').update(revision).digest('hex'))
        throw new HostAuthorityError('stale')
      checked += 1
    })
    reader.assertCurrent()
    signal.throwIfAborted()
    if (checked !== this.sessions.size) throw new HostAuthorityError('stale')
  }
}

async function scanMemoryInventory(
  reader: HostMemoryProfileReader,
  signal: AbortSignal,
  visit: (sessionId: string, revision: string) => void | Promise<void>,
): Promise<void> {
  let after: string | null = null
  let count = 0
  do {
    signal.throwIfAborted()
    reader.assertCurrent()
    const page = await reader.list(after, signal)
    if (page.items.length > 64 || page.nextAfter !== null && (page.items.length !== 64
      || page.nextAfter !== page.items.at(-1)?.sessionId)) throw new HostAuthorityError('unavailable')
    for (const item of page.items) {
      if (!SESSION_ID.test(item.sessionId) || item.sessionId <= (after ?? '')
        || item.revision.length < 1 || item.revision.length > 256) throw new HostAuthorityError('unavailable')
      after = item.sessionId
      count += 1
      if (count > MAX_SESSIONS) throw new HostAuthorityError('busy')
      await visit(item.sessionId, item.revision)
    }
    reader.assertCurrent()
    if (page.nextAfter === null) return
  } while (true)
}

/** Build a complete private index, publishing nothing if inventory or worker generation changes. */
export async function buildHostMemoryEvidenceIndex(
  scope: HostMemoryScope,
  reader: HostMemoryProfileReader,
  signal: AbortSignal,
): Promise<HostMemoryEvidenceIndex> {
  const index = new HostMemoryEvidenceIndex(scope)
  let generation = 0
  await scanMemoryInventory(reader, signal, async (sessionId, revision) => {
    const snapshot = await reader.read(sessionId, signal)
    if (snapshot.sessionId !== sessionId || snapshot.revision !== revision)
      throw new HostAuthorityError('stale')
    generation = index.replace(scope, snapshot, generation)
  })
  await index.assertCurrentInventory(scope, reader, signal)
  return index
}
