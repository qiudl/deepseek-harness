/** REQ-20261021-0013: one authenticated Host-side HY worker socket connection. */
import type { Socket } from 'node:net'
import { readConnectedMacOSPeerIdentity } from './macos-peer-attestor.ts'
import { MemoryWorkerFrameAssembler, type MemoryWorkerFrame } from './memory-worker-frame.ts'
import { MemoryWorkerProtocol } from './memory-worker-protocol.ts'
import { HostAuthorityError } from './types.ts'

type ProjectionItem = { readonly sourceRef: string; readonly sourceVersion: string; readonly text: string }
type Candidate = { readonly sourceRef: string; readonly sourceVersion: string }

interface Pending {
  readonly kind: 'projected' | 'candidates'
  readonly resolve: (value: readonly Candidate[] | null) => void
  readonly reject: (error: Error) => void
  readonly signal: AbortSignal
  readonly onAbort: () => void
}

/** A connected worker may receive one Host request at a time. Errors destroy the socket. */
export class MemoryWorkerChannel {
  private readonly assembler = new MemoryWorkerFrameAssembler()
  private pending: Pending | undefined
  private closed = false
  private embeddingInFlight = false

  private constructor(private readonly socket: Socket, private readonly protocol: MemoryWorkerProtocol,
    private readonly embed: (values: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>) {
    socket.on('data', (chunk) => { this.onData(chunk) })
    socket.on('error', () => { this.close() })
    socket.on('end', () => { this.close() })
    socket.on('close', () => { this.close() })
    socket.resume()
  }

  /** Verify the macOS kernel peer UID/PID before attaching any frame reader. */
  static async accept(socket: Socket, protocol: MemoryWorkerProtocol,
    expectedUid: number, expectedPid: number,
    embed: (values: readonly string[], signal: AbortSignal) => Promise<readonly (readonly number[])[]>): Promise<MemoryWorkerChannel> {
    socket.pause()
    try {
      if (!Number.isSafeInteger(expectedUid) || expectedUid < 0
        || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) throw new HostAuthorityError('invalid_input')
      const peer = await readConnectedMacOSPeerIdentity(socket)
      if (socket.destroyed || peer.uid !== expectedUid || peer.pid !== expectedPid) {
        throw new HostAuthorityError('unauthorized')
      }
      return new MemoryWorkerChannel(socket, protocol, embed)
    } catch (error) {
      socket.destroy()
      protocol.close()
      throw error
    }
  }

  private settle(error?: Error, value?: readonly Candidate[] | null): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    pending.signal.removeEventListener('abort', pending.onAbort)
    if (error) pending.reject(error)
    else pending.resolve(value ?? null)
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return
    try {
      if (!this.pending || this.embeddingInFlight) throw new HostAuthorityError('invalid_input')
      const expectedKind = this.pending.kind
      const frames = this.assembler.push(chunk)
      if (frames.length > 1 || frames.length === 1 && this.assembler.hasPartialFrame()) {
        throw new HostAuthorityError('invalid_input')
      }
      for (const frame of frames) {
        if (frame.type === 'embed') {
          this.embeddingInFlight = true
          this.socket.pause()
          void this.answerEmbed(frame)
          return
        }
        const result = this.protocol.receive(frame)
        if ((expectedKind === 'projected' && result !== null)
          || (expectedKind === 'candidates' && result === null)) throw new HostAuthorityError('invalid_input')
        this.settle(undefined, result)
      }
    } catch { this.close() }
  }

  private async answerEmbed(frame: MemoryWorkerFrame): Promise<void> {
    const pending = this.pending
    if (!pending) { this.close(); return }
    try {
      const values = this.protocol.acceptEmbed(frame)
      const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(30_000)])
      const vectors = await this.embed(values, signal)
      signal.throwIfAborted()
      if (this.closed || this.pending !== pending) throw new HostAuthorityError('stale')
      const response = this.protocol.replyEmbedding(vectors)
      this.socket.write(response, (error) => { if (error) this.close() })
      this.embeddingInFlight = false
      this.socket.resume()
    } catch { this.close() }
  }

  private transact(frame: Buffer, kind: Pending['kind'], signal: AbortSignal,
    timeoutMs: number): Promise<readonly Candidate[] | null> {
    if (this.closed || this.pending || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 120_000) throw new HostAuthorityError('unavailable')
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    deadline.throwIfAborted()
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.close() }
      this.pending = { kind, resolve, reject, signal: deadline, onAbort }
      deadline.addEventListener('abort', onAbort, { once: true })
      this.socket.write(frame, (error) => { if (error) this.close() })
    })
  }

  /** Send one redacted page and wait for its matching worker acknowledgement. */
  async project(items: readonly ProjectionItem[], nextOffset: number | null,
    signal: AbortSignal): Promise<void> {
    if (this.closed || this.pending) throw new HostAuthorityError('unavailable')
    try {
      const frame = this.protocol.project(items, nextOffset)
      await this.transact(frame, 'projected', signal, 45_000)
    } catch (error) { this.close(); throw error }
  }

  /** Send one already-authorized query; candidate references remain untrusted until Host resolution. */
  async query(text: string, limit: number, signal: AbortSignal): Promise<readonly Candidate[]> {
    if (this.closed || this.pending) throw new HostAuthorityError('unavailable')
    try {
      const frame = this.protocol.query(text, limit)
      const result = await this.transact(frame, 'candidates', signal, 10_000)
      if (result === null) throw new HostAuthorityError('invalid_input')
      return result
    } catch (error) { this.close(); throw error }
  }

  /** Close the connection and reject its outstanding operation. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.protocol.close()
    this.socket.destroy()
    this.settle(new HostAuthorityError('stale'))
  }
}
