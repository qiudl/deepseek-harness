/** Project scope calls over the authenticated Slark parent port; execution is advertised separately. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const schema = 'dsh-remote-collaboration/v1'
const encoder = new TextEncoder()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const version = /^(0|[1-9][0-9]{0,18})$/u

function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return row(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= max &&
    !/[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
}
function scope(value: unknown, workspace: string): boolean {
  return exact(value, ['workspace_id', 'version', 'selected_project_ids']) && value.workspace_id === workspace &&
    typeof value.version === 'string' && version.test(value.version) && BigInt(value.version) <= 9223372036854775807n &&
    Array.isArray(value.selected_project_ids) && value.selected_project_ids.length <= 50 &&
    value.selected_project_ids.every(id => text(id, 256)) &&
    new Set(value.selected_project_ids).size === value.selected_project_ids.length
}
function workspaceValue(value: unknown, input: Record<string, unknown>): boolean {
  const operation = input.operation
  if (!row(operation) || typeof input.workspace_id !== 'string') return false
  if (operation.kind === 'get' || operation.kind === 'apply') return scope(value, input.workspace_id)
  if (operation.kind !== 'projects' && operation.kind !== 'agents') return false
  const agents = operation.kind === 'agents'
  if (!exact(value, agents ? ['items', 'next_cursor', 'scope_version'] : ['items', 'next_cursor']) ||
    !Array.isArray(value.items) || !row(operation.query) || typeof operation.query.limit !== 'number' ||
    value.items.length > operation.query.limit ||
    !(value.next_cursor === null || text(value.next_cursor, 2048)) ||
    (agents && !(typeof value.scope_version === 'string' && version.test(value.scope_version) &&
      BigInt(value.scope_version) <= 9223372036854775807n))) return false
  return value.items.every(item => exact(item, agents ?
    ['project_id', 'project_name', 'agent_id', 'agent_name', 'available', 'capability_snapshot', 'reason_code'] :
    ['project_id', 'project_name']) && text(item.project_id, 256) && text(item.project_name, 512) &&
    (!agents || (text(item.agent_id, 256) && text(item.agent_name, 512) && typeof item.available === 'boolean' &&
      text(item.reason_code, 128) && (!item.available || item.reason_code === 'ready') &&
      typeof item.capability_snapshot === 'string' && /^[a-f0-9]{64}$/u.test(item.capability_snapshot))))
}
function result(value: unknown, input: Record<string, unknown>): boolean {
  if (!row(value)) return false
  if (value.ok === true) return exact(value, ['ok', 'value']) && workspaceValue(value.value, input)
  return value.ok === false && Object.keys(value).every(key => ['ok', 'errorCode', 'refreshRequired', 'currentScope'].includes(key)) &&
    text(value.errorCode, 128) && typeof value.refreshRequired === 'boolean' &&
    (value.currentScope === undefined || (typeof input.workspace_id === 'string' && scope(value.currentScope, input.workspace_id)))
}
function capture(value: unknown): Record<string, unknown> {
  const bytes = JSON.stringify(value)
  if (encoder.encode(bytes).length > 32 * 1024) throw Error('remote collaboration request too large')
  const input: unknown = JSON.parse(bytes)
  if (!exact(input, ['workspace_id', 'session_id', 'operation']) || typeof input.workspace_id !== 'string' ||
    !uuid.test(input.workspace_id) || !text(input.session_id, 256) ||
    !row(input.operation)) throw Error('remote collaboration request is invalid')
  const op = input.operation
  if (op.kind === 'get' && exact(op, ['kind'])) return input
  if (op.kind === 'apply' && exact(op, ['kind', 'expected_version', 'selected_project_ids']) &&
    typeof op.expected_version === 'string' && version.test(op.expected_version) &&
    BigInt(op.expected_version) <= 9223372036854775807n &&
    Array.isArray(op.selected_project_ids) && op.selected_project_ids.length <= 50 &&
    op.selected_project_ids.every(id => text(id, 256)) &&
    new Set(op.selected_project_ids).size === op.selected_project_ids.length) return input
  if ((op.kind === 'agents' || op.kind === 'projects') && exact(op, ['kind', 'query']) && row(op.query) &&
    Object.keys(op.query).every(key => ['limit', 'query', 'cursor'].includes(key)) &&
    typeof op.query.limit === 'number' && Number.isInteger(op.query.limit) && op.query.limit >= 1 && op.query.limit <= 20 &&
    (op.query.query === undefined || op.query.query === '' || text(op.query.query, 128)) &&
    (op.query.cursor === undefined || text(op.query.cursor, 2048))) return input
  throw Error('remote collaboration operation is invalid')
}
function reasonError(reason: unknown): Error {
  return reason instanceof Error ? reason : Error('remote collaboration operation failed', { cause: reason })
}
function wait<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(reasonError(signal.reason)); return }
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(reasonError(signal.reason)) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(reasonError(error)) })
  })
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > 256 * 1024) {
    void response.body?.cancel().catch(() => undefined)
    throw Error('remote collaboration response too large')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await wait(signal, reader.read())
      signal.throwIfAborted()
      if (next.done) break
      bytes += next.value.length
      if (bytes > 256 * 1024) throw Error('remote collaboration response too large')
      chunks.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } finally { void reader.cancel().catch(() => undefined) }
}
async function exchange(fetch: TunnelFetch, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  const pending = fetch(path, { ...init, signal })
  void pending.then((response) => { if (signal.aborted) void response.body?.cancel().catch(() => undefined) }, () => undefined)
  const response = await wait(signal, pending)
  signal.throwIfAborted()
  return response
}

/**
 * Negotiate scope support before applying Client plugins. Old parents leave the bridge absent.
 * @param fetch - Unary transport using only the authenticated parent port.
 * @returns Completion after the supported bridge is installed or capability discovery is refused.
 */
