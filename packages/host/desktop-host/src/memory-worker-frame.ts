/** REQ-20261021-0013: exact, bounded frames for the private Host-to-HY worker socket. */
import { HostAuthorityError } from './types.ts'

const MAX_FRAME = 512 * 1024
const MAX_PAGE_TEXT_BYTES = 256 * 1024
const NONCE = /^[0-9a-f]{32}$/u
const HASH = /^[0-9a-f]{64}$/u
const BASE = ['version', 'type', 'workerNonce', 'indexEpoch', 'generation'] as const

interface FrameBase {
  readonly version: 1
  readonly workerNonce: string
  readonly indexEpoch: string
  readonly generation: number
}

interface ProjectionFrame extends FrameBase {
  readonly type: 'projection'
  readonly pageNo: number
  readonly nextOffset: number | null
  readonly items: readonly { readonly sourceRef: string; readonly sourceVersion: string; readonly text: string }[]
  readonly totalItems?: number
  readonly projectionDigest?: string
}

interface ProjectedFrame extends FrameBase {
  readonly type: 'projected'
  readonly pageNo: number
  readonly totalItems?: number
  readonly projectionDigest?: string
}

interface QueryFrame extends FrameBase {
  readonly type: 'query'
  readonly requestId: number
  readonly query: string
  readonly limit: number
}

interface CandidatesFrame extends FrameBase {
  readonly type: 'candidates'
  readonly requestId: number
  readonly candidates: readonly { readonly sourceRef: string; readonly sourceVersion: string }[]
}

interface EmbedFrame extends FrameBase {
  readonly type: 'embed'
  readonly embedId: number
  readonly values: readonly string[]
}

interface EmbeddingFrame extends FrameBase {
  readonly type: 'embedding'
  readonly embedId: number
  readonly vectors: readonly (readonly number[])[]
}

export type MemoryWorkerFrame = ProjectionFrame | ProjectedFrame | QueryFrame | CandidatesFrame
  | EmbedFrame | EmbeddingFrame

function reject(): never { throw new HostAuthorityError('invalid_input') }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) return reject()
  return row
}

function integer(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function reference(value: unknown, text: boolean): Record<string, unknown> {
  const row = record(value, text ? ['sourceRef', 'sourceVersion', 'text'] : ['sourceRef', 'sourceVersion'])
  if (typeof row.sourceRef !== 'string' || !HASH.test(row.sourceRef)
    || typeof row.sourceVersion !== 'string' || !HASH.test(row.sourceVersion)
    || (text && (typeof row.text !== 'string'
      || Buffer.from(row.text, 'utf8').toString('utf8') !== row.text))) return reject()
  return row
}

function parse(value: unknown): MemoryWorkerFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject()
  const frame = value as Record<string, unknown>
  if (frame.version !== 1 || typeof frame.workerNonce !== 'string' || !NONCE.test(frame.workerNonce)
    || typeof frame.indexEpoch !== 'string' || !NONCE.test(frame.indexEpoch)
    || !integer(frame.generation, 0)) return reject()
  const base = { version: 1 as const, workerNonce: frame.workerNonce,
    indexEpoch: frame.indexEpoch, generation: frame.generation as number }
  if (frame.type === 'projection') {
    if (!integer(frame.pageNo, 0) || frame.nextOffset !== null && !integer(frame.nextOffset, 0)
      || !Array.isArray(frame.items) || frame.items.length > 16) return reject()
    const final = frame.nextOffset === null
    record(frame, final
      ? [...BASE, 'pageNo', 'nextOffset', 'items', 'totalItems', 'projectionDigest']
      : [...BASE, 'pageNo', 'nextOffset', 'items'])
    if (final && (!integer(frame.totalItems, 0) || (frame.totalItems as number) > 20_000
      || typeof frame.projectionDigest !== 'string' || !HASH.test(frame.projectionDigest))) return reject()
    let bytes = 0
    const items: { sourceRef: string; sourceVersion: string; text: string }[] = []
    for (const value of frame.items) {
      const row = reference(value, true)
      bytes += Buffer.byteLength(row.text as string, 'utf8')
      if (bytes > MAX_PAGE_TEXT_BYTES) return reject()
      items.push({ sourceRef: row.sourceRef as string, sourceVersion: row.sourceVersion as string,
        text: row.text as string })
    }
    return { ...base, type: 'projection', pageNo: frame.pageNo as number,
      nextOffset: frame.nextOffset as number | null, items,
      ...(final ? { totalItems: frame.totalItems as number,
        projectionDigest: frame.projectionDigest as string } : {}) }
  } else if (frame.type === 'projected') {
    const final = Object.hasOwn(frame, 'totalItems') || Object.hasOwn(frame, 'projectionDigest')
    record(frame, final ? [...BASE, 'pageNo', 'totalItems', 'projectionDigest'] : [...BASE, 'pageNo'])
    if (!integer(frame.pageNo, 0)) return reject()
    if (final && (!integer(frame.totalItems, 0) || (frame.totalItems as number) > 20_000
      || typeof frame.projectionDigest !== 'string' || !HASH.test(frame.projectionDigest))) return reject()
    return { ...base, type: 'projected', pageNo: frame.pageNo as number,
      ...(final ? { totalItems: frame.totalItems as number,
        projectionDigest: frame.projectionDigest as string } : {}) }
  } else if (frame.type === 'query') {
    record(frame, [...BASE, 'requestId', 'query', 'limit'])
    if (!integer(frame.requestId, 1) || !integer(frame.limit, 1) || (frame.limit as number) > 10
      || typeof frame.query !== 'string' || frame.query.length < 1 || frame.query.length > 500
      || /[\u0000-\u001f]/u.test(frame.query)
      || Buffer.from(frame.query, 'utf8').toString('utf8') !== frame.query) return reject()
    return { ...base, type: 'query', requestId: frame.requestId as number,
      query: frame.query, limit: frame.limit as number }
  } else if (frame.type === 'candidates') {
    record(frame, [...BASE, 'requestId', 'candidates'])
    if (!integer(frame.requestId, 1) || !Array.isArray(frame.candidates)
      || frame.candidates.length > 10) return reject()
    const seen = new Set<string>()
    const candidates: { sourceRef: string; sourceVersion: string }[] = []
    for (const value of frame.candidates) {
      const row = reference(value, false)
      if (seen.has(row.sourceRef as string)) return reject()
      seen.add(row.sourceRef as string)
      candidates.push({ sourceRef: row.sourceRef as string, sourceVersion: row.sourceVersion as string })
    }
    return { ...base, type: 'candidates', requestId: frame.requestId as number, candidates }
  } else if (frame.type === 'embed') {
    record(frame, [...BASE, 'embedId', 'values'])
    if (!integer(frame.embedId, 1) || (frame.embedId as number) > 64
      || !Array.isArray(frame.values) || frame.values.length < 1 || frame.values.length > 8) return reject()
    let bytes = 0
    const values: string[] = []
    for (const value of frame.values) {
      if (typeof value !== 'string' || value.length < 1 || value.length > 4096
        || Buffer.from(value, 'utf8').toString('utf8') !== value) return reject()
      bytes += Buffer.byteLength(value, 'utf8')
      if (bytes > 16 * 1024) return reject()
      values.push(value)
    }
    return { ...base, type: 'embed', embedId: frame.embedId as number, values }
  } else if (frame.type === 'embedding') {
    record(frame, [...BASE, 'embedId', 'vectors'])
    if (!integer(frame.embedId, 1) || (frame.embedId as number) > 64
      || !Array.isArray(frame.vectors) || frame.vectors.length < 1 || frame.vectors.length > 8) return reject()
    const vectors: number[][] = []
    for (const value of frame.vectors) {
      if (!Array.isArray(value) || value.length !== 1024
        || value.some(part => typeof part !== 'number' || !Number.isFinite(part))) return reject()
      vectors.push(value as number[])
    }
    return { ...base, type: 'embedding', embedId: frame.embedId as number, vectors }
  } else return reject()
}

