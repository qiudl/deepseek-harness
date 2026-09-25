/** Private Session-follow stream from one Profile's Gateway to its Desktop Host worker. */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'

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

/** Opens only the selected Profile's native Session event stream. */
export class DesktopRemoteUiStreamExecutor {
  constructor(private readonly gateway: TypertGateway) {}

  /**
   * Open the selected Profile's native Session event stream without granting another Gateway endpoint.
   * @param endpoint - Only `session/follow` is accepted.
   * @param payload - Validated named SessionFollowRequest arguments.
   * @param signal - Host-owned cancellation signal.
   * @returns Gateway events until cancellation or normal completion.
   */
  async open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
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
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
  const expected = Buffer.from(token)
  const actual = Buffer.from(supplied)
  if (req.method !== 'POST' || !/^[A-Za-z0-9_-]{43}$/u.test(token)
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(403).end(); return
  }
  const controller = new AbortController()
  res.once('close', () => { controller.abort() })
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
    if (!record(request) || Object.keys(request).length !== 2 || request.endpoint !== 'session/follow' ||
      !followPayload(request.payload)) throw new Error('invalid stream request')
    const stream = await open('session/follow', request.payload, controller.signal)
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
