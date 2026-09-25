import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { openRemoteUiWorkerStream } from '../src/remote-ui-stream-client.ts'

async function serve(lines: string, status = 200, contentType = 'application/x-ndjson'): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': contentType }).end(lines)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('Host worker follow stream client', () => {
  it('projects only bounded item frames until an explicit end', async () => {
    const origin = await serve('{"type":"item","value":{"cursor":1}}\n{"type":"end"}\n')
    const values: unknown[] = []
    for await (const value of openRemoteUiWorkerStream(origin, 'private', 'session/follow',
      { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } },
      new AbortController().signal, () => false)) values.push(value)
    expect(values).toEqual([{ cursor: 1 }])
  })

  it.each([
    '{"type":"item","value":1}\n',
    '{"type":"error","code":"dsh_host_unavailable"}\n',
    '{"type":"item","value":1,"extra":true}\n{"type":"end"}\n',
    'x'.repeat(512 * 1024 + 1),
    'null\n',
    '{"type":"end","extra":true}\n',
    '{"type":"end"}\n{"type":"item","value":1}\n',
    '{"type":"item","value":1}\n{"type":"end","extra":true}\n',
    '{"type":"item"}\n{"type":"end"}\n',
    '{"type":"item","value":1}\n' + 'x'.repeat(512 * 1024 + 1),
    'x'.repeat(512 * 1024 + 1) + '\n',
  ])('rejects incomplete, failed, malformed, or oversized streams', async (body) => {
    const origin = await serve(body)
    const read = async () => {
      for await (const _value of openRemoteUiWorkerStream(origin, 'private', 'session/follow',
        { args: { request: { address: { kind: 'session', sessionId: 'session-1' } } } },
        new AbortController().signal, () => false)) { /* consume */ }
    }
    await expect(read()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects stopped workers, wrong endpoints, HTTP failures, and missing NDJSON bodies', async () => {
    const healthy = await serve('{"type":"end"}\n')
    const failed = await serve('failed', 503)
    const wrongType = await serve('{"type":"end"}\n', 200, 'text/plain')
    const noBody = await serve('', 204)
    const read = async (origin: string, endpoint: string, stopped: () => boolean) => {
      for await (const _value of openRemoteUiWorkerStream(origin, 'private', endpoint,
        { args: {} }, new AbortController().signal, stopped)) { /* consume */ }
    }
    for (const [origin, endpoint, stopped] of [
      [healthy, 'session/follow', () => true], [healthy, 'session/prompt', () => false],
      [failed, 'session/follow', () => false], [wrongType, 'session/follow', () => false],
      [noBody, 'session/follow', () => false],
    ] as const) await expect(read(origin, endpoint, stopped)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects cancellation after an item and releases the HTTP reader', async () => {
    const origin = await serve('{"type":"item","value":1}\n{"type":"end"}\n')
    const controller = new AbortController()
    const iterator = openRemoteUiWorkerStream(origin, 'private', 'session/follow', { args: {} },
      controller.signal, () => false)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 })
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects a worker stopping between two event reads', async () => {
    const origin = await serve('{"type":"item","value":1}\n')
    let checks = 0
    const iterator = openRemoteUiWorkerStream(origin, 'private', 'session/follow', { args: {} },
      new AbortController().signal, () => ++checks === 3)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 1 })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('releases a reader even when its closed transport rejects cancellation', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"type":"end"}\n')) },
      cancel() { throw new Error('already closed') },
    })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {
      status: 200, headers: { 'content-type': 'application/x-ndjson' },
    }))
    try {
      const values: unknown[] = []
      for await (const value of openRemoteUiWorkerStream('http://127.0.0.1:1', 'private', 'session/follow',
        { args: {} }, new AbortController().signal, () => false)) values.push(value)
      expect(values).toEqual([])
    } finally { fetcher.mockRestore() }
  })
})
