/** Project scope calls over the authenticated Slark parent port; execution is advertised separately. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { exchange, readJson } from './remote-response.ts'
import { createRemoteCollaborationExecution } from './remote-collaboration-execution.ts'

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
    if (!exact(advertised, ['schema', 'methods']) || advertised.schema !== schema || !Array.isArray(advertised.methods)) return
    const methods: readonly unknown[] = advertised.methods
    const conversations = methods.includes('conversations')
    const archive = methods.includes('archive')
    const execution = ['workspace', 'submit', 'pending', 'deliveries'].every(method => methods.includes(method))
    if (!methods.includes('workspace') || methods.length !== (execution ? 4 : 1) + (conversations ? 1 : 0) + (archive ? 1 : 0)
      || methods.some(method => !['workspace', 'submit', 'pending', 'deliveries', 'conversations', 'archive'].includes(String(method)))) return
    if (Reflect.get(window, '__DSH_DESKTOP_HOST__') !== undefined) throw Error('remote web: Host bridge already installed')
    let sequence = 0
    const bridge = {
      async accountIdentity(): Promise<{ name: string; avatarUrl: string | null } | null> {
        const controller = new AbortController()
        const timer = setTimeout(() => { controller.abort() }, 10_000)
        const signal = AbortSignal.any([controller.signal, lifetime.signal])
        try {
          const response = await exchange(fetch, '/__account__', { method: 'GET' }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); return null }
          const value = await readJson(response, signal, 800 * 1024)
          if (!exact(value, ['name', 'avatarUrl']) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512
            || value.avatarUrl !== null && (typeof value.avatarUrl !== 'string'
              || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u.test(value.avatarUrl))) return null
          return { name: value.name, avatarUrl: value.avatarUrl }
        } finally { clearTimeout(timer) }
      },
      collaborationScopeAvailable: true,
      collaborationExecutionAvailable: execution,
      ...((execution || conversations || archive) ? (() => {
        const call = async (method: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
          const rpcId = 'collaboration-' + String(++sequence)
          const response = await exchange(fetch, '/api/' + method, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
              rpcId, method, payload: { args: { request: input } } }) }, signal)
          if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error('remote collaboration refused') }
          const value = await readJson(response, signal, 800 * 1024)
          signal.throwIfAborted()
          if (!exact(value, ['type', 'rpcId', 'result']) || value.type !== 'server-response' || value.rpcId !== rpcId
            || !exact(value.result, ['ok', 'value']) || value.result.ok !== true) throw Error('invalid collaboration response')
          return value.result.value
        }
        const methods = createRemoteCollaborationExecution({ signal: lifetime.signal, call })
        return { ...(execution ? { collaborationSubmit: methods.collaborationSubmit,
          collaborationPending: methods.collaborationPending, collaborationDeliveries: methods.collaborationDeliveries } : {}),
        ...(conversations ? { collaborationConversations: methods.collaborationConversations } : {}),
        ...(archive ? { collaborationArchive: async (raw: unknown) => {
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, 60_000)
          const signal = AbortSignal.any([controller.signal, lifetime.signal])
          try {
            const input = exact(raw, ['workspace_id', 'session_id', 'action']) ? raw : undefined
            if (!input || typeof input.workspace_id !== 'string' || !uuid.test(input.workspace_id)
                || typeof input.session_id !== 'string' || !/^[!-~]{1,256}$/u.test(input.session_id)
                || /[/\\]/u.test(input.session_id) || input.session_id === '.' || input.session_id === '..'
                || (input.action !== 'archive' && input.action !== 'restore'))
              throw Error('invalid archive action')
            const result = await call('collaboration/archive', input, signal)
            if (!exact(result, ['state']) || !['archived', 'restored', 'retry_required', 'conflict'].includes(String(result.state)))
              throw Error('invalid archive result')
            return result
          } catch { return { state: 'retry_required' as const } }
          finally { clearTimeout(timer) }
        } } : {}) }
      })() : {}),
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