export async function installRemoteCollaboration(fetch: TunnelFetch): Promise<void> {
  const lifetime = new AbortController()
  let installed: object | undefined
  const onHide = (): void => {
    lifetime.abort()
    if (installed !== undefined && Reflect.get(window, '__DSH_DESKTOP_HOST__') === installed) {
      Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
    }
  }
  window.addEventListener('pagehide', onHide, { once: true })
  try {
    const discovery = new AbortController()
    const discoveryTimer = setTimeout(() => { discovery.abort() }, 5_000)
    const discoverySignal = AbortSignal.any([discovery.signal, lifetime.signal])
    let advertised: unknown
    try {
      const response = await exchange(fetch, '/__collaboration__', { method: 'GET' }, discoverySignal)
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); return }
      advertised = await readJson(response, discoverySignal)
    } catch (_error) {
      // A missing or unusable capability response does not prevent ordinary remote chat.
      return
    } finally { clearTimeout(discoveryTimer) }
    lifetime.signal.throwIfAborted()
    if (!exact(advertised, ['schema', 'methods']) || advertised.schema !== schema ||
      !Array.isArray(advertised.methods) || advertised.methods.length !== 1 || advertised.methods[0] !== 'workspace') return
    if (Reflect.get(window, '__DSH_DESKTOP_HOST__') !== undefined) throw Error('remote web: Host bridge already installed')
    let sequence = 0
    const bridge = {
      collaborationScopeAvailable: true,
      collaborationExecutionAvailable: false,
      async collaborationWorkspace(raw: unknown): Promise<unknown> {
        let input: Record<string, unknown> | undefined
        let sent = false
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 30_000)
        const signal = AbortSignal.any([controller.signal, lifetime.signal])
        try {
          input = capture(raw)
          signal.throwIfAborted()
          const rpcId = 'workspace-' + String(++sequence)
          sent = true
          const response = await exchange(fetch, '/api/collaboration/workspace', { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method: 'collaboration/workspace', payload: { args: { request: input } } }),
          }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error('remote collaboration refused') }
          const value = await readJson(response, signal)
          signal.throwIfAborted()
          if (!exact(value, ['type', 'rpcId', 'result']) || value.type !== 'server-response' || value.rpcId !== rpcId ||
            !exact(value.result, ['ok', 'value']) || value.result.ok !== true || !result(value.result.value, input)) {
            throw Error('remote collaboration response is invalid')
          }
          return value.result.value
        } catch (_error) {
          return { ok: false, errorCode: 'collaboration_scope_unavailable',
            refreshRequired: sent && row(input?.operation) && input.operation.kind === 'apply' }
        } finally { clearTimeout(timer) }
      },
    }
    Reflect.set(window, '__DSH_DESKTOP_HOST__', bridge)
    installed = bridge
  } finally {
    if (installed === undefined) window.removeEventListener('pagehide', onHide)
  }
}
