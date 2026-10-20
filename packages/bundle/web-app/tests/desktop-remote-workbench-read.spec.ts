import { describe, expect, it, vi } from 'vitest'
import { parseWorkbenchReadPayload } from '@deepseek-ai/dsh-host-control-protocol'
import { readDesktopWorkbenchResponse } from '../src/desktop-remote-workbench-read.ts'

function payload() {
  return parseWorkbenchReadPayload({ args: { endpoint: 'workspaceFiles/readBytes', rpcId: 'rpc-1',
    args: { workspaceFileScopeId: 'session-1', path: 'image.png', options: {} } } })!
}
async function collect(source: AsyncIterable<unknown>) {
  const result: unknown[] = []
  for await (const value of source) result.push(value)
  return result
}
describe('native file response stream', () => {
  it('retains exact multipart bytes, endpoint, RPC identity and bounded chunk offsets', async () => {
    const binary = new Uint8Array(64 * 1024).fill(183)
    const form = new FormData()
    form.set('bytes-0', new Blob([binary]))
    form.set('metadata', JSON.stringify({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { data: null } },
      attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }] }))
    const response = new Response(form)
    const expected = Buffer.from(await response.clone().arrayBuffer())
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('http://localhost/api/workspaceFiles/readBytes')
      expect(request.method).toBe('POST')
      expect(await request.json()).toEqual({ type: 'client-request', rpcId: 'rpc-1', method: 'workspaceFiles/readBytes', payload: { args: payload().args.args } })
      return response
    })
    const items = await collect(readDesktopWorkbenchResponse(fetch, payload(), new AbortController().signal))
    expect(items[0]).toEqual({ type: 'head', contentType: response.headers.get('content-type') })
    const parts: Buffer[] = []
    let offset = 0
    for (const item of items.slice(1, -1)) {
      const chunk = item as { type: string; bytes: string; offset: number }
      expect(chunk.type).toBe('bytes'); expect(chunk.offset).toBe(offset)
      const bytes = Buffer.from(chunk.bytes, 'base64url')
      expect(bytes.length).toBeLessThanOrEqual(16 * 1024)
      offset += bytes.length; parts.push(bytes)
    }
    expect(Buffer.concat(parts).equals(expected)).toBe(true)
    expect(items.at(-1)).toEqual({ type: 'complete', totalBytes: expected.length })
  })
  it('cancels the owned reader on disposal and refuses invalid or oversized responses', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel })
    const source = readDesktopWorkbenchResponse(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }), payload(), new AbortController().signal)
    await source.next(); await source.return(undefined)
    expect(cancel).toHaveBeenCalledOnce()
    for (const response of [new Response(null), new Response('bad', { status: 403 }),
      new Response('bad', { headers: { 'content-type': 'text/html' } }),
      new Response('bad', { headers: { 'content-type': 'a'.repeat(257) } }),
      new Response(new Uint8Array(34 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })]) {
      await expect(collect(readDesktopWorkbenchResponse(async () => response, payload(), new AbortController().signal))).rejects.toThrow()
    }
    const abort = new AbortController(); abort.abort()
    const fetch = vi.fn(async () => Response.json({}))
    await expect(collect(readDesktopWorkbenchResponse(fetch, payload(), abort.signal))).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})
