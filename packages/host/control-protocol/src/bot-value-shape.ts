/** Accept only a non-null, non-array record.
 * @param value - Parsed untrusted Bot value.
 * @returns Whether the value is a plain record.
 */
export function botRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Check that a parsed Bot value has exactly the expected own keys.
 * @param value - Parsed Bot record.
 * @param keys - Allowed own key names.
 * @returns Whether the record contains precisely those keys.
 */
export function botExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
