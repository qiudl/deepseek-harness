/** Host-only, read-only RPC seam for the remote Web DSH transport. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

const READ_ENDPOINTS = new Set(['session/list', 'session/page', 'session/modelCatalog'])

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
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  if (req.method !== 'POST' || !/^[A-Za-z0-9_-]{43}$/u.test(token)
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(403).end(); return
  }
  const controller = new AbortController()
  res.once('close', () => controller.abort())
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) throw new Error('invalid body')
      size += chunk.byteLength
      if (size > 64 * 1024) throw new Error('body too large')
      chunks.push(Buffer.from(chunk))
    }
    const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!record(request) || Object.keys(request).length !== 2
      || typeof request.endpoint !== 'string' || !Object.hasOwn(request, 'payload')) {
      throw new Error('invalid request')
    }
    const value = await execute(request.endpoint, request.payload, controller.signal)
    const body = JSON.stringify({ value })
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('result too large')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
  } catch {
    if (!res.writableEnded && !res.destroyed) res.writeHead(422, { 'cache-control': 'no-store' }).end()
  }
}
