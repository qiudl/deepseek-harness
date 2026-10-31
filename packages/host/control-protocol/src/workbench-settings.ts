/** Closed personal Profile settings intents; no transport or authority selectors. */
export type WorkbenchSettingsJson = null | boolean | number | string | WorkbenchSettingsJson[]
  | { [key: string]: WorkbenchSettingsJson }
/** Original settings Gateway arguments, including optimistic revision checks. */
export type WorkbenchSettingsWrite = {
  readonly method: 'update' | 'replace' | 'mutate'
  readonly args: { readonly ns: string } & Record<string, WorkbenchSettingsJson>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function json(value: unknown, depth = 0): value is WorkbenchSettingsJson {
  if (depth > 10) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1))
  if (!record(value)) return false
  return Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && json(item, depth + 1))
}

/**
 * Validate one bounded settings write while retaining the provider's own schema and revision rules.
 * @param input Decrypted intent from the current personal client.
 * @returns A detached, exact Gateway request or undefined.
 */
export function parseWorkbenchSettingsWrite(input: unknown): WorkbenchSettingsWrite | undefined {
  if (!record(input) || !exact(input, ['method', 'args']) || !record(input.args)) return undefined
  const { method, args } = input
  if (method !== 'update' && method !== 'replace' && method !== 'mutate') return undefined
  const field = method === 'update' ? 'patch' : method === 'replace' ? 'section' : 'ops'
  if (!exact(args, ['ns', field], ['expectedRevision']) || typeof args.ns !== 'string'
    || !args.ns || new TextEncoder().encode(args.ns).length > 256 || /[\u0000-\u001f\u007f]/u.test(args.ns)) return undefined
  if (Object.hasOwn(args, 'expectedRevision') && (typeof args.expectedRevision !== 'number'
    || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) return undefined
  if (!json(args)) return undefined
  if (method === 'mutate') {
    if (!Array.isArray(args.ops) || args.ops.length > 256 || !args.ops.every(op => record(op)
      && (op.op === 'set' ? exact(op, ['op', 'path', 'value']) : op.op === 'unset' && exact(op, ['op', 'path']))
      && Array.isArray(op.path) && op.path.length <= 32 && op.path.every(key => typeof key === 'string'
        && key.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(key)))) return undefined
  } else if (!record(args[field])) return undefined
  const encoded = JSON.stringify({ method, args })
  if (new TextEncoder().encode(encoded).length > 32 * 1024) return undefined
  const copied: unknown = JSON.parse(encoded)
  // The bounded JSON copy retains only the validated, detached request.
  return copied as WorkbenchSettingsWrite
}
