/** REQ-20261021-0013: fail-closed ordering for one private HY worker connection. */
import { encodeMemoryWorkerFrame, type MemoryWorkerFrame } from './memory-worker-frame.ts'
import { HostAuthorityError } from './types.ts'

type ProjectionItem = { readonly sourceRef: string; readonly sourceVersion: string; readonly text: string }
type Candidate = { readonly sourceRef: string; readonly sourceVersion: string }

export class MemoryWorkerProtocol {
  private pageNo = 0
  private pendingPage: number | null = null
  private finalPage = false
  private ready = false
  private requestId = 0
  private pendingQuery: { id: number; limit: number } | null = null
  private closed = false

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
    const frame = encodeMemoryWorkerFrame({ ...this.base(), type: 'projection',
      pageNo: this.pageNo, nextOffset, items })
    this.pendingPage = this.pageNo
    this.finalPage = nextOffset === null
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

  /** Accept only the response expected by the current Host-owned transaction. */
  receive(frame: MemoryWorkerFrame): readonly Candidate[] | null {
    if (this.closed || frame.workerNonce !== this.workerNonce
      || frame.indexEpoch !== this.indexEpoch || frame.generation !== this.generation) return this.reject()
    if (frame.type === 'projected' && this.pendingPage === frame.pageNo) {
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
