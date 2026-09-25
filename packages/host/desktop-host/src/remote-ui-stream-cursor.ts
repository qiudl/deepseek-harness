/** One bounded, nonblocking cursor for a Profile worker's native Session-follow stream. */

const MAX_ITEM_BYTES = 512 * 1024
const CHUNK_BYTES = 16 * 1024

/** A single poll result that fits inside a 64 KiB Host control frame. */
export type RemoteUiStreamPoll =
  | { readonly type: 'idle' | 'end' | 'error' }
  | { readonly type: 'chunk'; readonly bytes: string; readonly final: boolean }

/**
 * Retain at most one native event until the control client drains all its chunks.
 * The next worker read starts only after the final chunk, so a slow browser cannot
 * accumulate an unbounded Host-side event queue.
 */
export class RemoteUiStreamCursor {
  private state: 'open' | 'end' | 'error' | 'closed' = 'open'
  private item: Buffer | undefined
  private offset = 0
  private pending: Promise<void> | undefined
  private closeTask: Promise<void> | undefined

  private constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly controller: AbortController,
    private readonly lifetime?: AbortSignal,
  ) {
    lifetime?.addEventListener('abort', this.onLifetimeAbort, { once: true })
    this.pull()
  }

  /**
   * Open one selected Profile stream and start a single event read.
   * @param open - Worker stream factory receiving the cursor-owned cancellation signal.
   * @param lifetime - Owner connection lifetime; its abort closes the cursor.
   * @returns The nonblocking cursor after the worker accepts the stream.
   */
  static async open(
    open: (signal: AbortSignal) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>,
    lifetime?: AbortSignal,
  ): Promise<RemoteUiStreamCursor> {
    lifetime?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => { controller.abort() }
    lifetime?.addEventListener('abort', abort, { once: true })
    try {
      const stream = await open(controller.signal)
      lifetime?.throwIfAborted()
      return new RemoteUiStreamCursor(stream[Symbol.asyncIterator](), controller, lifetime)
    } finally {
      lifetime?.removeEventListener('abort', abort)
    }
  }

  /**
   * Read one available chunk without waiting for the next Gateway event.
   * @returns Idle, an encoded JSON chunk, or a terminal state without worker error detail.
   */
  poll(): RemoteUiStreamPoll {
    if (this.state === 'closed') return { type: 'end' }
    if (this.item) {
      const end = Math.min(this.offset + CHUNK_BYTES, this.item.byteLength)
      const bytes = this.item.subarray(this.offset, end).toString('base64url')
      const final = end === this.item.byteLength
      this.offset = end
      if (final) { this.item = undefined; this.offset = 0; this.pull() }
      return { type: 'chunk', bytes, final }
    }
    return { type: this.state === 'open' ? 'idle' : this.state }
  }

  /** Abort the worker read and wait for its iterator to settle before releasing the cursor. */
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.state = 'closed'
    this.controller.abort()
    this.lifetime?.removeEventListener('abort', this.onLifetimeAbort)
    this.closeTask = (async () => {
      await Promise.allSettled([this.pending, this.iterator.return?.()])
    })()
    return this.closeTask
  }

  private readonly onLifetimeAbort = (): void => { void this.close() }

  private pull(): void {
    this.pending = (async () => {
      try {
        const next = await this.iterator.next()
        if (this.state !== 'open') return
        if (next.done) { this.state = 'end'; return }
        const item = Buffer.from(JSON.stringify(next.value))
        if (item.byteLength > MAX_ITEM_BYTES) { this.state = 'error'; this.controller.abort(); return }
        this.item = item
      } catch {
        if (this.state === 'open') this.state = 'error'
      }
    })()
  }
}
