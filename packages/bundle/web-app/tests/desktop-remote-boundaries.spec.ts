import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest, handleDesktopRemoteJsonRequest } from '../src/desktop-remote-ui.ts'
import { DesktopRemoteSessionExecutor } from '../src/desktop-remote-session.ts'

function gateway() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return new TypertGatewayService(ctx, {})
}

async function endpoint(execute: Parameters<typeof handleDesktopRemoteJsonRequest>[3]) {
  const token = 'A'.repeat(43)
  const server = createServer((req, res) => { void handleDesktopRemoteJsonRequest(req, res, token, execute) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture port')
  return { origin: `http://127.0.0.1:${address.port}`, headers: { authorization: `Bearer ${token}` } }
}

describe('Desktop remote carrier boundaries', () => {
  it('rejects malformed payloads and credential references before invoking the gateway', async () => {
    const host = gateway()
    const invoke = vi.spyOn(host, 'invoke').mockResolvedValue({})
    const executor = new DesktopRemoteUiExecutor(host, () => [])
    const signal = new AbortController().signal
    for (const payload of [null, [], {}, { args: null }, { args: [] }, { args: {}, extra: true }]) {
      await expect(executor.execute('session/list', payload, signal)).rejects.toThrow('invalid payload')
    }
    for (const args of [{}, { refs: 'KEY' }, { refs: [], extra: true },
      { refs: Array(65).fill('KEY') }, { refs: [null] }, { refs: ['invalid-ref'] }]) {
      await expect(executor.execute('credentials/describe', { args }, signal)).rejects.toThrow('invalid payload')
    }
    expect(invoke).not.toHaveBeenCalled()
    await expect(executor.execute('credentials/describe', { args: { refs: [] } }, signal)).resolves.toEqual({})
  })

  it('rejects malformed carrier shapes through the real HTTP handler', async () => {
    const token = 'A'.repeat(43)
    const execute = vi.fn(async () => ({}))
    const server = createServer((req, res) => { void handleDesktopRemoteUiRequest(req, res, token, execute) })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture port')
    for (const body of [null, [], {}, { endpoint: 1, payload: {} }, { endpoint: 'session/list', extra: {} }]) {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(422)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await response.text()
    }
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON and oversized results without returning the result', async () => {
    const execute = vi.fn(async () => 's'.repeat(512 * 1024))
    const { origin, headers } = await endpoint(execute)
    for (const body of ['{', '{}']) {
      const response = await fetch(origin, { method: 'POST', headers, body })
      expect(response.status).toBe(422)
      expect(await response.text()).toBe('')
    }
    expect(execute).toHaveBeenCalledOnce()
  })

  it('cancels the executor when the HTTP peer disconnects', async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    let finished!: () => void
    const settled = new Promise<void>((resolve) => { finished = resolve })
    const { origin, headers } = await endpoint(async (_request, signal) => {
      const aborted = once(signal, 'abort')
      started()
      await aborted
      finished()
      throw new Error('peer disconnected')
    })
    const abort = new AbortController()
    const response = fetch(origin, { method: 'POST', headers, body: '{}', signal: abort.signal })
    const rejected = expect(response).rejects.toThrow()
    await ready
    abort.abort()
    await rejected
    await settled
  })

  it('rejects a non-byte request stream and leaves an ended response alone', async () => {
    const request = new IncomingMessage(new Socket())
    request.method = 'POST'
    request.headers.authorization = `Bearer ${'A'.repeat(43)}`
    Reflect.set(request, Symbol.asyncIterator, async function* () { yield 'not bytes' })
    const response = new ServerResponse(request)
    const execute = vi.fn(async () => ({}))
    await handleDesktopRemoteJsonRequest(request, response, 'A'.repeat(43), execute)
    expect(response.statusCode).toBe(422)
    expect(execute).not.toHaveBeenCalled()
    const ended = new ServerResponse(request)
    ended.end()
    await handleDesktopRemoteJsonRequest(request, ended, 'A'.repeat(43), execute)
    expect(ended.statusCode).toBe(200)
  })
})

describe('Desktop Session command boundaries', () => {
  const command_id = '123e4567-e89b-42d3-a456-426614174000' as never

  it('cancels obsolete approvals and binds replies to the client, session and digest', async () => {
    const host = gateway()
    const respond = vi.spyOn(host, 'respondRemoteEvent').mockImplementation(() => {})
    let opened = 0
    const uplinks: Promise<IteratorResult<unknown>>[] = []
    vi.spyOn(host.wireStream, 'open').mockImplementation(async (_endpoint, _payload, uplink) => {
      const index = ++opened
      uplinks.push(uplink[Symbol.asyncIterator]().next())
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'ready', clientId: `client-${index}` }
        yield { type: 'waterfall', event: 'approval/request', eventId: 'first', agentId: `session-${index}`,
          request: { toolName: 'bash', reason: 'fixture' } }
        if (index === 1) {
          yield { type: 'cancel', eventId: 'first' }
          yield { type: 'cancel', eventId: 'absent' }
          yield { type: 'notice' }
          yield { type: 'waterfall', event: 'other/event' }
          yield { type: 'waterfall', event: 'approval/request', eventId: 'second', agentId: 'session-1', request: {} }
        }
      } }
    })
    const executor = new DesktopRemoteSessionExecutor(host)
    const signal = new AbortController().signal
    await executor.execute({ operation: 'approval.poll', command_id, wait_ms: 10 }, signal)
    await executor.execute({ operation: 'approval.poll', command_id, wait_ms: 10 }, signal)
    const next = await executor.execute({ operation: 'approval.poll', command_id, cursor: 'client-1', wait_ms: 10 }, signal)
    expect(next).toMatchObject({ cursor: 'client-1', frames: [{ payload: { toolName: 'unknown', action: 'unknown', reason: null } }] })
    const response = { operation: 'approval.respond' as const, command_id, session_id: 'session-1', outcome: 'rejected' as const }
    await expect(executor.execute({ ...response, approval_id: 'client-1:first' }, signal)).rejects.toThrow('unknown approval')
    await expect(executor.execute({ ...response, approval_id: 'client-1:second', session_id: 'wrong' }, signal)).rejects.toThrow('unknown approval')
    await expect(executor.execute({ ...response, approval_id: 'client-1:second', operation_digest: 'wrong' as never }, signal)).rejects.toThrow('digest mismatch')
    await expect(executor.execute({ ...response, approval_id: 'client-1:second' }, signal)).resolves.toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledWith({ clientId: 'client-1', eventId: 'second', outcome: { kind: 'result', value: 'rejected' } })
    for (const cursor of ['client-1', 'client-2']) {
      await expect(executor.execute({ operation: 'approval.poll', command_id, cursor, wait_ms: 10 }, signal))
        .resolves.toEqual({ cursor, frames: [] })
    }
    await Promise.all(uplinks)
    await expect(executor.execute({ operation: 'approval.poll', command_id, cursor: 'client-1', wait_ms: 10 }, signal))
      .rejects.toThrow('stale approval cursor')
  })

  it.each([undefined, null, {}, { type: 'notice' }, { type: 'ready', clientId: 1 }])(
    'rejects invalid approval handshakes and closes the uplink (%j)', async (value) => {
      const host = gateway()
      let uplinkIterator: AsyncIterator<unknown> | undefined
      vi.spyOn(host.wireStream, 'open').mockImplementation(async (_endpoint, _payload, uplink) => {
        uplinkIterator = uplink[Symbol.asyncIterator]()
        return { async *[Symbol.asyncIterator]() { if (value !== undefined) yield value } }
      })
      await expect(new DesktopRemoteSessionExecutor(host).execute({ operation: 'approval.poll', command_id, wait_ms: 10 },
        new AbortController().signal)).rejects.toThrow('invalid approval stream')
      expect(await uplinkIterator?.next()).toEqual({ done: true, value: undefined })
    },
  )

  it('fails closed if a malformed ready frame changes its cursor while being read', async () => {
    const host = gateway()
    let reads = 0
    const frame = { type: 'ready', get clientId() { return ++reads === 1 ? 'unstable' : undefined } }
    vi.spyOn(host.wireStream, 'open').mockResolvedValue({ async *[Symbol.asyncIterator]() { yield frame } })
    await expect(new DesktopRemoteSessionExecutor(host).execute({ operation: 'approval.poll', command_id, wait_ms: 0 },
      new AbortController().signal)).rejects.toThrow('missing approval cursor')
  })

  it('retains one pending read across poll timeout and drains it on the next poll', async () => {
    const host = gateway()
    let resolveFrame!: (value: IteratorResult<unknown>) => void
    const pending = new Promise<IteratorResult<unknown>>((resolve) => { resolveFrame = resolve })
    let calls = 0
    const next = vi.fn(async () => ++calls === 1 ? { done: false, value: { type: 'ready', clientId: 'waiting' } }
      : calls === 2 ? pending : { done: true, value: undefined })
    vi.spyOn(host.wireStream, 'open').mockResolvedValue({ [Symbol.asyncIterator]: () => ({ next }) })
    const executor = new DesktopRemoteSessionExecutor(host)
    const signal = new AbortController().signal
    await expect(executor.execute({ operation: 'approval.poll', command_id, wait_ms: 0 }, signal))
      .resolves.toEqual({ cursor: 'waiting', frames: [] })
    expect(next).toHaveBeenCalledTimes(2)
    resolveFrame({ done: true, value: undefined })
    await expect(executor.execute({ operation: 'approval.poll', command_id, cursor: 'waiting', wait_ms: 10 }, signal))
      .resolves.toEqual({ cursor: 'waiting', frames: [] })
    expect(next).toHaveBeenCalledTimes(2)
  })
  it('maps create, cancel, delete and rename to their exact gateway parameters', async () => {
    const host = gateway()
    const invoke = vi.spyOn(host, 'invoke').mockResolvedValue({ accepted: true })
    const executor = new DesktopRemoteSessionExecutor(host)
    const signal = new AbortController().signal
    const command_id = '123e4567-e89b-42d3-a456-426614174000' as never
    await executor.execute({ operation: 'session.create', command_id }, signal)
    await executor.execute({ operation: 'session.cancel', command_id, session_id: 's1' }, signal)
    await executor.execute({ operation: 'session.delete', command_id, session_id: 's1' }, signal)
    await executor.execute({ operation: 'session.rename', command_id, session_id: 's1', title: 'new title' }, signal)
    await executor.execute({ operation: 'session.prompt', command_id, session_id: 's1', mode: 'queue', content: [] }, signal)
    expect(invoke.mock.calls.map(([request]) => [request.method, request.args])).toEqual([
      ['create', { request: {} }], ['cancel', { request: { sessionId: 's1' } }],
      ['delete', { request: { sessionId: 's1' } }], ['rename', { request: { sessionId: 's1', title: 'new title' } }],
      ['prompt', { request: { requestId: command_id, sessionId: 's1', mode: 'queue', content: [] } }],
    ])
  })

  it('omits malformed history records and projects only bounded display fields', async () => {
    const host = gateway()
    const event = (type: string, data: unknown = null) => ({ type: 'event', event: { type, seq: 1, time: 2, data } })
    const records = [null, {}, { event: null }, { type: 'event', event: { seq: 1 } },
      { type: 'event', event: { seq: 1, time: NaN } },
      event('user/message'), event('user/message', { content: [{ text: 'x'.repeat(32769) }] }),
      event('user/message', { content: [null, { text: 1 }, { text: 'hello' }] }),
      event('assistant/message'), event('tool/result', { message: { content: [] }, error: 'failed' }),
      event('tool/result'), event('tool/call'), event('tool/call', { name: 'bash', arguments: '{}' }),
      event('turn/end'), event('turn/end', { reason: 'complete' }), event('internal/private')]
    vi.spyOn(host, 'stream').mockResolvedValue({ async *[Symbol.asyncIterator]() { yield { type: 'snapshot', records } } })
    const value = await new DesktopRemoteSessionExecutor(host).execute({ operation: 'session.history',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 's1', max_events: 100,
    }, new AbortController().signal)
    expect(value).toEqual({ events: [
      event('user/message', { content: [{ text: '' }] }), event('user/message', { content: [{ text: 'hello' }] }),
      event('assistant/message', { message: { content: [{ text: '' }] } }),
      event('tool/result', { message: { content: [{ text: '' }] }, error: true }),
      event('tool/result', { message: { content: [{ text: '' }] } }),
      event('tool/call', { name: '', arguments: '' }), event('tool/call', { name: 'bash', arguments: '{}' }),
      event('turn/end', { reason: '' }), event('turn/end', { reason: 'complete' }),
    ] })
  })

  it.each([undefined, null, {}, { type: 'event' }, { type: 'snapshot', records: null }])(
    'rejects invalid opening history snapshots (%j)', async (value) => {
      const host = gateway()
      vi.spyOn(host, 'stream').mockResolvedValue({ async *[Symbol.asyncIterator]() { if (value !== undefined) yield value } })
      await expect(new DesktopRemoteSessionExecutor(host).execute({ operation: 'session.history',
        command_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 's1', max_events: 100,
      }, new AbortController().signal)).rejects.toThrow('invalid history snapshot')
    },
  )
})
