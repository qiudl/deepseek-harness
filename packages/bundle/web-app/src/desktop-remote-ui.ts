/** Host-only, read-only RPC seam for the remote Web DSH transport. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { parseHostCollaborationSourceDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import { isDesktopBearerRequest } from './desktop-model.ts'
import { readDesktopRemotePrivateBody } from './desktop-remote-private-request.ts'

const READ_ENDPOINTS = new Set(['session/list', 'session/page', 'session/modelCatalog', 'session/collaborationSources',
  'settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
  'credentials/describe', 'permissionPresets/catalog'])
const STARTUP_ZERO_ARG = new Set(['settings/describe', 'agentPresets/list',
  'dynamicCordisRunner/inventory', 'permissionPresets/catalog'])
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Invoke bounded Session reads and collect the current Profile's Web boot rows. */
export class DesktopRemoteUiExecutor {
  constructor(private readonly gateway: TypertGateway,
    private readonly bootInjections: () => IndexInjection[]) {}

  /**
   * Dispatch an exact endpoint after validating the carrier payload.
   * @param endpoint - Canonical Remote endpoint.
   * @param payload - Decoded carrier payload with named arguments.
   * @param signal - Cancellation for this invocation.
   * @returns The current startup rows or a result from the existing Profile gateway.
   */
  async execute(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (endpoint !== 'boot/injections' && !READ_ENDPOINTS.has(endpoint)) {
      throw new Error('desktop remote UI: endpoint denied')
    }
    if (!record(payload) || Object.keys(payload).length !== 1 || !record(payload.args)) {
      throw new Error('desktop remote UI: invalid payload')
    }
    if (endpoint === 'boot/injections') {
      if (Object.keys(payload.args).length !== 0) throw new Error('desktop remote UI: invalid payload')
      return { injections: this.bootInjections() }
    }
    if (STARTUP_ZERO_ARG.has(endpoint) && Object.keys(payload.args).length !== 0) {
      throw new Error('desktop remote UI: invalid payload')
    }
    if (endpoint === 'session/collaborationSources') {
      const request = payload.args.request
      if (Object.keys(payload.args).length !== 1 || !record(request)
        || Object.keys(request).some(key => key !== 'sessionId' && key !== 'cursor' && key !== 'snapshotDigest' && key !== 'includeTimeline')
        || typeof request.sessionId !== 'string' || !/^[!-~]{1,256}$/u.test(request.sessionId)
        || /[/\\]/u.test(request.sessionId) || request.sessionId === '.' || request.sessionId === '..'
        || (request.cursor !== undefined && (typeof request.cursor !== 'string' || !/^[0-9a-f]{64}$/u.test(request.cursor)))
        || (request.snapshotDigest !== undefined
          && (typeof request.snapshotDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(request.snapshotDigest)))
        || (Object.hasOwn(request, 'cursor') && Object.hasOwn(request, 'snapshotDigest'))
        || (Object.hasOwn(request, 'includeTimeline') && request.includeTimeline !== true)) {
        throw new Error('desktop remote UI: invalid payload')
      }
      const page: unknown = await this.gateway.invoke({ namespace: 'session', method: 'collaborationSources', args: payload.args, signal })
      if (!record(page) || !Array.isArray(page.items) || page.items.length > 8
        || Object.keys(page).some(key => key !== 'items' && key !== 'next_cursor')
        || (page.next_cursor !== undefined && (typeof page.next_cursor !== 'string' || !/^[0-9a-f]{64}$/u.test(page.next_cursor)))) {
        throw new Error('desktop remote UI: invalid Source page')
      }
      if (request.snapshotDigest !== undefined && (page.items.length !== 1 || page.next_cursor !== undefined)) {
        throw new Error('desktop remote UI: invalid Source page')
      }
      if (!page.items.length) {
        if (page.next_cursor !== undefined) throw new Error('desktop remote UI: invalid Source page')
        return { items: [] }
      }
      const first: unknown = page.items[0]
      const itemKeys = request.includeTimeline ? 'original_message,snapshot_digest,source,timeline_position'
        : 'original_message,snapshot_digest,source'
      if (!record(first) || Object.keys(first).sort().join(',') !== itemKeys
        || typeof first.snapshot_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(first.snapshot_digest)
        || (request.snapshotDigest !== undefined && first.snapshot_digest !== request.snapshotDigest)
        || !record(first.source) || Object.keys(first.source).sort().join(',') !== 'session_id,source_message_id,source_revision,workspace_id'
        || first.source.session_id !== request.sessionId || typeof first.original_message !== 'string'
        || Buffer.from(first.original_message, 'utf8').toString('utf8') !== first.original_message) {
        throw new Error('desktop remote UI: invalid Source page')
      }
      if (request.includeTimeline && first.timeline_position !== null) {
        const position = first.timeline_position
        if (!record(position) || Object.keys(position).sort().join(',') !== 'after_sequence,local_order'
          || (position.after_sequence !== null && (typeof position.after_sequence !== 'number'
            || !Number.isSafeInteger(position.after_sequence) || position.after_sequence < 0))
          || typeof position.local_order !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(position.local_order)
          || BigInt(position.local_order) > 9223372036854775807n) throw new Error('desktop remote UI: invalid Source page')
      }
      parseHostCollaborationSourceDescriptor({ ...first.source, snapshot_digest: first.snapshot_digest })
      // Remote control reads use a 64 KiB frame; the immutable digest pages complete originals individually.
      const result = { items: [first],
        ...(page.items.length > 1 || page.next_cursor !== undefined ? { next_cursor: first.snapshot_digest } : {}) }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 60 * 1024) throw new Error('desktop remote UI: result too large')
      return result
    }
    if (endpoint === 'credentials/describe' &&
      (Object.keys(payload.args).length !== 1 || !Array.isArray(payload.args.refs) ||
        payload.args.refs.length > 64 ||
        !payload.args.refs.every(ref => typeof ref === 'string' && CREDENTIAL_REF.test(ref)))) {
      throw new Error('desktop remote UI: invalid payload')
    }
    const [namespace, method] = endpoint.split('/') as [string, string]
    return this.gateway.invoke({ namespace, method, args: payload.args, signal })
  }
}

