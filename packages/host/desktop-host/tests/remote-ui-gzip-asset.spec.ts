import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'

describe('lease-owned compressed plugin assets', () => {
  it.each([Buffer.from('registered();'.repeat(100_000)), randomBytes(100_000), Buffer.alloc(12 * 1024 * 1024, 65), Buffer.alloc(0)])(
    'reassembles compressed assets and rechecks cached-read authority (%#)', async (body) => {
      const asset = '/plugins/a.js'
      let authorized = true
      let assetReads = 0
      let bootReads = 0
      // Each authorization probe uses a fresh fixture socket: exhaustive CI may
      // pause beyond the HTTP server idle timeout between gzip fault assertions.
      const server = createServer((request, response) => {
        response.setHeader('connection', 'close')
        if (request.url === '/internal/desktop-remote-ui') {
          bootReads += 1
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            value: { injections: authorized ? [{ kind: 'script-src', src: asset }] : [] },
          }))
        } else {
          assetReads += 1
          response.writeHead(200, { 'content-type': 'text/javascript' }).end(body)
        }
      })
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
      const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath })
      const read = Reflect.get(factory, 'remoteUiAssetRead') as (
        origin: string, cookie: { name: string; value: string }, token: string,
        endpoint: string, payload: unknown, signal: AbortSignal, stopped: () => boolean,
        cache: object,
      ) => Promise<{ bytes: string; total: number; uncompressedBytes: number; encoding: string }>
      const cache: { entries?: Map<string, Promise<{ url: string; bytes: Buffer; gzip?: Promise<Buffer> }>> } = {}
      const signal = new AbortController().signal
      const chunk = (offset: number, stopped = () => false, selectedSignal = signal) => read.call(factory,
        `http://127.0.0.1:${address.port}`, { name: 'cookie', value: 'private' }, 'token',
        'asset/read-gzip-chunk', { args: { url: asset, offset } }, selectedSignal, stopped, cache)
      const first = await chunk(0)
      expect(first.encoding).toBe('gzip')
      expect(first.uncompressedBytes).toBe(body.byteLength)
      expect(first.total).toBeLessThanOrEqual(body.byteLength + 64 * 1024)
      expect(Buffer.from(first.bytes, 'base64url').byteLength).toBeLessThanOrEqual(24 * 1024)
      const chunks = [Buffer.from(first.bytes, 'base64url')]
      for (let offset = chunks[0]!.byteLength; offset < first.total;) {
        const next = await chunk(offset)
        const bytes = Buffer.from(next.bytes, 'base64url')
        expect(bytes.byteLength).toBeGreaterThan(0)
        expect(bytes.byteLength).toBeLessThanOrEqual(24 * 1024)
        chunks.push(bytes)
        offset += bytes.byteLength
      }
      expect(gunzipSync(Buffer.concat(chunks)).equals(body)).toBe(true)
      expect(assetReads).toBe(1)
      const concurrent = await Promise.all([chunk(0), chunk(0)])
      expect(concurrent).toEqual([first, first])
      expect(bootReads).toBeGreaterThanOrEqual(3)
      await expect(chunk(first.total + 1)).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(chunk(0, () => true)).rejects.toMatchObject({ code: 'unavailable' })
      authorized = false
      await expect(chunk(0)).rejects.toMatchObject({ code: 'invalid_input' })
      expect(assetReads).toBe(1)
      authorized = true
      let stopCalls = 0
      await expect(chunk(0, () => ++stopCalls >= 4)).rejects.toMatchObject({ code: 'unavailable' })
      const entry = await cache.entries?.get(asset)
      if (!entry) throw new Error('Expected a cached asset')
      const entries = cache.entries!
      const getEntry = entries.get.bind(entries)
      type CachedEntry = NonNullable<typeof entry>
      let releaseCached!: (value: CachedEntry) => void
      const heldEntry = new Promise<CachedEntry>((resolve) => { releaseCached = resolve })
      let joinedCached!: () => void
      const joined = new Promise<void>((resolve) => { joinedCached = resolve })
      entries.get = (url) => {
        if (url !== asset) return getEntry(url)
        joinedCached()
        return heldEntry
      }
      let workerClosed = false
      const closedRead = expect(chunk(0, () => workerClosed)).rejects.toMatchObject({ code: 'unavailable' })
      await joined
      workerClosed = true
      releaseCached(entry)
      await closedRead
      entries.get = getEntry
      const failed = Promise.reject<Buffer>(new Error('compression failed'))
      void failed.catch(() => {}) // The fault is consumed after asynchronous boot authorization.
      entry.gzip = failed
      await expect(chunk(0)).rejects.toThrow('compression failed')
      expect(entry.gzip).toBeUndefined()
      await expect(chunk(0)).resolves.toEqual(first)
      entry.gzip = Promise.resolve(Buffer.alloc(16 * 1024 * 1024 + 64 * 1024 + 1))
      await expect(chunk(0)).rejects.toMatchObject({ code: 'unavailable' })
      delete entry.gzip
      let rejectCompression!: (error: Error) => void
      const obsolete = new Promise<Buffer>((_resolve, reject) => { rejectCompression = reject })
      entry.gzip = obsolete
      let observed!: () => void
      const enteredCompression = new Promise<void>((resolve) => { observed = resolve })
      let checks = 0
      const late = chunk(0, () => { if (++checks === 3) observed(); return false })
      await enteredCompression
      const replacement = Promise.resolve(gzipSync(body))
      entry.gzip = replacement
      rejectCompression(new Error('obsolete compression failed'))
      await expect(late).rejects.toThrow('obsolete compression failed')
      expect(entry.gzip).toBe(replacement)
      const aborted = new AbortController()
      aborted.abort()
      await expect(chunk(0, () => false, aborted.signal)).rejects.toThrow()
    })
})
