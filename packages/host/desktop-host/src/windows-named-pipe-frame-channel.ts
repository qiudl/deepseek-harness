import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { WindowsNamedPipeIoBindings } from './windows-named-pipe-io.ts'

/** Sequential JSONL framing over one already-attested Windows named-pipe handle. */
export class WindowsNamedPipeFrameChannel {
  private buffer = Buffer.alloc(0)
  private reading = false
  private writeTail = Promise.resolve()
  private writeFailure: Error | undefined

  constructor(
    private readonly handle: bigint,
    private readonly io: WindowsNamedPipeIoBindings,
  ) {}

  /** Read exactly one canonical shared-protocol frame, or null after a clean peer disconnect. */
  readFrame(): Promise<HostControlFrame | null> {
    if (this.reading) return Promise.reject(new Error('concurrent Windows named-pipe read'))
    this.reading = true
    return this.readFrameOnce().finally(() => { this.reading = false })
  }

  /** Serialize complete frame writes so concurrent responses can never interleave. */
  send(frame: HostControlFrame): Promise<void> {
    let encoded: Buffer
    try { encoded = Buffer.from(encodeHostControlFrame(frame)) } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('invalid Windows named-pipe frame'))
    }
    const operation = this.writeTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure
      try { await this.io.writeFrame(this.handle, encoded) } catch (error) {
        this.writeFailure = error instanceof Error
          ? error
          : new Error('unknown Windows named-pipe write failure')
        throw this.writeFailure
      }
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private async readFrameOnce(): Promise<HostControlFrame | null> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0A)
      if (newline >= 0) {
        const source = this.buffer.subarray(0, newline + 1).toString('utf8')
        this.buffer = this.buffer.subarray(newline + 1)
        try { return decodeHostControlFrame(source) } catch {
          throw new Error('invalid Windows named-pipe frame')
        }
      }
      if (this.buffer.byteLength > HOST_CONTROL_MAX_FRAME_BYTES) {
        throw new Error('oversized Windows named-pipe frame')
      }
      const remainingCapacity = HOST_CONTROL_MAX_FRAME_BYTES + 1 - this.buffer.byteLength
      const chunk = await this.io.read(this.handle, remainingCapacity)
      if (chunk === null) {
        if (this.buffer.byteLength === 0) return null
        throw new Error('truncated Windows named-pipe frame')
      }
      if (!Buffer.isBuffer(chunk) || chunk.byteLength < 1 || chunk.byteLength > remainingCapacity) {
        throw new Error('invalid Windows named-pipe chunk')
      }
      this.buffer = Buffer.concat([this.buffer, chunk])
    }
  }
}
