import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { encodeDesktopRemoteUiStreamItem, handleDesktopRemoteUiStreamRequest } from '../src/desktop-remote-ui-stream.ts'
import { openRemoteUiWorkerStream } from '../../../host/desktop-host/src/remote-ui-stream-client.ts'
import { RemoteUiStreamCursor } from '../../../host/desktop-host/src/remote-ui-stream-cursor.ts'

interface TestChunk {
  type: string
  offset: number
  totalBytes: number
  uncompressedBytes: number
  encoding: string
  bytes: string
}

const compression = vi.hoisted(() => ({ identity: false }))
vi.mock('node:zlib', async (original) => {
  const actual = await original<typeof import('node:zlib')>()
  return { ...actual, gzip: (input: Buffer, callback: (error: Error | null, result: Buffer) => void) => {
    if (compression.identity) queueMicrotask(() => { callback(null, input) })
    else actual.gzip(input, callback)
  } }
})

describe('REQ-20260930-0015 complete history transport', () => {
  it('crosses real authenticated HTTP, private reader and unchanged 512 KiB Host cursor intact', async () => {
    const original = { type: 'snapshot', records: [{ text: randomBytes(600000).toString('base64') + '原会话🌟' }] }
    const token = 'A'.repeat(43)
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiStreamRequest(req, res, token, async () => (async function* () { yield original })())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('missing test listener')
    const origin = `http://127.0.0.1:${address.port}`
    const payload = { args: { request: { address: { kind: 'session', sessionId: 'original-test-session' } } } }
    for (const body of [{ endpoint: 'workspace/follow', payload: { args: {} }, itemChunks: true },
      { endpoint: 'session/follow', payload, itemChunks: false },
      { endpoint: 'session/follow', payload, itemChunks: true, path: '/private' }]) {
      const refused = await fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
      expect(refused.status).toBe(422)
      await refused.text()
    }
    const cursor = await RemoteUiStreamCursor.open(signal => openRemoteUiWorkerStream(origin, token,
      'session/follow', payload, signal, () => false, true))
    onTestFinished(() => cursor.close())
    const itemParts: Buffer[] = [], packedParts: Buffer[] = []
    let total = 0
    for (;;) {
      const part = cursor.poll()
      if (part.type === 'idle') { await new Promise(resolve => setImmediate(resolve)); continue }
      if (part.type === 'end') break
      expect(part.type).toBe('chunk')
      if (part.type !== 'chunk') throw Error('private cursor failed')
      itemParts.push(Buffer.from(part.bytes, 'base64url'))
      if (!part.final) continue
      const item = JSON.parse(Buffer.concat(itemParts).toString()) as { type: string; offset: number; bytes: string }
      itemParts.length = 0
      expect(item.type).toBe('item-chunk')
      expect(item.offset).toBe(total)
      const bytes = Buffer.from(item.bytes, 'base64url')
      total += bytes.length; packedParts.push(bytes)
    }
    expect(JSON.parse(gunzipSync(Buffer.concat(packedParts)).toString())).toEqual(original)
  })

  it('preserves a snapshot across the old 512 KiB boundary in bounded private frames', async () => {
    for (const text of ['原会话🌟'.repeat(60000), randomBytes(600000).toString('base64')]) {
      const original = { type: 'snapshot', cursor: 153, records: [{ text }] }
      const frames = []
      for await (const frame of encodeDesktopRemoteUiStreamItem(original, true, new AbortController().signal)) frames.push(frame)
      const chunks = frames.map(frame => frame.value as TestChunk)
      expect(chunks.length).toBeGreaterThan(0)
      let offset = 0
      const parts = chunks.map((chunk) => {
        expect(chunk.type).toBe('item-chunk')
        expect(chunk.offset).toBe(offset)
        expect(Buffer.byteLength(JSON.stringify({ type: 'item', value: chunk }) + '\n')).toBeLessThan(16384)
        const bytes = Buffer.from(chunk.bytes, 'base64url')
        offset += bytes.length
        return bytes
      })
      expect(offset).toBe(chunks[0]!.totalBytes)
      const packed = Buffer.concat(parts)
      const raw = chunks[0]!.encoding === 'gzip' ? gunzipSync(packed) : packed
      expect(raw.length).toBe(chunks[0]!.uncompressedBytes)
      expect(JSON.parse(raw.toString())).toEqual(original)
    }
  })

  it('keeps small and legacy items unchanged and rejects overflow and cancellation', async () => {
    const small = { type: 'event', seq: 2 }
    const collect = async (value: unknown, enabled: boolean, signal = new AbortController().signal) => {
      const frames = []
      for await (const frame of encodeDesktopRemoteUiStreamItem(value, enabled, signal)) frames.push(frame)
      return frames
    }
    expect(await collect(small, true)).toEqual([{ type: 'item', value: small }])
    expect(await collect(small, false)).toEqual([{ type: 'item', value: small }])
    await expect(collect({ text: 'x'.repeat(524527) }, false)).rejects.toThrow('too large')
    await expect(collect({ text: 'x'.repeat(8 * 1024 * 1024) }, true)).rejects.toThrow('too large')
    const controller = new AbortController()
    controller.abort()
    await expect(collect(small, true, controller.signal)).rejects.toThrow()
    await expect(collect(undefined, true)).rejects.toThrow()
  })

  it('falls back to identity without widening frames and aborts during compression or fragment delivery', async () => {
    const original = { text: 'x'.repeat(600000) }
    const cancelled = new AbortController()
    const pending = encodeDesktopRemoteUiStreamItem(original, true, cancelled.signal).next()
    cancelled.abort()
    await expect(pending).rejects.toThrow()
    compression.identity = true
    try {
      const abort = new AbortController()
      const iterator = encodeDesktopRemoteUiStreamItem(original, true, abort.signal)
      const first = await iterator.next()
      if (first.done) throw Error('missing identity fragment')
      expect(first.value.value).toMatchObject({ encoding: 'identity', offset: 0 })
      abort.abort()
      await expect(iterator.next()).rejects.toThrow()
    } finally { compression.identity = false }
  })
})
