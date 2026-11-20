/** Closed persisted-row validation and published-manifest retention shared by source-format owners. */
import { createHash } from 'node:crypto'
import { hostProjectMemorySourceProofDigest } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostProjectMemorySourceProof } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

type Store = Readonly<{
  get(kind: 'published', key: string): unknown
  put(
    kind: 'published',
    key: string,
    value: unknown,
    reservation: { rows: number; bytes: number; expiresAt: number },
    guard: () => void,
  ): void
  removeTransient(kind: 'published', selector: { expiredAt: number }, guard: () => void): void
}>
type Manifest = Readonly<{ proof: HostProjectMemorySourceProof }>

/** @returns Whether two JSON-domain values encode identically. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** @returns Never; throws the closed unavailable authority error. */
export const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}
/** @returns Never; throws the closed idempotency-conflict authority error. */
export const conflict = (): never => {
  throw new HostAuthorityError('idempotency_conflict')
}
/** @returns The order-independent source revision digest of the given Events or dispositions. */
export const revisionsDigest = (items: readonly { sourceEventId: string; sourceRevision: string }[]): string =>
  createHash('sha256')
    .update(
      'dsh.project-operation-memory-source-revisions/v1\0' +
        JSON.stringify(items.map(e => JSON.stringify([e.sourceEventId, e.sourceRevision])).sort()),
    )
    .digest('hex')
/** Accept only a plain object with exactly the given own keys.
 * @param value - Untrusted persisted value.
 * @param keys - Exact closed key set.
 * @returns The same object for field validation.
 */
export function row(value: unknown, keys: readonly string[]): { [key: string]: unknown } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    return fail()
  return value as { [key: string]: unknown }
}
/** @returns The value when it is a bounded printable ASCII reference. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/u.test(value)) return fail()
  return value
}

/** Retain one parsed signed page manifest; one proof can never acquire different page metadata.
 * @param database - The owning store of this manifest format.
 * @param key - Original signed proof identity of `next`.
 * @param next - Exact parsed manifest to retain until its proof expiry.
 * @param now - Current publication clock; expired manifests are removed first.
 * @param guard - Current Account/peer/deadline fence.
 * @param read - This format's verified reader of an already retained manifest.
 * @param recordBytes - The owning store's logical record-byte charge.
 * @returns Nothing; a different retained manifest is an idempotency conflict.
 */
export function retainPublished<P extends Manifest>(
  database: Store,
  key: string,
  next: P,
  now: number,
  guard: () => void,
  read: (proofDigest: string) => P | null,
  recordBytes: (kind: 'published', key: string, value: unknown) => number,
): void {
  database.removeTransient('published', { expiredAt: now }, guard)
  const old = read(key)
  if (old && !same(old, next)) return conflict()
  database.put(
    'published',
    key,
    next,
    { rows: 1, bytes: recordBytes('published', key, next), expiresAt: next.proof.expiresAt },
    guard,
  )
}
/** Read only the exact original retained page manifest under its proof identity.
 * @param database - The owning store of this manifest format.
 * @param proofDigest - Original signed proof identity.
 * @param parse - This format's closed manifest parser.
 * @returns The original manifest, or absence.
 */
export function readPublished<P extends Manifest>(
  database: Pick<Store, 'get'>,
  proofDigest: string,
  parse: (value: unknown) => P,
): P | null {
  const value = database.get('published', proofDigest)
  if (value === null) return null
  const result = parse(value)
  if (hostProjectMemorySourceProofDigest(result.proof) !== proofDigest) return fail()
  return result
}
