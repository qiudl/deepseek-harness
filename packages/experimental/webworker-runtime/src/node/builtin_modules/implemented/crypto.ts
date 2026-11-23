/**
 * `node:crypto` for the worker: WebCrypto for randomness, `@noble/hashes` for the
 * synchronous digests Node's streaming Hash object provides (SubtleCrypto is
 * async, and every caller here hashes synchronously).
 */
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { randomUUID as mintUUID } from '@deepseek-ai/dsh-util-crypto'
import { Buffer } from 'buffer'

interface DigestState {
  update(bytes: Uint8Array): void
  digest(): Uint8Array
  clone(): DigestState
}

const HASHERS = new Map<string, () => DigestState>([
  ['sha1', () => sha1.create()],
  ['sha256', () => sha256.create()],
  ['sha512', () => sha512.create()],
])

const encoder = new TextEncoder()

const toBytes = (data: string | Uint8Array | ArrayBuffer): Uint8Array => {
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}

/** The subset of Node's streaming Hash used by the Worker host. */
export interface Hash {
  update(data: string | Uint8Array | ArrayBuffer, encoding?: string): Hash
  /** @returns An independent copy of the current digest state. */
  copy(): Hash
  digest(): Buffer
  digest(encoding: 'hex' | 'base64'): string
}

function wrapHash(state: DigestState): Hash {
  let finalized = false
  const assertActive = () => {
    if (finalized) throw Object.assign(new Error('Digest already called'), { code: 'ERR_CRYPTO_HASH_FINALIZED' })
  }

  function digest(): Buffer
  function digest(encoding: 'hex' | 'base64'): string
  function digest(encoding?: 'hex' | 'base64'): Buffer | string {
    assertActive()
    const bytes = Buffer.from(state.digest())
    finalized = true
    return encoding === undefined ? bytes : bytes.toString(encoding)
  }

  const hash: Hash = {
    update(data) {
      assertActive()
      state.update(toBytes(data))
      return hash
    },
    copy() {
      assertActive()
      return wrapHash(state.clone())
    },
    digest,
  }
  return hash
}

/**
 * Create a synchronous hash object.
 * @param algorithm - digest name; only the algorithms the host tree uses exist.
 * @returns the streaming hash face.
 */
export function createHash(algorithm: string): Hash {
  const hasher = HASHERS.get(algorithm.toLowerCase().replace('-', ''))
  if (hasher === undefined) {
    throw new Error(`web-preview: node:crypto.createHash("${algorithm}") is not available in the worker host`)
  }
  return wrapHash(hasher())
}

/**
 * Random bytes.
 * @param size - byte count.
 * @returns a Buffer of cryptographically strong random bytes.
 */
export function randomBytes(size: number): Buffer<ArrayBuffer> {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return Buffer.from(bytes)
}

/**
 * Random v4 UUID. Delegated to the repository's own mint rather than to
 * `crypto.randomUUID`, which browsers expose only in secure contexts — a
 * preview served over plain HTTP on a LAN address has no `randomUUID`.
 * @returns the UUID string.
 */
export function randomUUID(): import('node:crypto').UUID {
  return mintUUID()
}

/**
 * Fill a typed array with random bytes.
 * @param target - the array to fill.
 * @returns the same array.
 */
export function getRandomValues<T extends ArrayBufferView<ArrayBuffer>>(target: T): T {
  return globalThis.crypto.getRandomValues(target)
}

/**
 * Random integer in `[0, max)`.
 * @param max - exclusive upper bound.
 * @returns the integer.
 */
export function randomInt(max: number): number {
  const sample = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
  return Math.floor((sample / 2 ** 32) * max)
}

/** WebCrypto instance, as Node exposes it. */
export const webcrypto = globalThis.crypto

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:crypto` declarations this module stands in for. Three members keep
 * this module's own types: Node declares `createHash` as returning a Transform
 * stream, while this Hash is the synchronous update/digest pair the host tree
 * calls; `webcrypto` is the browser `Crypto` object, whose `subtle` face is
 * declared by the DOM library rather than by Node; and `getRandomValues` accepts
 * only a typed-array view, the values WebCrypto can fill, where Node's
 * declaration also admits a bare `ArrayBuffer`.
 */
type NodeFace = Partial<Omit<typeof import('node:crypto'), 'createHash' | 'getRandomValues' | 'webcrypto'>>
  & Record<'createHash' | 'getRandomValues' | 'webcrypto', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createHash, randomBytes, randomUUID, getRandomValues, randomInt, webcrypto,
} satisfies NodeFace
