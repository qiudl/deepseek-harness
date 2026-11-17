/** Validation and digest helpers shared by the two source purposes. */
import { createHash } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

/** Compare complete persisted metadata values without accepting partial matches.
 * @param a - First complete value.
 * @param b - Second complete value.
 * @returns Whether their JSON encodings match.
 */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Refuse unavailable source metadata.
 * @returns Never; throws an unavailable error.
 */
export const fail = (): never => {
  throw new HostAuthorityError('unavailable')
}

/** Refuse a repeated identity carrying different metadata.
 * @returns Never; throws an idempotency conflict.
 */
export const conflict = (): never => {
  throw new HostAuthorityError('idempotency_conflict')
}

/** Digest the sorted original source revision coordinates.
 * @param items - Exact source event and revision identities.
 * @returns Domain-separated revision digest.
 */
export const revisionsDigest = (items: readonly { sourceEventId: string; sourceRevision: string }[]): string =>
  createHash('sha256')
    .update(
      'dsh.project-operation-memory-source-revisions/v1\0' +
        JSON.stringify(items.map(e => JSON.stringify([e.sourceEventId, e.sourceRevision])).sort()),
    )
    .digest('hex')

/** Require one plain record with exactly the expected keys.
 * @param value - Stored record to validate.
 * @param keys - Exact allowed keys.
 * @returns The plain record after key validation.
 */
export function row(value: unknown, keys: readonly string[]): { [key: string]: unknown } {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) return fail()
  return value as { [key: string]: unknown }
}

/** Require one bounded printable source identifier.
 * @param value - Stored identifier to validate.
 * @returns Validated identifier.
 */
export function text(value: unknown): string {
  if (typeof value !== 'string' || !/^[!-~]{1,256}$/u.test(value)) return fail()
  return value
}
