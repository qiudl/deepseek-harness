/** REQ-20261013-0021 / 24206. Bounded, connection-owned immutable package reads. */
const MAX_OBJECT_BYTES = 10 * 1024 * 1024
const MAX_CHUNK_BYTES = 32 * 1024
const MAX_READERS = 8
const IDLE_MS = 300_000
const fail = (): never => { throw Error('skillhub_package_snapshot_unavailable') }

/** Keep one fully verified package manifest for consecutive objects on one authenticated connection. */
export class SkillHubPackageTransferSnapshot<T> {
  private current: { key: string; value: Promise<T> } | undefined

  /** Refresh for manifest reads; file reads reuse the matching operation and verify their own bytes. */
  async get(key: string, capture: () => Promise<T>, fresh = false): Promise<T> {
    if (!fresh && this.current?.key === key) return this.current.value
    const entry = { key, value: Promise.resolve().then(capture) }
    this.current = entry
    try { return await entry.value }
    catch (error) {
      if (this.current === entry) this.current = undefined
      throw error
    }
  }

  /** Drop retained evidence when the owning connection closes. */
  clear(): void { this.current = undefined }
}

interface ActiveRead {
  readonly ownerId: string
  readonly bindingKey: string
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly bytes: Promise<Buffer>
  timer: NodeJS.Timeout
  nextOffset: number
  lastOffset: number
  lastChunk: Buffer | null
  complete: boolean
}

/** Retain at most one verified package object per authenticated connection. */
export class SkillHubPackageSnapshotReads {
  private readonly reads = new Map<string, ActiveRead>()

  /** Capture at offset zero, then serve exact sequential chunks or an identical retry. */
  async read(input: {
    readonly ownerId: string
    readonly bindingKey: string
    readonly offset: number
    readonly signal: AbortSignal
    readonly authorize: () => void
    readonly capture: () => Promise<Buffer>
  }): Promise<Readonly<{ totalBytes: number; chunk: Buffer; complete: boolean }>> {
    input.signal.throwIfAborted(); input.authorize()
    if (!input.ownerId || !input.bindingKey || !Number.isSafeInteger(input.offset) || input.offset < 0
      || input.offset > MAX_OBJECT_BYTES) fail()
    let active = this.reads.get(input.ownerId)
    if (active?.complete && input.offset === 0 && active.bindingKey !== input.bindingKey) {
      this.release(active)
      active = undefined
    }
    if (!active) {
      if (input.offset !== 0 || this.reads.size >= MAX_READERS) fail()
      const holder = {} as { active: ActiveRead }
      const onAbort = () => { this.release(holder.active) }
      const timer = setTimeout(onAbort, IDLE_MS)
      timer.unref()
      const created: ActiveRead = {
        ownerId: input.ownerId, bindingKey: input.bindingKey, signal: input.signal, onAbort, timer,
        bytes: Promise.resolve().then(input.capture).then(bytes => Buffer.from(bytes)),
        nextOffset: 0, lastOffset: -1, lastChunk: null, complete: false,
      }
      holder.active = created
      active = created
      this.reads.set(input.ownerId, active)
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      if (active.signal !== input.signal || active.bindingKey !== input.bindingKey) fail()
      const bytes = await active.bytes
      if (bytes.length > MAX_OBJECT_BYTES) fail()
      input.signal.throwIfAborted(); input.authorize()
      if (input.offset === active.lastOffset && active.lastChunk) {
        return { totalBytes: bytes.length, chunk: Buffer.from(active.lastChunk), complete: active.complete }
      }
      if (input.offset !== active.nextOffset || (input.offset === bytes.length && bytes.length > 0)) fail()
      const chunk = Buffer.from(bytes.subarray(input.offset, Math.min(input.offset + MAX_CHUNK_BYTES, bytes.length)))
      active.lastOffset = input.offset
      active.lastChunk = chunk
      active.nextOffset += chunk.length
      active.complete = active.nextOffset === bytes.length
      clearTimeout(active.timer)
      active.timer = setTimeout(active.onAbort, IDLE_MS)
      active.timer.unref()
      return { totalBytes: bytes.length, chunk: Buffer.from(chunk), complete: active.complete }
    } catch (error) {
      if (this.reads.get(input.ownerId) === active) this.release(active)
      throw error
    }
  }

  private release(active: ActiveRead): void {
    /* v8 ignore next -- stale timer/abort callbacks are detached by the owning release. */
    if (this.reads.get(active.ownerId) !== active) return
    this.reads.delete(active.ownerId)
    clearTimeout(active.timer)
    active.signal.removeEventListener('abort', active.onAbort)
  }
}
