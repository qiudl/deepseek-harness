/** Internal strict values shared only by the twin-binding wire contracts. */
const fail = (): never => { throw Error('invalid_twin_binding_offer') }
/**
 * Read an exact plain data object without invoking accessors.
 * @param value - Untrusted object.
 * @param keys - Complete allowed enumerable field names.
 * @returns Detached own data fields.
 */
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.fromEntries(keys.map((key) => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return fail()
    const value: unknown = descriptor.value
    return [key, value]
  }))
}
/**
 * Validate a well-formed string against its protocol pattern.
 * @param value - Untrusted string.
 * @param pattern - Required protocol syntax.
 * @returns Validated string.
 */
export function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !pattern.test(value)) return fail()
  return value
}
/**
 * Validate a canonical lowercase UUID.
 * @param value - Untrusted identifier.
 * @returns Canonical UUID string.
 */
export const uuid = (value: unknown): string => text(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
/**
 * Validate a lowercase SHA-256 digest.
 * @param value - Untrusted digest.
 * @returns Canonical hexadecimal digest.
 */
export const digest = (value: unknown): string => text(value, /^[0-9a-f]{64}$/u)
/**
 * Validate a bounded ASCII identifier without path components.
 * @param value - Untrusted identifier.
 * @returns Validated opaque identifier.
 */
export function id(value: unknown): string {
  const parsed = text(value, /^[!-~]{1,256}$/u)
  if (/[/\\]/u.test(parsed) || parsed === '.' || parsed === '..') return fail()
  return parsed
}
/**
 * Validate a positive decimal version within PostgreSQL BIGINT.
 * @param value - Untrusted version.
 * @returns Canonical positive decimal string.
 */
export function version(value: unknown): string {
  const parsed = text(value, /^[1-9][0-9]{0,18}$/u)
  if (BigInt(parsed) > 9223372036854775807n) return fail()
  return parsed
}
/**
 * Validate a nonnegative safe integer millisecond timestamp.
 * @param value - Untrusted timestamp.
 * @returns Validated millisecond timestamp.
 */
export function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail()
  return value
}
/**
 * Parse a bounded dense array without invoking item accessors.
 * @param value - Untrusted array.
 * @param maximum - Maximum number of items.
 * @param parse - Boundary parser for each own data item.
 * @returns Detached parsed items.
 */
export function array<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[String(index)]
    if (!item?.enumerable || !Object.hasOwn(item, 'value')) return fail()
    return parse(item.value)
  })
}
/**
 * Require strict ascending keys, rejecting duplicates.
 * @param value - Parsed items in wire order.
 * @param key - Canonical comparison key.
 * @returns The validated ordered items.
 */
export function sorted<T>(value: T[], key: (item: T) => string): T[] {
  let previous: string | undefined
  for (const item of value) {
    const next = key(item)
    if (previous !== undefined && previous >= next) return fail()
    previous = next
  }
  return value
}
