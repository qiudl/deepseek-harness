import { createHash } from 'node:crypto'
import {
  parseHostCollaborationDeliveryCapsule, parseHostCollaborationDeliveryChunk,
  parseHostCollaborationDeliveryCommit, matchesHostCollaborationDeliveryCommit,
} from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import type { HostCollaborationDeliveryCapsule, HostCollaborationDeliveryChunk, HostCollaborationDeliveryCommit } from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import { HostAuthorityError } from './types.ts'

/** Captures one running worker; every fragment and completed write must retain that same worker. */
export interface CollaborationDeliveryReceiver {
  readonly assertCurrent: () => void
  readonly receive: (capsule: HostCollaborationDeliveryCapsule, signal: AbortSignal) => Promise<unknown>
}
interface Upload {
  readonly key: string
  readonly bindingKey: string
  readonly bytes: Buffer
  readonly digest: string
  readonly receiver: CollaborationDeliveryReceiver
  readonly cancellation: AbortController
  readonly lifetime: AbortSignal
  readonly abort: () => void
  readonly timer: NodeJS.Timeout
  offset: number
  lastOffset: number
  lastLength: number
  committing: boolean
}
type UploadResult =
  | Readonly<{ kind: 'staged'; upload_id: string; next_offset: number }>
  | Readonly<{ kind: 'committed'; commit: HostCollaborationDeliveryCommit }>

/** Host-owned bounded buffers across all control connections; the Profile alone owns durable replies. */
export class CollaborationDeliveryUploads {
  private readonly uploads = new Map<string, Upload>()
  private reserved = 0

  /**
   * Assemble sequential fragments and ask the captured original worker for its first durable commit.
   * @param input - Live authenticated owner, Account binding, bounded fragment and worker factory.
   * @returns Progress or matching commit; cancellation, identity changes and uncertain writes never certify delivery.
   */
  async accept(input: {
    readonly ownerId: string
    readonly bindingKey: string
    readonly signal: AbortSignal
    readonly chunk: HostCollaborationDeliveryChunk
    readonly authorize: () => void
    readonly capture: () => CollaborationDeliveryReceiver
  }): Promise<UploadResult> {
    input.signal.throwIfAborted(); input.authorize()
    const chunk = parseHostCollaborationDeliveryChunk(input.chunk), key = JSON.stringify([input.ownerId, chunk.upload_id])
    let upload = this.uploads.get(key)
    if (!upload) {
      if (chunk.offset !== 0 || this.uploads.size >= 4 || this.reserved + chunk.total_bytes > 4 * 1024 * 1024)
        throw new HostAuthorityError('unavailable')
      const receiver = input.capture()
      receiver.assertCurrent()
      const cancellation = new AbortController()
      const abort = () => {
        cancellation.abort(new HostAuthorityError('stale'))
        if (upload && !upload.committing) this.release(upload)
      }
      const timer = setTimeout(abort, 30_000); timer.unref()
      upload = { key, bindingKey: input.bindingKey, bytes: Buffer.alloc(chunk.total_bytes), digest: chunk.payload_digest,
        receiver, cancellation, lifetime: input.signal, abort, timer, offset: 0, lastOffset: -1, lastLength: 0, committing: false }
      this.uploads.set(key, upload); this.reserved += chunk.total_bytes
      input.signal.addEventListener('abort', abort, { once: true })
    }
    if (upload.committing) throw new HostAuthorityError('stale')
    try {
      upload.cancellation.signal.throwIfAborted(); upload.receiver.assertCurrent()
      if (upload.bindingKey !== input.bindingKey || upload.lifetime !== input.signal
        || upload.digest !== chunk.payload_digest || upload.bytes.length !== chunk.total_bytes) throw new HostAuthorityError('stale')
      const part = Buffer.from(chunk.chunk_base64url, 'base64url')
      if (chunk.offset === upload.lastOffset && part.length === upload.lastLength
        && upload.bytes.subarray(chunk.offset, chunk.offset + part.length).equals(part))
        return { kind: 'staged', upload_id: chunk.upload_id, next_offset: upload.offset }
      if (chunk.offset !== upload.offset) throw new HostAuthorityError('stale')
      part.copy(upload.bytes, chunk.offset)
      upload.lastOffset = chunk.offset; upload.lastLength = part.length; upload.offset += part.length
      if (upload.offset < upload.bytes.length) return { kind: 'staged', upload_id: chunk.upload_id, next_offset: upload.offset }
      if (createHash('sha256').update(upload.bytes).digest('hex') !== upload.digest) throw new HostAuthorityError('stale')
      let capsule: HostCollaborationDeliveryCapsule
      try { capsule = parseHostCollaborationDeliveryCapsule(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes))) }
      catch { throw new HostAuthorityError('unavailable') }
      input.authorize(); upload.receiver.assertCurrent()
      upload.committing = true
      const commit = parseHostCollaborationDeliveryCommit(await upload.receiver.receive(capsule, upload.cancellation.signal))
      input.signal.throwIfAborted(); upload.cancellation.signal.throwIfAborted()
      input.authorize(); upload.receiver.assertCurrent()
      if (!matchesHostCollaborationDeliveryCommit(capsule, commit)) throw new HostAuthorityError('stale')
      return { kind: 'committed', commit }
    } catch (error) {
      upload.cancellation.abort(error)
      this.release(upload)
      throw error
    } finally {
      if (upload.committing) this.release(upload)
    }
  }

  private release(upload: Upload): void {
    if (this.uploads.get(upload.key) !== upload) return
    this.uploads.delete(upload.key); this.reserved -= upload.bytes.length
    clearTimeout(upload.timer); upload.lifetime.removeEventListener('abort', upload.abort)
  }
}