/**
 * Handle a bounded, token-authenticated RPC request; browser cookies have no authority here.
 * @param req - Incoming HTTP request.
 * @param res - HTTP response to settle.
 * @param token - Profile worker's private bearer token.
 * @param execute - Exact-endpoint executor in the composed Profile.
 */
export async function handleDesktopRemoteUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  execute: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  await handleDesktopRemoteJsonRequest(req, res, token, async (request, signal) => {
    if (!record(request) || Object.keys(request).length !== 2
      || typeof request.endpoint !== 'string' || !Object.hasOwn(request, 'payload')) {
      throw new Error('invalid request')
    }
    return execute(request.endpoint, request.payload, signal)
  })
}

/**
 * Handle a bounded bearer-authenticated JSON request shared by the Host RPC routes.
 * @param req - Incoming HTTP request.
 * @param res - HTTP response to settle.
 * @param token - Private Profile bearer token.
 * @param execute - Route-specific validation and execution.
 * @returns Completion of the bounded response, including rejection responses.
 */
export async function handleDesktopRemoteJsonRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  execute: (request: unknown, signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  if (!isDesktopBearerRequest(req, token)) {
    res.writeHead(403).end(); return
  }
  const controller = new AbortController()
  res.once('close', () => { controller.abort() })
  try {
    const request = await readDesktopRemotePrivateBody(req)
    const value = await execute(request, controller.signal)
    const body = JSON.stringify({ value })
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('result too large')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
  } catch {
    if (!res.writableEnded && !res.destroyed) res.writeHead(422, { 'cache-control': 'no-store' }).end()
  }
}
