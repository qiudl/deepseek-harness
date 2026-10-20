/** Exact terminal calls for one controlled Session; transport authority never comes from args. */
export type WorkbenchTerminalRequest = {
  readonly sessionId: string
  readonly method: 'environment' | 'shells' | 'list' | 'create' | 'write' | 'resize' | 'rename' | 'close' | 'follow' | 'retain'
  readonly args: Record<string, string | number | Record<string, string | number>>
}
function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,128}$/u.test(value)
}
function size(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}
/**
 * Validate the original Gateway args and bind their Session to the enclosing control proof.
 * @param input Decrypted terminal intent with no arbitrary endpoint or authority fields.
 * @returns A detached request, or undefined before any Host operation.
 */
export function parseWorkbenchTerminalRequest(input: unknown): WorkbenchTerminalRequest | undefined {
  if (!row(input) || !exact(input, ['sessionId', 'method', 'args']) || !row(input.args)
    || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u.test(input.sessionId)) return undefined
  const { sessionId, method, args } = input
  if (method === 'list' || method === 'retain') {
    if (!exact(args, method === 'list' ? ['sessionId'] : ['sessionId', 'id']) || args.sessionId !== sessionId
      || (method === 'retain' && !id(args.id))) return undefined
  } else {
    if (args.agentId !== sessionId) return undefined
    switch (method) {
      case 'environment': case 'shells':
        if (!exact(args, ['agentId'])) return undefined
        break
      case 'create': {
        const request = args.request
        if (!exact(args, ['agentId', 'request']) || !row(request)
          || !exact(request, ['id', 'cols', 'rows', ...(Object.hasOwn(request, 'shellPath') ? ['shellPath'] : [])])
          || !id(request.id) || !size(request.cols, 2, 500) || !size(request.rows, 1, 200)) return undefined
        if (Object.hasOwn(request, 'shellPath') && (typeof request.shellPath !== 'string' || !request.shellPath
          || request.shellPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(request.shellPath))) return undefined
        break
      }
      case 'follow':
        if (!exact(args, ['agentId', 'id', 'attachmentId']) || !id(args.id) || !id(args.attachmentId)) return undefined
        break
      case 'write':
        if (!exact(args, ['agentId', 'id', 'attachmentId', 'data']) || !id(args.id) || !id(args.attachmentId)
          || typeof args.data !== 'string' || new TextEncoder().encode(args.data).length > 32 * 1024) return undefined
        break
      case 'resize':
        if (!exact(args, ['agentId', 'id', 'attachmentId', 'cols', 'rows']) || !id(args.id) || !id(args.attachmentId)
          || !size(args.cols, 2, 500) || !size(args.rows, 1, 200)) return undefined
        break
      case 'rename':
        if (!exact(args, ['agentId', 'id', 'title']) || !id(args.id) || typeof args.title !== 'string'
          || !args.title.trim() || args.title.length > 120) return undefined
        break
      case 'close':
        if (!exact(args, ['agentId', 'id']) || !id(args.id)) return undefined
        break
      default: return undefined
    }
  }
  const encoded = JSON.stringify(input)
  if (new TextEncoder().encode(encoded).length > 48 * 1024) return undefined
  return JSON.parse(encoded) as WorkbenchTerminalRequest
}

/** One-use terminal stream handle, never caller-selected Session or Profile args. */
export interface WorkbenchTerminalStreamPayload { readonly args: { readonly grantId: string } }
/**
 * Admit only the exact permit returned by a controlled terminal intent.
 * @param input Stream payload from the current encrypted connection.
 * @returns A detached payload or undefined.
 */
export function parseWorkbenchTerminalStreamPayload(input: unknown): WorkbenchTerminalStreamPayload | undefined {
  if (!row(input) || !exact(input, ['args']) || !row(input.args) || !exact(input.args, ['grantId'])
    || typeof input.args.grantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.args.grantId)) return undefined
  return { args: { grantId: input.args.grantId } }
}
