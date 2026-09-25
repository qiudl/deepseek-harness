/** Host-only, read-only RPC seam for the remote Web DSH transport. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { openDesktopRemotePrivateRequest, readDesktopRemotePrivateBody,
  rejectDesktopRemotePrivateRequest, writeDesktopRemotePrivateResult } from './desktop-remote-private-request.ts'

const READ_ENDPOINTS = new Set(['session/list', 'session/page', 'session/modelCatalog',
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
  const controller = openDesktopRemotePrivateRequest(req, res, token)
  if (!controller) return
  try {
    const request = await readDesktopRemotePrivateBody(req)
    if (!record(request) || Object.keys(request).length !== 2
      || typeof request.endpoint !== 'string' || !Object.hasOwn(request, 'payload')) {
      throw new Error('invalid request')
    }
    const value = await execute(request.endpoint, request.payload, controller.signal)
    writeDesktopRemotePrivateResult(res, value)
  } catch {
    rejectDesktopRemotePrivateRequest(res)
  }
}
