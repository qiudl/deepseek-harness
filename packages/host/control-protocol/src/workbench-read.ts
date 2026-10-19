/** Fixed read-only file RPCs carried by an authorized Profile stream. */
export type WorkbenchReadEndpoint = 'workspaceFiles/read' | 'workspaceFiles/readBytes' | 'workspaceFiles/stat' | 'workspaceFiles/list'
/** Exact HTTP RPC identity and arguments; never includes an origin or authority selector. */
export interface WorkbenchReadPayload {
  readonly args: {
    readonly endpoint: WorkbenchReadEndpoint
    readonly rpcId: string
    readonly args: {
      readonly workspaceFileScopeId: string
      readonly path: string
      readonly range?: { readonly offset?: number; readonly limit?: number }
      readonly options?: { readonly baseFile?: string; readonly range?: { readonly offset?: number; readonly length?: number } }
    }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function path(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).length <= 4096 && !value.includes('\0')
}
function number(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
/**
 * Validate the closed file-read envelope before selecting the existing Gateway endpoint.
 * @param input Untrusted decrypted stream payload.
 * @returns A canonical request, or undefined for any unrecognized field or invalid range.
 */
export function parseWorkbenchReadPayload(input: unknown): WorkbenchReadPayload | undefined {
  if (!record(input) || !keys(input, ['args']) || !record(input.args)) return undefined
  const request = input.args
  if (!keys(request, ['endpoint', 'rpcId', 'args']) || typeof request.rpcId !== 'string'
    || !/^[!-~]{1,128}$/u.test(request.rpcId) || !record(request.args)) return undefined
  const endpoint = request.endpoint
  if (endpoint !== 'workspaceFiles/read' && endpoint !== 'workspaceFiles/readBytes'
    && endpoint !== 'workspaceFiles/stat' && endpoint !== 'workspaceFiles/list') return undefined
  const args = request.args
  const fields = ['workspaceFileScopeId', 'path', ...(endpoint === 'workspaceFiles/read' ? ['range']
    : endpoint === 'workspaceFiles/readBytes' ? ['options'] : [])]
  if (!keys(args, fields) || typeof args.workspaceFileScopeId !== 'string'
    || !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u.test(args.workspaceFileScopeId) || !path(args.path)) return undefined
  const base = { workspaceFileScopeId: args.workspaceFileScopeId, path: args.path }
  if (endpoint === 'workspaceFiles/read') {
    if (!record(args.range) || !keys(args.range, [], ['offset', 'limit'])
      || (Object.hasOwn(args.range, 'offset') && !number(args.range.offset, 1))
      || (Object.hasOwn(args.range, 'limit') && !number(args.range.limit, 1))) return undefined
    return { args: { endpoint, rpcId: request.rpcId, args: { ...base, range: {
      ...(typeof args.range.offset === 'number' ? { offset: args.range.offset } : {}),
      ...(typeof args.range.limit === 'number' ? { limit: args.range.limit } : {}),
    } } } }
  }
  if (endpoint === 'workspaceFiles/readBytes') {
    const options = args.options
    if (!record(options) || !keys(options, [], ['baseFile', 'range'])
      || (Object.hasOwn(options, 'baseFile') && !path(options.baseFile))) return undefined
    const range = options.range
    if (Object.hasOwn(options, 'range') && (!record(range) || !keys(range, [], ['offset', 'length'])
      || (Object.hasOwn(range, 'offset') && !number(range.offset, 0))
      || (Object.hasOwn(range, 'length') && !number(range.length, 1)))) return undefined
    return { args: { endpoint, rpcId: request.rpcId, args: { ...base, options: {
      ...(typeof options.baseFile === 'string' ? { baseFile: options.baseFile } : {}),
      ...(record(range) ? { range: {
        ...(typeof range.offset === 'number' ? { offset: range.offset } : {}),
        ...(typeof range.length === 'number' ? { length: range.length } : {}),
      } } : {}),
    } } } }
  }
  return { args: { endpoint, rpcId: request.rpcId, args: base } }
}

/** Exact workspace file observation arguments; the Gateway resolves the scope. */
export interface WorkbenchChangesPayload {
  readonly args: { readonly workspaceFileScopeId: string; readonly path: string }
}
/**
 * Admit a read-only file observation without accepting authority selectors.
 * @param input Decrypted stream arguments.
 * @returns Canonical watch coordinates or undefined.
 */
export function parseWorkbenchChangesPayload(input: unknown): WorkbenchChangesPayload | undefined {
  if (!record(input) || !keys(input, ['args'])) return undefined
  const parsed = parseWorkbenchReadPayload({ args: { endpoint: 'workspaceFiles/stat', rpcId: 'watch', args: input.args } })
  if (!parsed) return undefined
  return { args: { workspaceFileScopeId: parsed.args.args.workspaceFileScopeId, path: parsed.args.args.path } }
}
