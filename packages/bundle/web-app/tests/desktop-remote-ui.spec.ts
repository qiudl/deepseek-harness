import { DesktopRemoteTerminalStreams } from '../src/desktop-remote-terminal-stream.ts'
import { DesktopSessionControl } from '../src/desktop-session-control.ts'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'

import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest } from '../src/desktop-remote-ui.ts'
import { DesktopRemoteApprovalEvents, DesktopRemoteUiStreamExecutor, handleDesktopRemoteUiStreamRequest,
  writeDesktopRemoteUiStreamLine } from '../src/desktop-remote-ui-stream.ts'
import { rejectDesktopRemotePrivateRequest, writeDesktopRemotePrivateResult } from '../src/desktop-remote-private-request.ts'

function gatewayFixture(fields: object): TypertGateway {
  return Object.assign({} as TypertGateway, fields)
}

function responseFixture<T extends object>(value: T): T & ServerResponse {
  return value as T & ServerResponse
}

describe('Desktop remote UI read-only bridge', () => {
  it.each(['close', 'write-failure', 'server-ended'])('keeps an idle private stream alive and releases its timer on settlement (%s)', async (settlement) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const token = 'A'.repeat(43)
    const body = Buffer.from(JSON.stringify({ endpoint: 'workspace/follow', payload: { args: {} } }))
    const req = { method: 'POST', headers: { authorization: `Bearer ${token}` },
      async *[Symbol.asyncIterator]() { yield body } } as IncomingMessage
    let ready!: () => void
    const opened = new Promise<void>((resolve) => { ready = resolve })
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, headersSent: false, writableNeedDrain: true,
      write: vi.fn(() => true),
      writeHead() { this.headersSent = true; ready(); return this },
      end() { this.writableEnded = true; return this },
      destroy() { this.destroyed = true; return this },
    })
    const running = handleDesktopRemoteUiStreamRequest(req, responseFixture(res), token,
      async (_endpoint, _payload, signal) => (async function* () {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      })())
    try {
      await opened
      await vi.advanceTimersByTimeAsync(30_000)
      expect(res.write).not.toHaveBeenCalled()
      res.writableNeedDrain = false
      if (settlement === 'write-failure') res.write.mockImplementation(() => { throw new Error('closed transport') })
      if (settlement === 'server-ended') res.end()
      await vi.advanceTimersByTimeAsync(30_000)
      if (settlement === 'server-ended') expect(res.write).not.toHaveBeenCalled()
      else expect(res.write).toHaveBeenCalledWith('{"type":"heartbeat"}\n')
      if (settlement === 'write-failure') expect(res.destroyed).toBe(true)
      else res.emit('close')
      await running
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      res.emit('close')
      await running
      vi.useRealTimers()
    }
  })

  it('does not rewrite ended private responses and bounds JSON results', () => {
    const open = { writableEnded: false, destroyed: false, writeHead: vi.fn().mockReturnThis(), end: vi.fn() }
    rejectDesktopRemotePrivateRequest(responseFixture(open))
    expect(open.writeHead).toHaveBeenCalledWith(422, { 'cache-control': 'no-store' })
    expect(open.end).toHaveBeenCalledOnce()
    const ended = { writableEnded: true, destroyed: false, writeHead: vi.fn() }
    rejectDesktopRemotePrivateRequest(responseFixture(ended))
    expect(ended.writeHead).not.toHaveBeenCalled()
    const destroyed = { writableEnded: false, destroyed: true, writeHead: vi.fn() }
    rejectDesktopRemotePrivateRequest(responseFixture(destroyed))
    expect(destroyed.writeHead).not.toHaveBeenCalled()
    expect(() => { writeDesktopRemotePrivateResult(responseFixture(ended), 'x'.repeat(512 * 1024)) })
      .toThrow('result too large')
  })

  it('handles malformed input, early disconnect, and failed terminal writes', async () => {
    const token = 'A'.repeat(43)
    const body = Buffer.from(JSON.stringify({ endpoint: 'session/follow', payload: { args: { request: {
      address: { kind: 'session', sessionId: 'session-1' },
    } } } }))
    const request = (chunks: unknown[]) => ({
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }) as IncomingMessage
    const response = () => {
      const res = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false, headersSent: false, status: 0,
        write: vi.fn(() => true),
        writeHead(status: number) { this.status = status; this.headersSent = true; return this },
        end() { this.writableEnded = true; return this },
        destroy() { this.destroyed = true; return this },
      })
      return res
    }
    const invalid = response()
    await handleDesktopRemoteUiStreamRequest(request(['not bytes']), responseFixture(invalid),
      token, async () => { throw new Error('unexpected open') })
    expect(invalid.status).toBe(422)

    const disconnected = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), responseFixture(disconnected),
      token, async () => (async function* () { disconnected.emit('close') })())
    expect(disconnected.status).toBe(200)
    expect(disconnected.write).not.toHaveBeenCalled()
    expect(disconnected.writableEnded).toBe(false)

    const destroyed = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), responseFixture(destroyed),
      token, async () => { destroyed.destroy(); throw new Error('closed') })
    expect(destroyed.status).toBe(0)

    const ended = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), responseFixture(ended),
      token, async () => { ended.end(); throw new Error('ended') })
    expect(ended.status).toBe(0)

    const failed = response()
    failed.write.mockImplementation(() => { throw new Error('write failed') })
    await handleDesktopRemoteUiStreamRequest(request([body]), responseFixture(failed),
      token, async () => (async function* () { throw new Error('gateway failed') })())
    expect(failed.status).toBe(200)
    expect(failed.destroyed).toBe(true)
  })

  it('bounds NDJSON events and waits for writer drain or close', async () => {
    const writer = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> }
    writer.write = vi.fn(() => true)
    const res = responseFixture(writer)
    await writeDesktopRemoteUiStreamLine(res, { type: 'end' })
    expect(writer.write).toHaveBeenCalledWith('{"type":"end"}\n')
    await expect(writeDesktopRemoteUiStreamLine(res, { value: 'x'.repeat(512 * 1024) }))
      .rejects.toThrow('stream item too large')
    writer.write.mockReturnValue(false)
    const drained = writeDesktopRemoteUiStreamLine(res, { type: 'end' })
    writer.emit('drain')
    await expect(drained).resolves.toBeUndefined()
    expect(writer.listenerCount('close')).toBe(0)
    const closed = writeDesktopRemoteUiStreamLine(res, { type: 'end' })
    writer.emit('close')
    await expect(closed).rejects.toThrow('stream closed')
    expect(writer.listenerCount('drain')).toBe(0)
  })

  it('streams one complete large Session list and rejects extra selectors', async () => {
    const value = { items: Array.from({ length: 94 }, (_, i) => ({
      sessionId: `session-${i}`, updatedAt: 1, projections: { values: { title: '摘要🌟'.repeat(300) } },
    })) }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(64 * 1024)
    const invoke = vi.fn(async () => value)
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    const values = []
    for await (const item of await executor.open('session/list', { args: {} }, signal)) values.push(item)
    expect(values).toEqual([value])
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: { _request: {} }, signal })
    for (const invalid of [null, {}, { args: null }, { args: [] }, { args: { path: '/other' } }, { args: {}, extra: true }]) {
      await expect(executor.open('session/list', invalid, signal)).rejects.toThrow('invalid payload')
    }
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('opens only a bounded native Session follow request', async () => {
    const stream = vi.fn(async () => (async function* () { yield { type: 'snapshot' } })())
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ stream }))
    const signal = new AbortController().signal
    const payload = { args: { request: { address: { kind: 'session', sessionId: 'session-1' },
      maxMessages: 500, assistantStream: true, turnWindow: { minMessages: 50, minTurns: 2 } } } }
    const opened = await executor.open('session/follow', payload, signal)
    const iterator = opened[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'snapshot' }, done: false })
    expect(stream).toHaveBeenCalledWith({ namespace: 'session', method: 'follow', args: payload.args, signal })
    await expect(executor.open('session/prompt', payload, signal)).rejects.toThrow('endpoint denied')
    await expect(executor.open('session/follow', { args: { request: { address: {
      kind: 'session', sessionId: '' } } } }, signal)).rejects.toThrow('invalid payload')
    expect(stream).toHaveBeenCalledOnce()
    for (const invalid of [null, {}, { args: null }, { args: {} }, { args: { request: null } },
      ...[null, [], {}, { minMessages: 50 }, { minMessages: 0, minTurns: 2 },
        { minMessages: 501, minTurns: 2 }, { minMessages: 50, minTurns: 0 },
        { minMessages: 50, minTurns: 1.5 }, { minMessages: 50, minTurns: Number.MAX_SAFE_INTEGER + 1 },
        { minMessages: 50, minTurns: 2, path: '/tmp' }].map(turnWindow => ({ args: { request: {
        ...payload.args.request, turnWindow,
      } } })),
      { args: { request: { address: payload.args.request.address,
        turnWindow: { minMessages: 51, minTurns: 2 } } } },
      { args: { request: { address: { kind: 'session', sessionId: 'session-1' }, extra: true } } },
      { args: { request: { address: null } } },
      { args: { request: { address: { kind: 'session', sessionId: 1 } } } },
      { args: { request: { address: { kind: 'session', sessionId: 'session-1', path: '/tmp' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: 1,
        childSessionId: 'child', mode: 'one-shot' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: '',
        childSessionId: 'child', mode: 'one-shot' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: 'parent',
        childSessionId: 1, mode: 'one-shot' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: 'parent',
        childSessionId: '', mode: 'one-shot' } } } },
      { args: { request: { address: { kind: 'subagent', parentSessionId: 'parent',
        childSessionId: 'child', mode: 'invalid' } } } },
      ...[null, 1.5, 0, 501].map(maxMessages => ({ args: { request: {
        address: { kind: 'session', sessionId: 'session-1' }, maxMessages,
      } } })),
      { args: { request: { address: { kind: 'session', sessionId: 'session-1' }, assistantStream: false } } },
    ]) await expect(executor.open('session/follow', invalid, signal)).rejects.toThrow('invalid payload')
    await expect(executor.open('session/follow', { args: { request: { address: { kind: 'subagent',
      parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' } } } }, signal))
      .resolves.toBeDefined()
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('opens only issued terminal permits through the same Profile manager', async () => {
    const signal = new AbortController().signal
    const stream = vi.fn(async () => (async function* () { yield { type: 'retained' } })())
    const gateway = gatewayFixture({ stream })
    const control = new DesktopSessionControl()
    const state = control.acquire('s', { kind: 'remote', id: '123e4567-e89b-42d3-a456-426614174001' }, { takeover: false })
    if (!('claim' in state)) throw new Error('missing claim')
    const manager = new DesktopRemoteTerminalStreams(control)
    const permit = manager.issue({ operation: 'terminal.apply', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 's', control: { controller_id: state.claim.id, generation: state.claim.generation, epoch: state.claim.epoch },
      request: { sessionId: 's', method: 'retain', args: { sessionId: 's', id: 't' } } })
    const executor = new DesktopRemoteUiStreamExecutor(gateway, undefined, undefined, manager)
    const items: unknown[] = []
    for await (const value of await executor.open('terminal/stream', { args: permit }, signal)) items.push(value)
    expect(items).toEqual([{ type: 'retained' }])
    await expect(executor.open('terminal/stream', { args: { grantId: 'bad' } }, signal)).rejects.toThrow('unavailable')
    await expect(new DesktopRemoteUiStreamExecutor(gateway).open('terminal/stream', { args: permit }, signal)).rejects.toThrow('unavailable')
    expect(stream).toHaveBeenCalledOnce()
  })
  it('reads terminal lists and launch choices without acquiring Session control', async () => {
    const invoke = vi.fn(async () => [])
    const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
    const signal = new AbortController().signal
    for (const [method, args] of [
      ['environment', { agentId: 's' }], ['shells', { agentId: 's' }], ['list', { sessionId: 's' }],
    ] as const) {
      await expect(executor.execute('terminal/' + method, { args }, signal)).resolves.toEqual([])
      expect(invoke).toHaveBeenLastCalledWith({ namespace: 'terminal', method, args, signal })
    }
    for (const args of [{ agentId: 's', profile: 'other' }, { agentId: '../other' }, { sessionId: 's', path: '/' }]) {
      await expect(executor.execute('terminal/list', { args }, signal)).rejects.toThrow('invalid terminal payload')
    }
    expect(invoke).toHaveBeenCalledTimes(3)
  })
  it('keeps file observations scoped and cancellation owned by the caller', async () => {
    const stream = vi.fn(async () => (async function* () { yield { type: 'ready' } })())
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ stream }))
    const signal = new AbortController().signal
    const payload = { args: { workspaceFileScopeId: 'session-1', path: 'file.txt' } }
    const opened = await executor.open('workspaceFiles/changes', payload, signal)
    await expect(opened[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: { type: 'ready' } })
    expect(stream).toHaveBeenCalledExactlyOnceWith({ namespace: 'workspaceFiles', method: 'changes', args: payload.args, signal })
    await expect(executor.open('workspaceFiles/changes', { args: { ...payload.args, profile: 'other' } }, signal)).rejects.toThrow('invalid file observation')
    expect(stream).toHaveBeenCalledOnce()
  })

  it('forwards only validated file reads to the composed Connection handler', async () => {
    const read = vi.fn(async () => Response.json({ value: 'file' }))
    const gateway = gatewayFixture({})
    const executor = new DesktopRemoteUiStreamExecutor(gateway, undefined, read)
    const signal = new AbortController().signal
    const payload = { args: { endpoint: 'workspaceFiles/stat', rpcId: 'file-rpc',
      args: { workspaceFileScopeId: 'session-1', path: 'file.txt' } } }
    const items: unknown[] = []
    for await (const value of await executor.open('workbench/read', payload, signal)) items.push(value)
    expect(items[0]).toEqual({ type: 'head', contentType: 'application/json' })
    expect(items.at(-1)).toEqual({ type: 'complete', totalBytes: 16 })
    expect(read).toHaveBeenCalledOnce()
    await expect(executor.open('workbench/read', { args: {} }, signal)).rejects.toThrow('file read unavailable')
    await expect(new DesktopRemoteUiStreamExecutor(gateway).open('workbench/read', payload, signal)).rejects.toThrow('file read unavailable')
  })

  it('opens a Workspace baseline stream only with empty arguments', async () => {
    const stream = vi.fn(async () => (async function* () { yield { type: 'baseline', value: { items: [] } } })())
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ stream }))
    const signal = new AbortController().signal
    const opened = await executor.open('workspace/follow', { args: {} }, signal)
    await expect(opened[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: { type: 'baseline', value: { items: [] } }, done: false,
    })
    expect(stream).toHaveBeenCalledWith({ namespace: 'workspace', method: 'follow', args: {}, signal })
    await expect(executor.open('workspace/follow', { args: { path: '/tmp' } }, signal)).rejects.toThrow('invalid payload')
  })

  it('opens native events without approval tracking only for empty arguments', async () => {
    const native = (async function* () { yield { type: 'ready', clientId: 'client-1' } })()
    const open = vi.fn(async (_endpoint: string, _payload: unknown, uplink: AsyncIterable<unknown>) => {
      expect(await uplink[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
      return native
    })
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ wireStream: { open } }))
    const signal = new AbortController().signal
    for (const payload of [null, [], {}, { args: null }, { args: [] }, { args: { all: true } }]) {
      await expect(executor.open('$events', payload, signal)).rejects.toThrow('invalid payload')
    }
    const stream = await executor.open('$events', { args: {} }, signal)
    expect(stream).toBe(native)
    expect(open).toHaveBeenCalledWith('$events', { args: {} }, expect.anything(), undefined, signal)
  })

  it('accepts approval results only for a pending event in the same Session', async () => {
    const respondRemoteEvent = vi.fn()
    const gateway = gatewayFixture({ wireStream: { open: vi.fn(async () => (async function* () {
      yield { type: 'ready', clientId: 'client-1', host: { home: '/home/user' } }
      yield { type: 'waterfall', event: 'approval/request', eventId: 'event-1',
        agentId: 'session-1', request: { toolName: 'bash' } }
    })()) }, respondRemoteEvent })
    const approvals = new DesktopRemoteApprovalEvents()
    const executor = new DesktopRemoteUiStreamExecutor(gateway, approvals)
    const source = await executor.open('$events', { args: {} }, new AbortController().signal)
    const iterator = source[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    const command = { operation: 'remote.event.respond' as const,
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: { controller_id: '123e4567-e89b-42d3-a456-426614174001',
        generation: '123e4567-e89b-42d3-a456-426614174002', epoch: 1 },
      client_id: 'client-1', event_id: 'event-1', outcome: 'allowed-once' as const }
    expect(() => { approvals.respond(gateway, { ...command, session_id: 'session-2' }) }).toThrow()
    approvals.respond(gateway, command)
    expect(respondRemoteEvent).toHaveBeenCalledWith({ clientId: 'client-1', eventId: 'event-1',
      outcome: { kind: 'result', value: 'allowed-once' } })
    expect(() => { approvals.respond(gateway, command) }).toThrow()
    await iterator.return?.()
  })

  it('rejects duplicate event generations without invalidating the original owner', async () => {
    const approvals = new DesktopRemoteApprovalEvents()
    const respondRemoteEvent = vi.fn()
    const gateway = gatewayFixture({ respondRemoteEvent })
    const first = approvals.observe((async function* () {
      yield { type: 'ready', clientId: 'client-1' }
      yield { type: 'waterfall', event: 'approval/request', eventId: 'event-1', agentId: 'session-1' }
      yield { type: 'ready', clientId: 'client-2' }
    })())[Symbol.asyncIterator]()
    await first.next()
    await first.next()
    const duplicate = approvals.observe((async function* () {
      yield { type: 'ready', clientId: 'client-1' }
    })())[Symbol.asyncIterator]()
    await expect(duplicate.next()).rejects.toThrow('duplicate approval stream')
    const command = { operation: 'remote.event.respond' as const,
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: { controller_id: '123e4567-e89b-42d3-a456-426614174001',
        generation: '123e4567-e89b-42d3-a456-426614174002', epoch: 1 },
      client_id: 'client-1', event_id: 'event-1', outcome: 'next' as const }
    approvals.respond(gateway, command)
    expect(respondRemoteEvent).toHaveBeenCalledWith({ clientId: 'client-1', eventId: 'event-1',
      outcome: { kind: 'next' } })
    await expect(first.next()).rejects.toThrow('duplicate approval stream')
    expect(() => { approvals.respond(gateway, command) }).toThrow()
  })

  it('removes cancelled approvals and bounds pending replies per event generation', async () => {
    const approvals = new DesktopRemoteApprovalEvents()
    const source = approvals.observe((async function* () {
      yield { type: 'ready', clientId: 'client-1' }
      yield { type: 'waterfall', event: 'approval/request', eventId: 'cancelled', agentId: 'session-1' }
      yield { type: 'cancel', eventId: 1 }
      yield { type: 'cancel', eventId: 'cancelled' }
      for (let index = 0; index <= 32; index += 1) {
        yield { type: 'waterfall', event: 'approval/request', eventId: `event-${index}`,
          agentId: 'session-1' }
      }
    })())[Symbol.asyncIterator]()
    await source.next()
    await source.next()
    await source.next()
    await source.next()
    expect(() => { approvals.respond(gatewayFixture({ respondRemoteEvent: vi.fn() }), {
      operation: 'remote.event.respond', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: { controller_id: '123e4567-e89b-42d3-a456-426614174001',
        generation: '123e4567-e89b-42d3-a456-426614174002', epoch: 1 },
      client_id: 'client-1', event_id: 'cancelled', outcome: 'rejected',
    }) }).toThrow()
    for (let index = 0; index < 32; index += 1) await source.next()
    await expect(source.next()).rejects.toThrow('too many pending approvals')
  })

  it('streams through a private token and rejects browser cookies', async () => {
    const token = 'A'.repeat(43)
    let stopped = false
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, async (_endpoint, _payload, signal) => (async function* () {
        try {
          yield { type: 'snapshot', cursor: 1 }
          yield { type: 'event', cursor: 2 }
        } finally { stopped = signal.aborted }
      })())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const body = JSON.stringify({ endpoint: 'session/follow', payload: { args: { request: {
        address: { kind: 'session', sessionId: 'session-1' },
      } } } })
      await expect(fetch(origin, { method: 'POST', headers: { cookie: 'dsh-auth=fake' }, body })
        .then(response => response.status)).resolves.toBe(403)
      const response = await fetch(origin, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(JSON.stringify({ type: 'item', value: { type: 'snapshot', cursor: 1 } }) + '\n'
        + JSON.stringify({ type: 'item', value: { type: 'event', cursor: 2 } }) + '\n'
        + JSON.stringify({ type: 'end' }) + '\n')
      expect(stopped).toBe(false)
      const headers = { authorization: `Bearer ${token}` }
      await expect(fetch(origin, { method: 'GET', headers }).then(value => value.status)).resolves.toBe(403)
      await expect(fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${'C'.repeat(43)}` }, body })
        .then(value => value.status)).resolves.toBe(403)
      for (const bad of ['{', '{}', 'x'.repeat(65_537), JSON.stringify({ endpoint: 'session/prompt',
        payload: { args: {} } }), JSON.stringify({ endpoint: 'session/follow', payload: {} })]) {
        await expect(fetch(origin, { method: 'POST', headers, body: bad }).then(value => value.status))
          .resolves.toBe(422)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('serves a complete Session list through the private HTTP stream and executor', async () => {
    const token = 'L'.repeat(43)
    const value = { items: Array.from({ length: 94 }, (_, index) => ({
      sessionId: `session-${index}`, title: '摘要🌟'.repeat(300),
    })) }
    const invoke = vi.fn(async () => value)
    const executor = new DesktopRemoteUiStreamExecutor(gatewayFixture({ invoke }))
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, executor.open.bind(executor))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const body = JSON.stringify({ endpoint: 'session/list', payload: { args: {} } })
      const denied = await fetch(origin, { method: 'POST', headers: { cookie: 'dsh-auth=fake' }, body })
      expect(denied.status).toBe(403)
      expect(invoke).not.toHaveBeenCalled()
      const response = await fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(JSON.stringify({ type: 'item', value }) + '\n'
        + JSON.stringify({ type: 'end' }) + '\n')
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('rejects malformed Session list, Workspace and event stream requests before opening a native stream', async () => {
    const token = 'A'.repeat(43)
    const open = vi.fn(async () => (async function* () {})())
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, open)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      for (const endpoint of ['session/list', 'workspace/follow', '$events']) {
        for (const payload of [null, [], {}, { args: null }, { args: [] }, { args: { all: true } }]) {
          const response = await fetch(origin, { method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ endpoint, payload }) })
          expect(response.status).toBe(422)
        }
      }
      expect(open).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('admits only scoped terminal and file observation streams over private HTTP', async () => {
    const token = 'A'.repeat(43)
    const open = vi.fn(async () => (async function* () { yield { type: 'ready' } })())
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, open)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const cases = [
        { endpoint: 'terminal/stream', valid: { args: { grantId: '123e4567-e89b-42d3-a456-426614174000' } },
          invalid: { args: { grantId: 'not-a-grant' } } },
        { endpoint: 'workspaceFiles/changes', valid: { args: { workspaceFileScopeId: 'session-1', path: 'file.txt' } },
          invalid: { args: { workspaceFileScopeId: 'session-1', path: 'file.txt', profile: 'other' } } },
      ]
      for (const { endpoint, valid, invalid } of cases) {
        const denied = await fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint, payload: invalid }) })
        expect(denied.status).toBe(422)
        const admitted = await fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ endpoint, payload: valid }) })
        expect(admitted.status).toBe(200)
        expect(await admitted.text()).toBe(JSON.stringify({ type: 'item', value: { type: 'ready' } }) + '\n'
          + JSON.stringify({ type: 'end' }) + '\n')
      }
      expect(open).toHaveBeenCalledTimes(cases.length)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('ends a Host stream with a bounded error when the Gateway fails after its first item', async () => {
    const token = 'D'.repeat(43)
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, async () => (async function* () {
        yield { type: 'snapshot' }
        throw new Error('private detail')
      })())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const response = await fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: 'session/follow', payload: { args: { request: {
          address: { kind: 'session', sessionId: 'session-1' },
        } } } }) })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(JSON.stringify({ type: 'item', value: { type: 'snapshot' } }) + '\n'
        + JSON.stringify({ type: 'error', code: 'dsh_host_unavailable' }) + '\n')
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('cancels the Gateway iterator when its Host HTTP reader disconnects', async () => {
    const token = 'B'.repeat(43)
    let aborted!: () => void
    const stopped = new Promise<void>((resolve) => { aborted = resolve })
    const requests: Promise<void>[] = []
    const server = createServer((req, res) => {
      requests.push(handleDesktopRemoteUiStreamRequest(req, res, token, async (_endpoint, _payload, signal) => (async function* () {
        yield { type: 'snapshot' }
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { aborted(); resolve() }, { once: true })
        })
      })()))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const controller = new AbortController()
    try {
      const response = await fetch(origin, { method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
          endpoint: 'session/follow', payload: { args: { request: {
            address: { kind: 'session', sessionId: 'session-1' },
          } } },
        }) })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('snapshot')
      controller.abort()
      await stopped
    } finally {
      controller.abort()
      await Promise.all(requests)
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })
  it('reads only exact Session command and skill catalogs', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
    const signal = new AbortController().signal
    await executor.execute('commands/list', { args: { agent: 'session-1' } }, signal)
    await executor.execute('skills/list', { args: { request: { sessionId: 'session-1' } } }, signal)
    for (const [endpoint, args] of [
      ['commands/list', {}], ['commands/list', { agent: 1 }],
      ['commands/list', { agent: 'session-1', profile: 'other' }],
      ['commands/list', { agent: '../other' }],
      ['skills/list', {}], ['skills/list', { request: null }],
      ['skills/list', { request: {} }], ['skills/list', { request: { sessionId: 1 } }],
      ['skills/list', { request: { sessionId: 'session-1', profile: 'other' } }],
      ['skills/list', { request: { sessionId: '../other' } }],
      ['llm/listProviders', { secret: true }],
    ] as const) await expect(executor.execute(endpoint, { args }, signal)).rejects.toThrow()
    expect(invoke.mock.calls).toEqual([
      [{ namespace: 'commands', method: 'list', args: { agent: 'session-1' }, signal }],
      [{ namespace: 'skills', method: 'list', args: { request: { sessionId: 'session-1' } }, signal }],
    ])
  })
  it('dispatches only the exact M1 read endpoints with named Remote arguments', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const boot = vi.fn(() => [{ kind: 'script' as const, placement: 'head' as const, text: 'boot()' }])
    const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), boot)
    const signal = new AbortController().signal
    await expect(executor.execute('boot/injections', { args: {} }, signal))
      .resolves.toEqual({ injections: [{ kind: 'script', placement: 'head', text: 'boot()' }] })
    expect(boot).toHaveBeenCalledOnce()
    await expect(executor.execute('boot/injections', { args: { extra: true } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('session/list', { args: { _request: {} } }, signal))
      .resolves.toEqual({ items: [] })
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: { _request: {} }, signal })
    for (const endpoint of ['settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
      'credentials/describe', 'permissionPresets/catalog', 'cotTranslation/limits', 'llm/listProviders', 'llm/listConfigurableProviders']) {
      const args = endpoint === 'credentials/describe' ? { refs: ['OPENAI_API_KEY'] } : {}
      await expect(executor.execute(endpoint, { args }, signal)).resolves.toEqual({ items: [] })
      const [namespace, method] = endpoint.split('/')
      expect(invoke).toHaveBeenCalledWith({ namespace, method, args, signal })
    }
    await expect(executor.execute('credentials/describe', { args: { refs: ['bad-ref'] } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('settings/describe', { args: { path: '/private' } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('cotTranslation/limits', { args: { provider: 'other' } }, signal))
      .rejects.toThrow('invalid payload')
    for (const endpoint of ['cotTranslation/translate', 'cotTranslation/limits?all=true', 'session/prompt', 'session/delete', 'workspace/create', 'llm/discoverModels', '$events/result']) {
      await expect(executor.execute(endpoint, { args: {} }, signal)).rejects.toThrow('endpoint denied')
    }
    await expect(executor.execute('dynamicCordisRunner/syncInspectManifest', { args: {} }, signal))
      .rejects.toThrow('endpoint denied')
    expect(invoke).toHaveBeenCalledTimes(9)
  })
  it('REQ-20261011-0002 validates membership replies before passing them to Main', async () => {
    const entry = { workspaceId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1' }
    const invoke = vi.fn(async () => ({ entries: [{ ...entry, owned: true, pinned: false, archived: false }] }))
    const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
    const signal = new AbortController().signal
    const payload = { args: { request: { entries: [entry] } } }
    await expect(executor.execute('session/collaborationMembership', payload, signal))
      .resolves.toEqual({ entries: [{ ...entry, owned: true, pinned: false, archived: false }] })
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'collaborationMembership', args: payload.args, signal })
    await expect(executor.execute('session/collaborationMembership', { args: { request: { entries: [entry, entry] } } }, signal))
      .rejects.toThrow('invalid membership payload')
    invoke.mockResolvedValue({ entries: [{ ...entry, owned: false, pinned: true, archived: false }] })
    await expect(executor.execute('session/collaborationMembership', payload, signal))
      .rejects.toThrow('invalid membership result')
    const invalidRequests: unknown[] = [
      { args: { request: { entries: [] } } },
      { args: { request: { entries: Array.from({ length: 51 }, () => entry) } } },
      { args: { request: null } },
      { args: { request: { entries: [null] } } },
      { args: { request: { entries: [{ ...entry, path: '/tmp' }] } } },
      { args: { request: { entries: [{ ...entry, workspaceId: 'bad' }] } } },
      ...['', '.', '..', 'bad/id', 'bad\\id', 'x'.repeat(257)].map(sessionId =>
        ({ args: { request: { entries: [{ ...entry, sessionId }] } } })),
      { args: { request: { entries: [entry] }, path: '/tmp' } },
      { args: { request: { entries: [entry] }, extra: true } },
    ]
    for (const invalid of invalidRequests) {
      await expect(executor.execute('session/collaborationMembership', invalid, signal))
        .rejects.toThrow('invalid membership payload')
    }
    const invalidResults: unknown[] = [
      null, {}, { entries: null }, { entries: [] }, { entries: [{ ...entry, owned: true, pinned: false, archived: false }], extra: true },
      { entries: [null] },
      { entries: [{ ...entry, owned: true, pinned: false, archived: false, extra: true }] },
      { entries: [{ ...entry, workspaceId: '22222222-2222-4222-8222-222222222222', owned: true, pinned: false, archived: false }] },
      { entries: [{ ...entry, sessionId: 'different', owned: true, pinned: false, archived: false }] },
      { entries: [{ ...entry, owned: 'yes', pinned: false, archived: false }] },
      { entries: [{ ...entry, owned: true, pinned: 'yes', archived: false }] },
      { entries: [{ ...entry, owned: true, pinned: false, archived: 'yes' }] },
      { entries: [{ ...entry, owned: true, pinned: true, archived: true }] },
      { entries: [{ ...entry, owned: false, pinned: false, archived: true }] },
    ]
    for (const invalid of invalidResults) {
      invoke.mockResolvedValueOnce(invalid as never)
      await expect(executor.execute('session/collaborationMembership', payload, signal))
        .rejects.toThrow('invalid membership result')
    }
    invoke.mockResolvedValueOnce({ entries: [{ ...entry, owned: true, pinned: true, archived: false }] })
    await expect(executor.execute('session/collaborationMembership', payload, signal))
      .resolves.toEqual({ entries: [{ ...entry, owned: true, pinned: true, archived: false }] })
    invoke.mockResolvedValueOnce({ entries: [{ ...entry, owned: true, pinned: false, archived: true }] })
    await expect(executor.execute('session/collaborationMembership', payload, signal))
      .resolves.toEqual({ entries: [{ ...entry, owned: true, pinned: false, archived: true }] })
  })

  it('requires a private token, rejects forbidden endpoints and bounds input', async () => {
    const token = 'A'.repeat(43)
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiRequest(req, res, token, (endpoint, payload, signal) =>
        executor.execute(endpoint, payload, signal))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const request = { endpoint: 'session/list', payload: { args: { _request: {} } } }
      await expect(fetch(origin, { method: 'POST', headers: { cookie: 'dsh-auth=fake' }, body: JSON.stringify(request) })
        .then(response => response.status)).resolves.toBe(403)
      const headers = { authorization: `Bearer ${token}` }
      await expect(fetch(origin, { method: 'POST', headers, body: JSON.stringify({
        endpoint: 'session/prompt', payload: { args: {} },
      }) }).then(response => response.status)).resolves.toBe(422)
      await expect(fetch(origin, { method: 'POST', headers, body: 'x'.repeat(65_537) })
        .then(response => response.status)).resolves.toBe(422)
      const response = await fetch(origin, { method: 'POST', headers, body: JSON.stringify(request) })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ value: { items: [] } })
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })
})


it('REQ-20260930-0004: remote original Source feed pages one complete message inside the control frame', async () => {
  const original = { workspace_id:'11111111-1111-4111-8111-111111111111',session_id:'session-1',source_message_id:'message-1',source_revision:'1' }
  const first = { source:original,snapshot_digest:'a'.repeat(64),original_message:'@Guide · 项目一 '+ 'x'.repeat(30_000) }
  const second = { source:{ ...original,source_message_id:'message-2' },snapshot_digest:'b'.repeat(64),original_message:'y'.repeat(30_000) }
  const third = { source:{ ...original,source_message_id:'message-3' },snapshot_digest:'c'.repeat(64),original_message:'z'.repeat(30_000) }
  const invoke = vi.fn(async () => ({ items:[first,second,third] }))
  const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }),() => [])
  const signal = new AbortController().signal
  const request = { sessionId:'session-1' }
  await expect(executor.execute('session/collaborationSources',{ args:{ request } },signal)).resolves.toEqual({ items:[first],next_cursor:first.snapshot_digest })
  expect(invoke).toHaveBeenCalledWith({ namespace:'session',method:'collaborationSources',args:{ request },signal })
  invoke.mockResolvedValue({ items:[third] })
  await expect(executor.execute('session/collaborationSources',{ args:{ request:{ sessionId:'session-1',cursor:second.snapshot_digest } } },signal)).resolves.toEqual({ items:[third] })
  for (const args of [{},{ request:{ sessionId:'../other' } },{ request:{ sessionId:'session-1',cursor:'bad' } },
    { request:{ sessionId:'session-1',profile:'other' } },{ request,token:'other' }]) {
    await expect(executor.execute('session/collaborationSources',{ args },signal)).rejects.toThrow('invalid payload')
  }
  expect(invoke).toHaveBeenCalledTimes(2)
  invoke.mockResolvedValue({ items:[{ ...first,source:{ ...first.source,session_id:'other' } }] })
  await expect(executor.execute('session/collaborationSources',{ args:{ request } },signal)).rejects.toThrow('invalid Source page')
  invoke.mockResolvedValue({ items:[{ ...first,original_message:'x'.repeat(70_000) }] })
  await expect(executor.execute('session/collaborationSources',{ args:{ request } },signal)).rejects.toThrow('result too large')
})

it('Source locator forwards exact lookup and refuses a cursor or unrelated first item', async () => {
  const signal = new AbortController().signal
  const item = { source: { workspace_id: '11111111-1111-4111-8111-111111111111', session_id: 'session-1',
    source_message_id: 'message-1', source_revision: '1' },
  snapshot_digest: 'a'.repeat(64), original_message: '@Guide · Project original' }
  const invoke = vi.fn<() => Promise<unknown>>(async () => ({ items: [item] }))
  const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
  const args = { request: { sessionId: 'session-1', snapshotDigest: item.snapshot_digest } }
  await expect(executor.execute('session/collaborationSources', { args }, signal)).resolves.toEqual({ items: [item] })
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'collaborationSources', args, signal })
  for (const request of [{ ...args.request, cursor: item.snapshot_digest }, { ...args.request, snapshotDigest: 'bad' },
    { ...args.request, workspace_id: 'foreign' }]) {
    await expect(executor.execute('session/collaborationSources', { args: { request } }, signal)).rejects.toThrow('invalid payload')
  }
  for (const page of [{ items: [item], next_cursor: item.snapshot_digest }, { items: [item, item] },
    { items: [{ ...item, snapshot_digest: 'b'.repeat(64) }] }]) {
    invoke.mockResolvedValue(page)
    await expect(executor.execute('session/collaborationSources', { args }, signal)).rejects.toThrow('invalid Source page')
  }
})

it('forwards explicit timeline opt-in and retains validated complete positions through single-original remote paging', async () => {
  const item = { source: { workspace_id: '11111111-1111-4111-8111-111111111111', session_id: 'session-1',
    source_message_id: 'message-1', source_revision: '1' }, snapshot_digest: 'a'.repeat(64), original_message: '@Guide · Project original',
  timeline_position: { after_sequence: 5, local_order: '2' } }
  const invoke = vi.fn<() => Promise<unknown>>(async () => ({ items: [item, { ...item, snapshot_digest: 'b'.repeat(64) }] }))
  const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => []), signal = new AbortController().signal
  const args = { request: { sessionId: 'session-1', includeTimeline: true } }
  await expect(executor.execute('session/collaborationSources', { args }, signal)).resolves.toEqual({
    items: [item], next_cursor: item.snapshot_digest,
  })
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'collaborationSources', args, signal })
  for (const timeline_position of [null, { after_sequence: null, local_order: '9223372036854775807' }]) {
    invoke.mockResolvedValue({ items: [{ ...item, timeline_position }] })
    await expect(executor.execute('session/collaborationSources', { args }, signal)).resolves.toEqual({
      items: [{ ...item, timeline_position }],
    })
  }
  for (const includeTimeline of [false, null, 1, 'true']) {
    await expect(executor.execute('session/collaborationSources', { args: { request: { sessionId: 'session-1', includeTimeline } } }, signal))
      .rejects.toThrow('invalid payload')
  }
  for (const timeline_position of [undefined, {}, { after_sequence: -1, local_order: '2' },
    { after_sequence: 1.5, local_order: '2' }, { after_sequence: Number.MAX_SAFE_INTEGER + 1, local_order: '2' },
    { after_sequence: '5', local_order: '2' }, { after_sequence: 5, local_order: '0' },
    { after_sequence: 5, local_order: '9223372036854775808' }, { after_sequence: 5, local_order: 'bad' },
    { after_sequence: 5, local_order: 2 }, { after_sequence: 5, local_order: '2', message: 'private' }]) {
    invoke.mockResolvedValue({ items: [{ ...item, timeline_position }] })
    await expect(executor.execute('session/collaborationSources', { args }, signal)).rejects.toThrow('invalid Source page')
  }
  invoke.mockResolvedValue({ items: [item] })
  await expect(executor.execute('session/collaborationSources', { args: { request: { sessionId: 'session-1' } } }, signal))
    .rejects.toThrow('invalid Source page')
})

it('REQ-20260930-0004: an exhausted original Source feed has no continuation cursor', async () => {
  const invoke = vi.fn<() => Promise<unknown>>(async () => ({ items: [] }))
  const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
  const signal = new AbortController().signal
  const args = { request: { sessionId: 'session-1', cursor: 'a'.repeat(64) } }
  await expect(executor.execute('session/collaborationSources', { args }, signal))
    .resolves.toEqual({ items: [] })
  expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'collaborationSources', args, signal })
  invoke.mockResolvedValue({ items: [], next_cursor: 'b'.repeat(64) })
  await expect(executor.execute('session/collaborationSources', { args }, signal))
    .rejects.toThrow('invalid Source page')
})

it('REQ-20260930-0004: refuses unusable continuation cursors and malformed Source page envelopes', async () => {
  const invoke = vi.fn<() => Promise<unknown>>()
  const executor = new DesktopRemoteUiExecutor(gatewayFixture({ invoke }), () => [])
  const signal = new AbortController().signal
  for (const page of [null, { items: null }, { items: Array(9).fill({}) },
    { items: [], extra: true }, { items: [], next_cursor: 1 }, { items: [], next_cursor: 'bad' }]) {
    invoke.mockResolvedValue(page)
    await expect(executor.execute('session/collaborationSources',
      { args: { request: { sessionId: 'session-1' } } }, signal)).rejects.toThrow('invalid Source page')
  }
})
