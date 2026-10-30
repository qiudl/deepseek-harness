/** REQ-20261021-0013: fail-closed ordering for one private HY worker connection. */
import { createHash, type Hash } from 'node:crypto'
import { encodeMemoryWorkerFrame, type MemoryWorkerFrame } from './memory-worker-frame.ts'
import { HostAuthorityError } from './types.ts'

type ProjectionItem = { readonly sourceRef: string; readonly sourceVersion: string; readonly text: string }
type Candidate = { readonly sourceRef: string; readonly sourceVersion: string }

function addProjectionItem(hash: Hash, item: ProjectionItem): void {
  for (const value of [item.sourceRef, item.sourceVersion, item.text]) {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.byteLength)
    hash.update(length).update(bytes)
  }
}

export class MemoryWorkerProtocol {
  private pageNo = 0
  private pendingPage: number | null = null
  private finalPage = false
  private ready = false
  private requestId = 0
  private pendingQuery: { id: number; limit: number } | null = null
  private closed = false
  private projectionHash = createHash('sha256')
  private totalItems = 0
  private finalDigest: string | undefined
  private embedId = 0
  private pendingEmbed: { id: number; count: number } | undefined

  constructor(private readonly workerNonce: string, private readonly indexEpoch: string,
    private readonly generation: number) {
    encodeMemoryWorkerFrame({ ...this.base(), type: 'projected', pageNo: 0 })
  }

  private base() {
    return { version: 1, workerNonce: this.workerNonce,
      indexEpoch: this.indexEpoch, generation: this.generation } as const
  }

  private reject(): never {
    this.closed = true
    throw new HostAuthorityError('stale')
  }

  close(): void { this.closed = true }

  project(items: readonly ProjectionItem[], nextOffset: number | null): Buffer {
    if (this.closed || this.ready || this.pendingPage !== null || this.finalPage) return this.reject()
    const nextHash = this.projectionHash.copy()
    for (const item of items) addProjectionItem(nextHash, item)
    const nextTotal = this.totalItems + items.length
    if (nextTotal > 20_000) return this.reject()
    const digest = nextOffset === null ? nextHash.copy().digest('hex') : undefined
    const frame = encodeMemoryWorkerFrame({ ...this.base(), type: 'projection',
      pageNo: this.pageNo, nextOffset, items,
      ...(digest ? { totalItems: nextTotal, projectionDigest: digest } : {}) })
    this.projectionHash = nextHash
    this.totalItems = nextTotal
    this.pendingPage = this.pageNo
    this.finalPage = nextOffset === null
    this.finalDigest = digest
    return frame
  }

  query(text: string, limit: number): Buffer {
    if (this.closed || !this.ready || this.pendingQuery !== null
      || this.requestId === Number.MAX_SAFE_INTEGER) return this.reject()
    const nextId = this.requestId + 1
    const frame = encodeMemoryWorkerFrame({ ...this.base(), type: 'query',
      requestId: nextId, query: text, limit })
    this.requestId = nextId
    this.pendingQuery = { id: nextId, limit }
    return frame
  }

  /** Admit one sequential worker embedding request during an active projection or query. */
  acceptEmbed(frame: MemoryWorkerFrame): readonly string[] {
    if (this.closed || frame.type !== 'embed' || frame.workerNonce !== this.workerNonce
      || frame.indexEpoch !== this.indexEpoch || frame.generation !== this.generation
      || (this.pendingPage === null && this.pendingQuery === null)
      || this.pendingEmbed !== undefined || frame.embedId !== this.embedId + 1
      || frame.embedId > 64) return this.reject()
    this.embedId = frame.embedId
    this.pendingEmbed = { id: frame.embedId, count: frame.values.length }
    return frame.values
  }

  /** Validate the model result before releasing vectors to the worker. */
  replyEmbedding(vectors: readonly (readonly number[])[]): Buffer {
    const pending = this.pendingEmbed
    if (this.closed || !pending || vectors.length !== pending.count) return this.reject()
    const result = encodeMemoryWorkerFrame({ ...this.base(), type: 'embedding',
      embedId: pending.id, vectors })
    this.pendingEmbed = undefined
    return result
  }

  /** Accept only the response expected by the current Host-owned transaction. */
  receive(frame: MemoryWorkerFrame): readonly Candidate[] | null {
    if (this.closed || frame.workerNonce !== this.workerNonce
      || frame.indexEpoch !== this.indexEpoch || frame.generation !== this.generation
      || this.pendingEmbed !== undefined) return this.reject()
    if (frame.type === 'projected' && this.pendingPage === frame.pageNo) {
      if (this.finalPage && (frame.totalItems !== this.totalItems
        || frame.projectionDigest !== this.finalDigest)) return this.reject()
      // A ready worker must have room for at least its first query embedding.
      if (this.finalPage && this.embedId >= 64) return this.reject()
      if (!this.finalPage && (frame.totalItems !== undefined
        || frame.projectionDigest !== undefined)) return this.reject()
      this.pendingPage = null
      if (this.finalPage) this.ready = true
      else this.pageNo += 1
      return null
    }
    if (frame.type === 'candidates' && this.pendingQuery?.id === frame.requestId
      && frame.candidates.length <= this.pendingQuery.limit) {
      this.pendingQuery = null
      return frame.candidates
    }
    return this.reject()
  }
}
