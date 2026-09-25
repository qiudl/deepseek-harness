import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest } from '../src/desktop-remote-ui.ts'
import { DesktopRemoteUiStreamExecutor, handleDesktopRemoteUiStreamRequest,
  writeDesktopRemoteUiStreamLine } from '../src/desktop-remote-ui-stream.ts'
import { rejectDesktopRemotePrivateRequest, writeDesktopRemotePrivateResult } from '../src/desktop-remote-private-request.ts'

describe('Desktop remote UI read-only bridge', () => {
  it('does not rewrite ended private responses and bounds JSON results', () => {
    const ended = { writableEnded: true, destroyed: false, writeHead: vi.fn() }
    rejectDesktopRemotePrivateRequest(ended as unknown as ServerResponse)
    expect(ended.writeHead).not.toHaveBeenCalled()
    const destroyed = { writableEnded: false, destroyed: true, writeHead: vi.fn() }
    rejectDesktopRemotePrivateRequest(destroyed as unknown as ServerResponse)
    expect(destroyed.writeHead).not.toHaveBeenCalled()
    expect(() => writeDesktopRemotePrivateResult(ended as unknown as ServerResponse, 'x'.repeat(512 * 1024)))
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
    }) as unknown as IncomingMessage
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
    await handleDesktopRemoteUiStreamRequest(request(['not bytes']), invalid as unknown as ServerResponse,
      token, async () => { throw new Error('unexpected open') })
    expect(invalid.status).toBe(422)

    const disconnected = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), disconnected as unknown as ServerResponse,
      token, async () => (async function* () { disconnected.emit('close') })())
    expect(disconnected.status).toBe(200)
    expect(disconnected.write).not.toHaveBeenCalled()
    expect(disconnected.writableEnded).toBe(false)

    const destroyed = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), destroyed as unknown as ServerResponse,
      token, async () => { destroyed.destroy(); throw new Error('closed') })
    expect(destroyed.status).toBe(0)

    const ended = response()
    await handleDesktopRemoteUiStreamRequest(request([body]), ended as unknown as ServerResponse,
      token, async () => { ended.end(); throw new Error('ended') })
    expect(ended.status).toBe(0)

    const failed = response()
    failed.write.mockImplementation(() => { throw new Error('write failed') })
    await handleDesktopRemoteUiStreamRequest(request([body]), failed as unknown as ServerResponse,
      token, async () => (async function* () { throw new Error('gateway failed') })())
    expect(failed.status).toBe(200)
    expect(failed.destroyed).toBe(true)
  })

  it('bounds NDJSON events and waits for writer drain or close', async () => {
    const writer = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn> }
    writer.write = vi.fn(() => true)
    const res = writer as unknown as ServerResponse
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

  it('opens only a bounded native Session follow request', async () => {
    const stream = vi.fn(async () => (async function* () { yield { type: 'snapshot' } })())
    const executor = new DesktopRemoteUiStreamExecutor({ stream } as unknown as TypertGateway)
    const signal = new AbortController().signal
    const payload = { args: { request: { address: { kind: 'session', sessionId: 'session-1' },
      maxMessages: 50, assistantStream: true } } }
    const opened = await executor.open('session/follow', payload, signal)
    const iterator = opened[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: { type: 'snapshot' }, done: false })
    expect(stream).toHaveBeenCalledWith({ namespace: 'session', method: 'follow', args: payload.args, signal })
    await expect(executor.open('session/prompt', payload, signal)).rejects.toThrow('endpoint denied')
    await expect(executor.open('session/follow', { args: { request: { address: {
      kind: 'session', sessionId: '' } } } }, signal)).rejects.toThrow('invalid payload')
    expect(stream).toHaveBeenCalledOnce()
    for (const invalid of [null, {}, { args: null }, { args: {} }, { args: { request: null } },
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
  it('dispatches only the exact M1 read endpoints with named Remote arguments', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const boot = vi.fn(() => [{ kind: 'script' as const, placement: 'head' as const, text: 'boot()' }])
    const executor = new DesktopRemoteUiExecutor({ invoke } as unknown as TypertGateway, boot)
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
      'credentials/describe', 'permissionPresets/catalog']) {
      const args = endpoint === 'credentials/describe' ? { refs: ['OPENAI_API_KEY'] } : {}
      await expect(executor.execute(endpoint, { args }, signal)).resolves.toEqual({ items: [] })
      const [namespace, method] = endpoint.split('/')
      expect(invoke).toHaveBeenCalledWith({ namespace, method, args, signal })
    }
    await expect(executor.execute('credentials/describe', { args: { refs: ['bad-ref'] } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('settings/describe', { args: { path: '/private' } }, signal))
      .rejects.toThrow('invalid payload')
    for (const endpoint of ['session/prompt', 'session/delete', 'workspace/create', 'llm/listProviders', '$events/result']) {
      await expect(executor.execute(endpoint, { args: {} }, signal)).rejects.toThrow('endpoint denied')
    }
    await expect(executor.execute('dynamicCordisRunner/syncInspectManifest', { args: {} }, signal))
      .rejects.toThrow('endpoint denied')
    expect(invoke).toHaveBeenCalledTimes(6)
  })

  it('requires a private token, rejects forbidden endpoints and bounds input', async () => {
    const token = 'A'.repeat(43)
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteUiExecutor({ invoke } as unknown as TypertGateway, () => [])
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
