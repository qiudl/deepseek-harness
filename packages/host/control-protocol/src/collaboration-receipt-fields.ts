/** Shared exact-field grammar and canonical JSON for the two Session receipt domains. */
export function exactReceiptFields(value: unknown, keys: readonly string[], reason: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw Error(reason)
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).length !== keys.length ||
    keys.some((k) => {
      const field = fields[k]
      return !field?.enumerable || !('value' in field)
    })
  )
    throw Error(reason)
  return Object.fromEntries(keys.map(k => [k, fields[k]?.value]))
}

export function canonicalReceiptJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalReceiptJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(row)
        .sort()
        .map(k => JSON.stringify(k) + ':' + canonicalReceiptJson(row[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
