/** The memory purpose has a separate bounded envelope; ordinary Session JSON budgets stay unchanged. */
import type { HostRemoteSessionJson } from './types.ts'

const invalid = (): never => {
  throw Error('invalid_project_operation_memory_json')
}
/** Detach only bounded JSON for the private memory/confirmation envelope.
 * @param value - Untrusted JSON; this parser confers no authority and does not replace the closed operation codecs.
 * @returns Detached JSON within 64 KiB, 12 nested levels and 8192 nodes, with own data properties only.
 */
export function parseHostProjectMemoryJson(value: unknown): HostRemoteSessionJson {
  let nodes = 0
  const parse = (input: unknown, depth: number): HostRemoteSessionJson => {
    if (++nodes > 8192 || depth > 12) return invalid()
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return invalid()
      return input
    }
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > 32768) return invalid()
      return input
    }
    if (!input || typeof input !== 'object') return invalid()
    if (Array.isArray(input)) {
      if (
        input.length > 10000 ||
        Object.keys(input).length !== input.length ||
        Object.getOwnPropertySymbols(input).length !== 0
      )
        return invalid()
      return Array.from({ length: input.length }, (_, i) => {
        const item = Object.getOwnPropertyDescriptor(input, i)
        if (!item || !Object.hasOwn(item, 'value')) return invalid()
        return parse(item.value, depth + 1)
      })
    }
    if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length > 256) return invalid()
    const result: { [key: string]: HostRemoteSessionJson } = {}
    for (const key of Reflect.ownKeys(input)) {
      if (
        typeof key !== 'string' ||
        !key ||
        Buffer.byteLength(key) > 128 ||
        /[\u0000-\u001f\u007f]/u.test(key) ||
        ['__proto__', 'prototype', 'constructor'].includes(key)
      )
        return invalid()
      const item = Object.getOwnPropertyDescriptor(input, key)
      if (!item?.enumerable || !Object.hasOwn(item, 'value')) return invalid()
      Object.defineProperty(result, key, { value: parse(item.value, depth + 1), enumerable: true })
    }
    return result
  }
  const result = parse(value, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) return invalid()
  return result
}
