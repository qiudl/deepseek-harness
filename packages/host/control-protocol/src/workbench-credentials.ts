/** One-way secret changes for the already selected personal Profile. */
export type WorkbenchCredentialWrite =
  | { readonly method: 'set'; readonly args: { readonly ref: string; readonly value: string } }
  | { readonly method: 'unset'; readonly args: { readonly ref: string } }

/**
 * Admit exact set/unset operations; no secret read or caller-selected storage is exposed.
 * @param input Decrypted bounded credential intent.
 * @returns A detached request or undefined for any unexpected field.
 */
export function parseWorkbenchCredentialWrite(input: unknown): WorkbenchCredentialWrite | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'args,method' || !value.args
    || typeof value.args !== 'object' || Array.isArray(value.args)) return undefined
  const args = value.args as Record<string, unknown>
  if (typeof args.ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(args.ref)) return undefined
  if (value.method === 'unset' && Object.keys(args).join(',') === 'ref') return { method: 'unset', args: { ref: args.ref } }
  if (value.method !== 'set' || Object.keys(args).sort().join(',') !== 'ref,value'
    || typeof args.value !== 'string' || !args.value || new TextEncoder().encode(args.value).length > 16 * 1024) return undefined
  return { method: 'set', args: { ref: args.ref, value: args.value } }
}