/** Serialize one validated JSON frame with a four-byte network-order length prefix. */
export function encodeMemoryWorkerFrame(value: unknown): Buffer {
  const frame = parse(value)
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  /* v8 ignore next -- every admitted frame shape is smaller than MAX_FRAME; retain a final serialization guard. */
  if (body.byteLength < 1 || body.byteLength > MAX_FRAME) return reject()
  const output = Buffer.allocUnsafe(4 + body.byteLength)
  output.writeUInt32BE(body.byteLength, 0)
  body.copy(output, 4)
  return output
}

/** Decode exactly one complete frame; a stream owner must apply its own deadline and peer check. */
export function decodeMemoryWorkerFrame(bytes: Buffer): MemoryWorkerFrame {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 5) return reject()
  const length = bytes.readUInt32BE(0)
  if (length < 1 || length > MAX_FRAME || bytes.byteLength !== length + 4) return reject()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4))) }
  catch { return reject() }
  return parse(value)
}

/** Assemble complete frames from a socket stream without buffering beyond one bounded frame. */
export class MemoryWorkerFrameAssembler {
  private readonly buffer = Buffer.alloc(4 + MAX_FRAME)
  private used = 0
  private expected = 4
  private closed = false

  /** Report whether the current stream ends inside a frame. */
  hasPartialFrame(): boolean { return this.used !== 0 }

  push(chunk: Buffer): MemoryWorkerFrame[] {
    if (this.closed) return reject()
    try {
      if (!Buffer.isBuffer(chunk)) return reject()
      const frames: MemoryWorkerFrame[] = []
      let offset = 0
      while (offset < chunk.byteLength) {
        const take = Math.min(this.expected - this.used, chunk.byteLength - offset)
        chunk.copy(this.buffer, this.used, offset, offset + take)
        this.used += take
        offset += take
        if (this.used === 4 && this.expected === 4) {
          const length = this.buffer.readUInt32BE(0)
          if (length < 1 || length > MAX_FRAME) return reject()
          this.expected = length + 4
        }
        if (this.used === this.expected && this.expected > 4) {
          frames.push(decodeMemoryWorkerFrame(this.buffer.subarray(0, this.used)))
          this.buffer.fill(0, 0, this.used)
          this.used = 0
          this.expected = 4
        }
      }
      return frames
    } catch (error) {
      this.closed = true
      this.buffer.fill(0, 0, this.used)
      this.used = 0
      throw error
    }
  }

  /** A clean stream end must not leave a partial header or body. */
  finish(): void {
    if (this.closed) return reject()
    this.closed = true
    if (this.used !== 0) {
      this.buffer.fill(0, 0, this.used)
      this.used = 0
      return reject()
    }
  }
}
