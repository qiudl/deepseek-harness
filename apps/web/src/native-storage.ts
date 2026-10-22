/** Volatile preferences for an opaque native frame. Private persistence belongs to native.
 * @param limit Maximum UTF-8 bytes retained by this frame.
 * @returns An isolated Storage implementation that never writes to browser disk.
 */
export function createNativeMemoryStorage(limit = 2 * 1024 * 1024): Storage {
  const values = new Map<string, string>()
  let bytes = 0
  const size = (key: string, value: string): number => new TextEncoder().encode(key + value).length
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key: unknown) { return values.get(String(key)) ?? null },
    setItem(rawKey: unknown, rawValue: unknown) {
      const key = String(rawKey), value = String(rawValue)
      const previous = values.get(key)
      const next = bytes - (previous === undefined ? 0 : size(key, previous)) + size(key, value)
      if (next > limit) throw new DOMException('Native frame preference capacity exceeded', 'QuotaExceededError')
      values.set(key, value); bytes = next
    },
    removeItem(rawKey: unknown) {
      const key = String(rawKey)
      const previous = values.get(key)
      if (previous !== undefined) { values.delete(key); bytes -= size(key, previous) }
    },
    clear() { values.clear(); bytes = 0 },
  }
}
