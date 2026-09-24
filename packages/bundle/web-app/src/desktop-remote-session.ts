/** Host-only bridge from the Desktop worker to the existing Session Remote surface. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  RemoteEventClientId, RemoteEventDownlinkFrame, RemoteEventId, TypertGateway,
} from '@deepseek-ai/dsh-api-gateway'
import { encodeHostControlFrame, HOST_CONTROL_MAX_FRAME_BYTES } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'

interface ApprovalCursor {
  readonly iterator: AsyncIterator<unknown>
  readonly abort: AbortController
  pending: Promise<IteratorResult<unknown>> | undefined
}

interface PendingApproval {
  readonly clientId: RemoteEventClientId
  readonly eventId: RemoteEventId
  readonly sessionId: string
  readonly digest: string
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url')
}

function row(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function historyText(value: unknown): string {
  return Array.isArray(value)
    ? value.map(part => row(part) ? part.text : undefined)
      .filter((text): text is string => typeof text === 'string').join('\n')
    : ''
}

/** Send only fields the Web timeline renders; internal Session records can exceed Host JSON depth. */
function projectHistoryRecord(value: unknown): HostRemoteSessionJson | null {
  const record = row(value) ? value : null
  const event = row(record?.event) ? record.event : null
  const data = row(event?.data) ? event.data : null
  if (record?.type !== 'event' || !event || !Number.isSafeInteger(event.seq)
    || typeof event.time !== 'number' || !Number.isFinite(event.time)) return null
  let projected: HostRemoteSessionJson
  if (event.type === 'user/message') {
    projected = { content: [{ text: historyText(data?.content) }] }
  } else if (event.type === 'assistant/message' || event.type === 'tool/result') {
    const message = row(data?.message) ? data.message : null
    projected = { message: { content: [{ text: historyText(message?.content) }] },
      ...(event.type === 'tool/result' && data?.error !== undefined ? { error: true } : {}) }
  } else if (event.type === 'tool/call') {
    projected = { name: typeof data?.name === 'string' ? data.name : '',
      arguments: typeof data?.arguments === 'string' ? data.arguments : '' }
  } else if (event.type === 'turn/end') {
    projected = { reason: typeof data?.reason === 'string' ? data.reason : '' }
  } else return null
  return { type: 'event', event: { type: event.type, seq: event.seq as number,
    time: event.time, data: projected } }
}

/** Profile-local executor; all methods stay inside the already composed DSH worker. */
export class DesktopRemoteSessionExecutor {
  private readonly cursors = new Map<string, ApprovalCursor>()
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(private readonly gateway: TypertGateway) {}

  /**
   * Execute one bounded Session command using the Session Remote method parameter names.
   * @param command - The validated Host command.
   * @param signal - Cancellation for this command.
   * @returns The JSON response sent to the Desktop Host.
   */
  async execute(command: HostRemoteSessionCommand, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    switch (command.operation) {
      case 'session.list':
        return this.invoke('list', { _request: {} }, signal)
      case 'session.create':
        return this.invoke('create', { request: {} }, signal)
      case 'session.prompt':
        return this.invoke('prompt', { request: {
          requestId: command.command_id, sessionId: command.session_id, mode: command.mode,
          content: command.content,
          ...(command.client_time_zone === undefined ? {} : { clientTimeZone: command.client_time_zone }),
        } }, signal)
      case 'session.cancel':
        return this.invoke('cancel', { request: { sessionId: command.session_id } }, signal)
      case 'session.delete':
        return this.invoke('delete', { request: { sessionId: command.session_id } }, signal)
      case 'session.rename':
        return this.invoke('rename', { request: { sessionId: command.session_id, title: command.title } }, signal)
      case 'session.history':
        return this.history(command.session_id, command.max_events, signal)
      case 'approval.poll':
        return this.poll(command.cursor, command.wait_ms, signal)
      case 'approval.respond':
        return this.respond(command)
    }
  }

  private async invoke(method: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    return await this.gateway.invoke({ namespace: 'session', method, args, signal }) as HostRemoteSessionJson
  }

