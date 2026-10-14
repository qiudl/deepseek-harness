import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'

describe('lease-owned plugin asset caching', () => {
  it('keeps a shared download alive when its first reader is cancelled', async () => {
    let releaseAsset!: () => void
    const held = new Promise<void>((resolve) => { releaseAsset = resolve })
    let assetStarted!: () => void
    const started = new Promise<void>((resolve) => { assetStarted = resolve })
    let secondJoined!: () => void
    const joined = new Promise<void>((resolve) => { secondJoined = resolve })
    let downloads = 0
    const server = createServer((request, response) => {
      response.setHeader('connection', 'close')
      if (request.url === '/internal/desktop-remote-ui') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          value: { injections: [{ kind: 'script-src', src: '/plugins/shared.js' }] },
        }))
        return
      }
      downloads += 1
      assetStarted()
      void held.then(() => { response.writeHead(200, { 'content-type': 'text/javascript' }).end('shared();') })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(async () => {
      releaseAsset()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
    const factory = new DshWebProfileWorkerFactory({ nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath })
    const read = Reflect.get(factory, 'remoteUiAssetRead') as (
      origin: string, cookie: { name: string; value: string }, token: string,
      endpoint: string, payload: unknown, signal: AbortSignal, stopped: () => boolean,
      cache: object,
    ) => Promise<{ bytes: string }>
    const entries = new Map<string, Promise<object>>()
    const getEntry = entries.get.bind(entries)
    entries.get = (key) => {
      const entry = getEntry(key)
      if (entry) secondJoined()
      return entry
    }
    const cache = { entries }
    const chunk = (signal: AbortSignal) => read.call(factory, `http://127.0.0.1:${address.port}`,
      { name: 'cookie', value: 'private' }, 'token', 'asset/read',
      { args: { url: '/plugins/shared.js', offset: 0 } }, signal, () => false, cache)
    const firstController = new AbortController()
    const first = chunk(firstController.signal)
    const rejected = expect(first).rejects.toBeDefined()
    await started
    const second = chunk(new AbortController().signal)
    const secondResult = second.then(value => ({ value }), (error: unknown) => ({ error }))
    await joined
    firstController.abort()
    releaseAsset()
    await rejected
    await expect(secondResult).resolves.toHaveProperty('value.bytes', Buffer.from('shared();').toString('base64url'))
    expect(downloads).toBe(1)
  })

  it('shares concurrent reads across assets and rechecks revoked injections', async () => {
    const bodies = new Map([
      ['/plugins/a.js', Buffer.from('a();'.repeat(10_000))],
      ['/plugins/b.js', Buffer.from('b();'.repeat(10_000))],
    ])
    const reads = new Map<string, number>()
    let revoked = false
    let failNextAsset = false
    const server = createServer((request, response) => {
      response.setHeader('connection', 'close')
      if (request.url === '/internal/desktop-remote-ui') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          value: { injections: revoked ? [] : [...bodies.keys()].map(src => ({ kind: 'script-src', src })) },
        }))
        return
      }
      const url = request.url!
      reads.set(url, (reads.get(url) ?? 0) + 1)
      if (failNextAsset) { failNextAsset = false; response.writeHead(503).end(); return }
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(bodies.get(url))
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
    const cache: { entries?: Map<string, Promise<object>> } = {}
    const chunk = (url: string) => read.call(factory, `http://127.0.0.1:${address.port}`,
      { name: 'cookie', value: 'private' }, 'token', 'asset/read-gzip-chunk',
      { args: { url, offset: 0 } }, new AbortController().signal, () => false, cache)
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => chunk(index % 2 ? '/plugins/a.js' : '/plugins/b.js')))
    for (const [index, result] of results.entries()) {
      expect(gunzipSync(Buffer.from(result.bytes, 'base64url'))).toEqual(bodies.get(index % 2 ? '/plugins/a.js' : '/plugins/b.js'))
    }
    await chunk('/plugins/a.js')
    await chunk('/plugins/b.js')
    expect(reads.get('/plugins/a.js')).toBe(1)
    expect(reads.get('/plugins/b.js')).toBe(1)
    for (const url of ['/plugins/c.js', '/plugins/d.js', '/plugins/e.js']) {
      bodies.set(url, Buffer.from('registered();'))
      await chunk(url)
    }
    expect(cache.entries?.size).toBe(4)
    await chunk('/plugins/b.js')
    expect(reads.get('/plugins/b.js')).toBe(1)
    await chunk('/plugins/a.js')
    expect(reads.get('/plugins/a.js')).toBe(2)
    bodies.set('/plugins/f.js', Buffer.from('retry();'))
    failNextAsset = true
    await expect(chunk('/plugins/f.js')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(chunk('/plugins/f.js')).resolves.toMatchObject({ encoding: 'gzip' })
    expect(reads.get('/plugins/f.js')).toBe(2)
    expect(cache.entries?.size).toBe(4)
    revoked = true
    await expect(chunk('/plugins/a.js')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(reads.get('/plugins/a.js')).toBe(2)
  })
})
