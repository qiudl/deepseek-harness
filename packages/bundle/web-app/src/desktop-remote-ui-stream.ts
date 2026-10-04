/** Private native read streams from one Profile's Gateway to its Desktop Host worker. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { openDesktopRemotePrivateRequest, readDesktopRemotePrivateBody } from './desktop-remote-private-request.ts'

const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function followPayload(value: unknown): value is { args: Record<string, unknown> } {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.args) ||
    Object.keys(value.args).length !== 1 || !record(value.args.request)) return false
  const request = value.args.request
  if (!Object.keys(request).every(key => ['address', 'maxMessages', 'assistantStream'].includes(key)) ||
    !record(request.address)) return false
  const address = request.address
  const session = address.kind === 'session' && Object.keys(address).length === 2 &&
    typeof address.sessionId === 'string' && SESSION_ID.test(address.sessionId)
  const subagent = address.kind === 'subagent' && Object.keys(address).length === 4 &&
    typeof address.parentSessionId === 'string' && SESSION_ID.test(address.parentSessionId) &&
    typeof address.childSessionId === 'string' && SESSION_ID.test(address.childSessionId) &&
    (address.mode === 'one-shot' || address.mode === 'continuable')
  return (session || subagent) &&
    (request.maxMessages === undefined || (typeof request.maxMessages === 'number' &&
      Number.isSafeInteger(request.maxMessages) && request.maxMessages > 0 && request.maxMessages <= 500)) &&
    (request.assistantStream === undefined || request.assistantStream === true)
}

/** Binds each pending approval to one live event generation and its Session. */
export class DesktopRemoteApprovalEvents {
  private readonly clients = new Map<string, Map<string, string>>()

  /**
   * Track one event generation until its stream closes.
   * @param source - Selected Profile's forwarded event stream.
   * @returns Frames with pending approvals registered for this generation.
   */
  async *observe(source: AsyncIterable<unknown>): AsyncGenerator {
    let clientId: string | undefined
    const pending = new Map<string, string>()
    try {
      for await (const value of source) {
        if (record(value) && value.type === 'ready' && typeof value.clientId === 'string') {
          if (clientId !== undefined || this.clients.has(value.clientId)) {
            throw new Error('desktop remote UI: duplicate approval stream')
          }
          clientId = value.clientId
          this.clients.set(clientId, pending)
        } else if (clientId && record(value) && value.type === 'waterfall' &&
          value.event === 'approval/request' && typeof value.eventId === 'string' &&
          typeof value.agentId === 'string') {
          if (pending.size >= 32) throw new Error('desktop remote UI: too many pending approvals')
          pending.set(value.eventId, value.agentId)
        } else if (clientId && record(value) && value.type === 'cancel' && typeof value.eventId === 'string') {
          pending.delete(value.eventId)
        }
        yield value
      }
    } finally {
      if (clientId) this.clients.delete(clientId)
    }
  }

  /**
   * Refuse a result unless this live event generation issued it for the same Session.
   * @param gateway - Selected Profile's event response sender.
   * @param command - Validated result for one pending event.
   */
  respond(gateway: TypertGateway,
    command: Extract<HostRemoteSessionCommand, { operation: 'remote.event.respond' }>): void {
    const pending = this.clients.get(command.client_id)
    if (!pending || pending.get(command.event_id) !== command.session_id) {
      throw new Error('desktop remote UI: approval event is no longer pending for this Session')
    }
    gateway.respondRemoteEvent({ clientId: command.client_id as never, eventId: command.event_id as never,
      outcome: command.outcome === 'next' ? { kind: 'next' } :
        { kind: 'result', value: command.outcome } })
    pending.delete(command.event_id)
  }
}

/** Opens only the selected Profile's native Session, Workspace, and forwarded event streams. */
export class DesktopRemoteUiStreamExecutor {
  constructor(private readonly gateway: TypertGateway,
    private readonly approvals?: DesktopRemoteApprovalEvents) {}

  /**
   * Open the selected Profile's native Session event stream without granting another Gateway endpoint.
   * @param endpoint - `session/follow`, `workspace/follow`, or `$events`.
   * @param payload - Validated arguments for the selected stream.
   * @param signal - Host-owned cancellation signal.
   * @returns Gateway events until cancellation or normal completion.
   */
  async open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    if (endpoint === '$events') {
      if (!record(payload) || Object.keys(payload).length !== 1 || !record(payload.args) ||
        Object.keys(payload.args).length !== 0) throw new Error('desktop remote UI: invalid payload')
      const noUplink: AsyncIterable<unknown> = { async *[Symbol.asyncIterator]() {} }
      const stream = await this.gateway.wireStream.open('$events', { args: {} }, noUplink, undefined, signal)
      return this.approvals ? this.approvals.observe(stream) : stream
    }
    if (endpoint === 'workspace/follow') {
      if (!record(payload) || Object.keys(payload).length !== 1 || !record(payload.args) ||
        Object.keys(payload.args).length !== 0) throw new Error('desktop remote UI: invalid payload')
      return this.gateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal })
    }
    if (endpoint !== 'session/follow') throw new Error('desktop remote UI: endpoint denied')
    if (!followPayload(payload)) throw new Error('desktop remote UI: invalid payload')
    return this.gateway.stream({ namespace: 'session', method: 'follow', args: payload.args, signal })
  }
}

/**
 * Write one bounded event while honoring the HTTP writer's backpressure and close signal.
 * @param res - Host-only NDJSON response.
 * @param value - One item, terminal end, or terminal error frame.
 * @returns When the line is accepted by the writable stream.
 */
export async function writeDesktopRemoteUiStreamLine(res: ServerResponse, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(line) > 512 * 1024) throw new Error('stream item too large')
  if (res.write(line)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose) }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error('stream closed')) }
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

/**
 * Serve one private, bounded NDJSON Session stream; closing the HTTP response cancels the Gateway iterator.
 * @param req - Host worker's token-authenticated HTTP request.
 * @param res - Streaming HTTP response.
 * @param token - Profile worker's private bearer token.
 * @param open - Exact-endpoint stream executor in the selected Profile.
 */
export async function handleDesktopRemoteUiStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  open: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<AsyncIterable<unknown>>,
): Promise<void> {
  const controller = openDesktopRemotePrivateRequest(req, res, token)
  if (!controller) return
  try {
    const request = await readDesktopRemotePrivateBody(req)
    if (!record(request) || Object.keys(request).length !== 2 ||
      (request.endpoint !== 'session/follow' && request.endpoint !== 'workspace/follow' && request.endpoint !== '$events') ||
      (request.endpoint === 'session/follow' ? !followPayload(request.payload) :
        !record(request.payload) || Object.keys(request.payload).length !== 1 ||
        !record(request.payload.args) || Object.keys(request.payload.args).length !== 0))
      throw new Error('invalid stream request')
    const stream = await open(request.endpoint, request.payload, controller.signal)
    controller.signal.throwIfAborted()
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    for await (const value of stream) {
      controller.signal.throwIfAborted()
      await writeDesktopRemoteUiStreamLine(res, { type: 'item', value })
    }
    if (!controller.signal.aborted) { await writeDesktopRemoteUiStreamLine(res, { type: 'end' }); res.end() }
  } catch {
    if (res.destroyed || res.writableEnded) return
    if (!res.headersSent) res.writeHead(422, { 'cache-control': 'no-store' }).end()
    else {
      try { await writeDesktopRemoteUiStreamLine(res, { type: 'error', code: 'dsh_host_unavailable' }); res.end() }
      catch { res.destroy() }
    }
  }
}