  /** Return a recent, ordered suffix that leaves space for the Host frame envelope. */
  private async history(sessionId: string, maxEvents: number, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const source = await this.gateway.stream({
      namespace: 'session', method: 'follow', signal: combined,
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: maxEvents } },
    })
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      if (first.done || !row(first.value) || first.value.type !== 'snapshot' || !Array.isArray(first.value.records)) {
        throw new Error('desktop remote session: invalid history snapshot')
      }
      const records = first.value.records
      const events: HostRemoteSessionJson[] = []
      const budget = HOST_CONTROL_MAX_FRAME_BYTES * 3 / 4
      let bytes = Buffer.byteLength('{"events":[]}')
      for (const raw of records.toReversed()) {
        const record = projectHistoryRecord(raw)
        if (!record) continue
        const nextBytes = Buffer.byteLength(JSON.stringify(record)) + (events.length === 0 ? 0 : 1)
        if (bytes + nextBytes > budget) break
        try {
          encodeHostControlFrame({ version: 1, type: 'result',
            request_id: '123e4567-e89b-42d3-a456-426614174000' as never,
            method: 'profile.remote_session', result: { value: { events: [record, ...events] } } })
        } catch { continue }
        events.unshift(record)
        bytes += nextBytes
      }
      return { events }
    } finally {
      lifetime.abort()
      await iterator.return?.()
    }
  }

  private async poll(cursor: string | undefined, waitMs: number, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    let id = cursor
    let state = id === undefined ? undefined : this.cursors.get(id)
    if (id !== undefined && state === undefined) throw new Error('desktop remote session: stale approval cursor')
    if (state === undefined) {
      const abort = new AbortController()
      const stream = await this.gateway.wireStream.open('$events', { args: {} }, abort.signal)
      const iterator = stream[Symbol.asyncIterator]()
      const ready = await iterator.next()
      if (ready.done || !row(ready.value) || ready.value.type !== 'ready' || typeof ready.value.clientId !== 'string') {
        abort.abort(); throw new Error('desktop remote session: invalid approval stream')
      }
      id = ready.value.clientId
      state = { iterator, abort, pending: undefined }
      this.cursors.set(id, state)
    }
    if (id === undefined) throw new Error('desktop remote session: missing approval cursor')
    const frames: HostRemoteSessionJson[] = []
    const deadline = Date.now() + waitMs
    while (frames.length === 0) {
      signal.throwIfAborted()
      state.pending ??= state.iterator.next()
      const remaining = Math.max(0, deadline - Date.now())
      const timeout = new Promise<'timeout'>(resolve => setTimeout(resolve, remaining, 'timeout'))
      const next = await Promise.race([state.pending, timeout])
      if (next === 'timeout') break
      state.pending = undefined
      if (next.done) { this.cursors.delete(id); state.abort.abort(); break }
      const frame = next.value as RemoteEventDownlinkFrame
      if (frame.type === 'cancel') {
        for (const [approvalId, pending] of this.approvals) {
          if (pending.clientId === id && pending.eventId === frame.eventId) this.approvals.delete(approvalId)
        }
        continue
      }
      if (frame.type !== 'waterfall' || frame.event !== 'approval/request') continue
      const request = frame.request
      const operationDigest = digest(request)
      const approvalId = `${id}:${frame.eventId}`
      const pending = { clientId: id as RemoteEventClientId, eventId: frame.eventId,
        sessionId: frame.agentId, digest: operationDigest }
      this.approvals.set(approvalId, pending)
      frames.push({
        rpcId: frame.eventId,
        payload: {
          type: 'approval/requested', sessionId: frame.agentId, approvalId,
          toolName: typeof request.toolName === 'string' ? request.toolName : 'unknown',
          action: typeof request.toolName === 'string' ? request.toolName : 'unknown',
          reason: typeof request.reason === 'string' ? request.reason : null,
          operationDigest,
        },
      })
    }
    return { cursor: id, frames }
  }

  private respond(command: Extract<HostRemoteSessionCommand, { operation: 'approval.respond' }>): HostRemoteSessionJson {
    const pending = this.approvals.get(command.approval_id)
    if (pending === undefined || pending.sessionId !== command.session_id) {
      throw new Error('desktop remote session: unknown approval')
    }
    if (command.operation_digest !== undefined && command.operation_digest !== pending.digest) {
      throw new Error('desktop remote session: approval digest mismatch')
    }
    if (command.outcome === 'allowed-once' && command.operation_digest === undefined) {
      throw new Error('desktop remote session: approval digest required')
    }
    this.gateway.respondRemoteEvent({ clientId: pending.clientId, eventId: pending.eventId,
      outcome: { kind: 'result', value: command.outcome } })
    this.approvals.delete(command.approval_id)
    return { accepted: true }
  }
}

/**
 * Handle a token-authenticated Session request; browser cookies never authorize this route.
 * @param req - Incoming HTTP request.
 * @param res - HTTP response to settle.
 * @param token - The Profile worker's bearer token.
 * @param execute - Command executor inside the composed Web Profile.
 */
export async function handleDesktopRemoteSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  execute: (command: HostRemoteSessionCommand, signal: AbortSignal) => Promise<HostRemoteSessionJson>,
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
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HostRemoteSessionCommand
    const value = await execute(command, controller.signal)
    const body = JSON.stringify({ value })
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('result too large')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body)
  } catch {
    if (!res.writableEnded && !res.destroyed) res.writeHead(422, { 'cache-control': 'no-store' }).end()
  }
}
