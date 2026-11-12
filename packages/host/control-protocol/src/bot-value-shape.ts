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

/** Validate a Bot mutation target ID.
 * @param value - Untrusted target ID.
 * @returns Whether the ID has the supported characters and length.
 */
export const botMutationId = (value: unknown): value is string => typeof value === 'string' &&
  /^[A-Za-z0-9_-]{1,200}$/u.test(value)
/** Validate the Session that authorizes a Bot mutation.
 * @param value - Untrusted Session ID.
 * @returns Whether the ID is bounded and cannot denote a path.
 */
export const botMutationSessionId = (value: unknown): value is string => typeof value === 'string' &&
  /^[!-~]{1,256}$/u.test(value) && !value.includes('/') && !value.includes(String.fromCharCode(92)) &&
  value !== '.' && value !== '..'
/** Validate a durable Bot mutation request ID.
 * @param value - Untrusted request ID.
 * @returns Whether the ID is a UUID.
 */
export const botMutationRequestId = (value: unknown): value is string => typeof value === 'string' &&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)
/** Validate a nonnegative Bot revision.
 * @param value - Untrusted revision.
 * @returns Whether the revision is a safe integer.
 */
export const botMutationRevision = (value: unknown): value is number => typeof value === 'number' &&
  Number.isSafeInteger(value) && value >= 0
