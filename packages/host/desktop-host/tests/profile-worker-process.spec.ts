import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DshWebProfileWorkerFactory, ProfileWorkerProcessFactory } from '../src/index.ts'
import type { ChildProcess } from 'node:child_process'
import type { ProfileWorkerHandle } from '../src/types.ts'

function fixture(source: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-worker-')), 'worker.mjs')
  writeFileSync(path, source, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

const spec = (root: string) => ({
  profileId: 'profile-1',
  profileRoot: root,
  credentialHandle: 'keychain:profile-1',
  pluginRoots: [join(root, 'plugins')],
  env: {},
})

class ControlledChild extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly kill = () => true
  readonly send = (_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true }
}

function controlledWebChild(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill(signal?: string | number): boolean
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill(signal?: string | number): boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  return child
}

async function readyHandle(child: ControlledChild): Promise<ProfileWorkerHandle> {
  const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => [] })
  const pending = (factory as unknown as { readyHandle(child: ChildProcess): Promise<ProfileWorkerHandle> })
    .readyHandle(child as unknown as ChildProcess)
  child.emit('message', { type: 'ready' })
  return await pending
}

describe('profile worker child process', () => {
  it('rejects malformed remote responses and stopped reads at the private Host boundary', async () => {
    let status = 200
    let value = JSON.stringify({ value: { items: [] } })
    const server = createServer((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(value)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
    const origin = `http://127.0.0.1:${address.port}`
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    }) as unknown as {
      remoteSession(origin: string, token: string, command: object, signal: AbortSignal,
        stopped: () => boolean): Promise<unknown>
      remoteUiRead(origin: string, token: string, endpoint: string, payload: object,
        signal: AbortSignal, stopped: () => boolean): Promise<unknown>
    }
    const signal = new AbortController().signal
    const readers = [
      (stopped: () => boolean) => factory.remoteSession(origin, 'token', { operation: 'session.list' }, signal, stopped),
      (stopped: () => boolean) => factory.remoteUiRead(origin, 'token', 'session/list', { args: {} }, signal, stopped),
    ]
    for (const read of readers) {
      await expect(read(() => true)).rejects.toMatchObject({ code: 'unavailable' })
      status = 503
      await expect(read(() => false)).rejects.toMatchObject({ code: 'unavailable' })
      status = 200
      value = 'x'.repeat(512 * 1024 + 1)
      await expect(read(() => false)).rejects.toMatchObject({ code: 'unavailable' })
      value = 'not-json'
      await expect(read(() => false)).rejects.toMatchObject({ code: 'unavailable' })
      for (const malformed of ['null', '[]', '{}', '{"value":null,"extra":true}']) {
        value = malformed
        await expect(read(() => false)).rejects.toMatchObject({ code: 'unavailable' })
      }
      value = JSON.stringify({ value: { items: [] } })
      await expect(read(() => false)).resolves.toEqual({ items: [] })
    }
  })

  it('fences plugin asset reads to boot-injected scripts and a live Host lease', async () => {
    const asset = '/plugins/??a/client.js&rev=1'
    let bootValue: unknown = { injections: [{ kind: 'script-src', src: asset }] }
    const server = createServer((request, response) => {
      if (request.url === '/internal/desktop-remote-ui') {
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ value: bootValue }))
      } else {
        response.writeHead(200, { 'content-type': 'text/javascript' }).end('registered();')
      }
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
    const origin = `http://127.0.0.1:${address.port}`
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    }) as unknown as {
      remoteUiAssetRead(origin: string, cookie: { name: string; value: string }, token: string,
        payload: unknown, signal: AbortSignal, stopped: () => boolean,
        cache: { current?: { url: string; bytes: Buffer } }): Promise<unknown>
    }
    const signal = new AbortController().signal
    const read = (payload: unknown, stopped: () => boolean = () => false,
      cache: { current?: { url: string; bytes: Buffer } } = {}, selectedSignal = signal) =>
      factory.remoteUiAssetRead(origin, { name: 'cookie', value: 'private' }, 'token',
        payload, selectedSignal, stopped, cache)
    for (const payload of [null, {}, { args: null }, { args: { url: 'http://[', offset: 0 } }]) {
      await expect(read(payload)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    bootValue = null
    await expect(read({ args: { url: asset, offset: 0 } })).rejects.toMatchObject({ code: 'unavailable' })
    bootValue = { injections: [] }
    await expect(read({ args: { url: asset, offset: 0 } })).rejects.toMatchObject({ code: 'invalid_input' })
    bootValue = { injections: [{ kind: 'script-src', src: asset }] }
    let calls = 0
    await expect(read({ args: { url: asset, offset: 0 } }, () => ++calls === 2))
      .rejects.toMatchObject({ code: 'unavailable' })
    calls = 0
    await expect(read({ args: { url: asset, offset: 0 } }, () => ++calls === 3))
      .rejects.toMatchObject({ code: 'unavailable' })
    const cache = { current: { url: asset, bytes: Buffer.from('registered();') } }
    calls = 0
    await expect(read({ args: { url: asset, offset: 0 } }, () => ++calls === 3, cache))
      .rejects.toMatchObject({ code: 'unavailable' })
    const aborted = new AbortController()
    calls = 0
    await expect(read({ args: { url: asset, offset: 0 } }, () => {
      if (++calls === 3) aborted.abort()
      return false
    }, cache, aborted.signal)).rejects.toMatchObject({ code: 'unavailable' })
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const requestUrl = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (requestUrl !== `${origin}${asset}`) return originalFetch(input, init)
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('asset stream failed')) },
        cancel() { throw new Error('cancel failed') },
      }), { status: 200, headers: { 'content-type': 'text/javascript' } }))
    })
    onTestFinished(() => { fetchSpy.mockRestore() })
    await expect(read({ args: { url: asset, offset: 0 } })).rejects.toThrow('asset stream failed')
  })

  it('rejects every malformed executable and Profile-owned launch field', async () => {
    expect(() => { new ProfileWorkerProcessFactory({ executablePath: 'node', arguments: () => [] }) }).toThrow()
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => ['--version'] })
    for (const invalid of [
      { ...spec(root), profileId: '' },
      { ...spec(root), profileId: 'p'.repeat(129) },
      { ...spec(root), profileRoot: 'relative' },
      { ...spec(root), credentialHandle: '' },
      { ...spec(root), credentialHandle: 'c'.repeat(513) },
      { ...spec(root), pluginRoots: ['relative'] },
    ]) {
      await expect(factory.create(invalid)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('rejects a child that exits, errors, or stays silent before exact readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const silent = fixture('setInterval(() => {}, 1000)')
    const timed = new ProfileWorkerProcessFactory({
      executablePath: process.execPath, arguments: () => [silent], readyTimeoutMs: 25,
    })
    await expect(timed.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })

    const cleanExit = fixture('process.exit(0)')
    const exited = new ProfileWorkerProcessFactory({
      executablePath: process.execPath, arguments: () => [cleanExit], readyTimeoutMs: 25,
    })
    await expect(exited.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })

    const missing = new ProfileWorkerProcessFactory({
      executablePath: join(root, 'missing-node'), arguments: () => [], readyTimeoutMs: 100,
    })
    await expect(missing.create(spec(root))).rejects.toThrow()
  })

  it('ignores malformed IPC messages and force-kills a ready child that refuses shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const script = fixture(`
      process.send(null)
      process.send([])
      process.send({ type: 'ready', extra: true })
      process.send({ type: 'ready' })
      process.on('message', () => {})
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `)
    const factory = new ProfileWorkerProcessFactory({
      executablePath: process.execPath, arguments: () => [script], abortTimeoutMs: 25,
    })
    const worker = await factory.create(spec(root))
    worker.abort()
    worker.abort()
    await expect(worker.done).resolves.toBeUndefined()
    worker.abort()
  })

  it('falls back to SIGTERM when a ready child closes its IPC channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const script = fixture(`
      process.send({ type: 'ready' }, () => {
        process.disconnect()
        setInterval(() => {}, 1000)
      })
    `)
    const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => [script] })
    const worker = await factory.create(spec(root))
    await new Promise(resolve => setTimeout(resolve, 25))
    worker.abort()
    await expect(worker.done).resolves.toBeUndefined()
  })

  it('settles done once when child error and exit events arrive out of order', async () => {
    const exited = new ControlledChild()
    const clean = await readyHandle(exited)
    exited.emit('exit', 0, null)
    exited.emit('error', new Error('late error'))
    await expect(clean.done).resolves.toBeUndefined()

    const errored = new ControlledChild()
    const failed = await readyHandle(errored)
    const rejection = expect(failed.done).rejects.toThrow('first error')
    errored.emit('error', new Error('first error'))
    errored.emit('exit', 1, null)
    await rejection
  })

  it('starts with a scrubbed explicit environment and reaches quiescence on abort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    const script = fixture(`
      if (process.env.DSH_TEST_SECRET) process.exit(91)
      if (process.cwd() !== process.env.DSH_PROFILE_ROOT) process.exit(92)
      process.send({ type: 'ready' })
      process.on('message', message => { if (message?.type === 'shutdown') process.exit(0) })
    `)
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => [script] })
      const worker = await factory.create(spec(root))
      worker.closeNotifications()
      worker.abort()
      await expect(worker.done).resolves.toBeUndefined()
    } finally {
      delete process.env.DSH_TEST_SECRET
    }
  })

  it('reports an unexpected child crash instead of treating it as a clean shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    const script = fixture(`
      process.send({ type: 'ready' })
      setTimeout(() => process.exit(73), 20)
    `)
    const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => [script] })
    const worker = await factory.create(spec(root))
    await expect(worker.done).rejects.toThrow('73')
  })

  it('rejects attempts to override reserved Profile isolation variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => ['--version'] })
    await expect(factory.create({ ...spec(root), env: { DSH_PROFILE_ROOT: '/tmp/attacker' } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('dsh web Profile worker', () => {
  it('rejects relative launch paths and non-ready or oversized child output', async () => {
    expect(() => new DshWebProfileWorkerFactory({
      nodeExecutablePath: 'node', dshEntrypointPath: process.execPath,
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() => new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: 'worker.mjs',
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))

    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const malformed = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: fixture("console.log('dsh web: http://localhost:4123'); setInterval(() => {}, 1000)"),
      attestListener: async () => undefined,
      readyTimeoutMs: 250,
    })
    await expect(malformed.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })

    const oversized = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: fixture("process.stdout.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000)"),
      attestListener: async () => undefined,
      readyTimeoutMs: 1_000,
    })
    await expect(oversized.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('kills a child without a usable PID or stdout before accepting readiness', async () => {
    const signals: (string | number | undefined)[] = []
    const child = {
      pid: undefined,
      stdout: null,
      kill: (signal?: string | number) => { signals.push(signal); return true },
    } as unknown as ChildProcess
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    })
    const waitForOrigin = (factory as unknown as {
      waitForOrigin(child: ChildProcess): Promise<unknown>
    }).waitForOrigin.bind(factory)
    await expect(waitForOrigin(child)).rejects.toMatchObject({ code: 'unavailable' })
    expect(signals).toEqual(['SIGKILL'])
  })

  it('settles Web worker handles once across error, exit, and forced abort paths', async () => {
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath, abortTimeoutMs: 10,
    })
    const handle = (factory as unknown as {
      handle(
        child: ChildProcess,
        origin: string,
        cookie: { readonly name: string; readonly value: string },
        generation: number,
      ): ProfileWorkerHandle
    }).handle.bind(factory)
    const cookie = { name: 'dsh-auth-fixture', value: 'v1.fixture.fixture' }
    const errored = controlledWebChild()
    const failed = handle(errored as unknown as ChildProcess, 'http://127.0.0.1:1', cookie, 1)
    const failure = expect(failed.done).rejects.toThrow('worker error')
    errored.emit('error', new Error('worker error'))
    errored.emit('exit', 1, null)
    await failure

    const crashed = controlledWebChild()
    const unexpected = handle(crashed as unknown as ChildProcess, 'http://127.0.0.1:2', cookie, 2)
    crashed.emit('exit', 73, 'SIGABRT')
    await expect(unexpected.done).rejects.toThrow('73')

    const clean = controlledWebChild()
    const completed = handle(clean as unknown as ChildProcess, 'http://127.0.0.1:3', cookie, 3)
    clean.emit('exit', 0, null)
    clean.emit('error', new Error('late error'))
    await expect(completed.done).resolves.toBeUndefined()
    completed.abort()

    const signals: (string | number | undefined)[] = []
    const stubborn = controlledWebChild()
    stubborn.kill = (signal) => { signals.push(signal); return true }
    const stopped = handle(stubborn as unknown as ChildProcess, 'http://127.0.0.1:4', cookie, 4)
    stopped.abort()
    stopped.abort()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    stubborn.emit('exit', null, 'SIGKILL')
    await expect(stopped.done).resolves.toBeUndefined()

    let forceKill!: () => void
    const setTimer = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce((callback) => {
      forceKill = callback
      return 1 as unknown as NodeJS.Timeout
    })
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => undefined)
    try {
      const raceSignals: (string | number | undefined)[] = []
      const raced = controlledWebChild()
      raced.kill = (signal) => { raceSignals.push(signal); return true }
      const racedStop = handle(raced as unknown as ChildProcess, 'http://127.0.0.1:5', cookie, 5)
      racedStop.abort()
      raced.emit('exit', 0, null)
      await expect(racedStop.done).resolves.toBeUndefined()
      forceKill()
      expect(raceSignals).toEqual(['SIGTERM'])
    } finally {
      setTimer.mockRestore()
      clearTimer.mockRestore()
    }
  })

  it('validates every model worker response before returning it to the Host', async () => {
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    })
    const handle = (factory as unknown as {
      handle(
        child: ChildProcess,
        origin: string,
        cookie: { readonly name: string; readonly value: string },
        generation: number,
        modelToken: string,
      ): ProfileWorkerHandle
    }).handle.bind(factory)
    const cookie = { name: 'dsh-auth-fixture', value: 'v1.fixture.fixture' }
    const controlled = controlledWebChild()
    const worker = handle(controlled as unknown as ChildProcess, 'http://127.0.0.1:1', cookie, 1, 'A'.repeat(43))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const generate = (text = 'question') => worker.generateText!(text, new AbortController().signal)
    try {
      fetchMock.mockResolvedValueOnce(new Response('x'.repeat(17_409), { status: 200 }))
      await expect(generate()).rejects.toMatchObject({ code: 'unavailable' })
      fetchMock.mockResolvedValueOnce(new Response('{', { status: 200 }))
      await expect(generate()).rejects.toMatchObject({ code: 'unavailable' })
      for (const value of [null, [], 'text']) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }))
        await expect(generate()).rejects.toMatchObject({ code: 'unavailable' })
      }
      for (const code of [
        'invalid_input', 'no_default_model', 'missing_credential', 'provider_failed', 'cancelled', 'timeout',
        'response_too_large',
      ] as const) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: code }), { status: 422 }))
        await expect(generate()).rejects.toMatchObject({ code })
      }
      fetchMock.mockResolvedValueOnce(new Response('{"error":"private"}', { status: 422 }))
      await expect(generate()).rejects.toMatchObject({ code: 'unavailable' })
      for (const value of [
        { provider: 1, model: 'm', text: 'a' },
        { provider: ' ', model: 'm', text: 'a' },
        { provider: 'p'.repeat(257), model: 'm', text: 'a' },
        { provider: 'p', model: 1, text: 'a' },
        { provider: 'p', model: ' ', text: 'a' },
        { provider: 'p', model: 'm'.repeat(257), text: 'a' },
        { provider: 'p', model: 'm', text: 1 },
        { provider: 'p', model: 'm', text: ' ' },
        { provider: 'p', model: 'm', text: 'a'.repeat(16_385) },
        { provider: 'p', model: 'm', text: 'a', extra: true },
      ]) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status: 200 }))
        await expect(generate()).rejects.toMatchObject({ code: 'unavailable' })
      }
      fetchMock.mockResolvedValueOnce(new Response('{"provider":"p","model":"m","text":"answer"}', { status: 200 }))
      await expect(generate()).resolves.toEqual({ provider: 'p', model: 'm', text: 'answer' })
      const lastCall = fetchMock.mock.lastCall
      expect(lastCall?.[0]).toBe('http://127.0.0.1:1/internal/desktop-model-text')
      expect(lastCall?.[1]?.method).toBe('POST')
      expect(lastCall?.[1]?.headers).toMatchObject({ authorization: `Bearer ${'A'.repeat(43)}` })
      expect(lastCall?.[1]?.body).toBe('{"text":"question"}')
      expect(lastCall?.[1]?.signal).toBeInstanceOf(AbortSignal)
    } finally {
      fetchMock.mockRestore()
      worker.abort()
      controlled.emit('exit', 0, null)
      await worker.done
    }

    const stoppedChild = controlledWebChild()
    const stopped = handle(stoppedChild as unknown as ChildProcess, 'http://127.0.0.1:2', cookie, 2, 'B'.repeat(43))
    stopped.abort()
    await expect(stopped.generateText?.('question', new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    stoppedChild.emit('exit', 0, null)
    await stopped.done

    const settledChild = controlledWebChild()
    const settled = handle(settledChild as unknown as ChildProcess, 'http://127.0.0.1:3', cookie, 3, 'C'.repeat(43))
    settledChild.emit('exit', 0, null)
    await settled.done
    await expect(settled.generateText?.('question', new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it.runIf(process.platform !== 'darwin')('fails closed when the default macOS listener attestor is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
      const server = createServer((_request, response) => response.end())
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        console.log('dsh web: http://127.0.0.1:' + port + '/?token=fixture')
      })
      setInterval(() => {}, 1000)
    `)
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: executable,
    })
    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects every invalid bootstrap exchange response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const cookie = `dsh-auth-${'a'.repeat(43)}=v1.${'b'.repeat(8)}.${'c'.repeat(43)}; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict`
    const cases = [
      { bootstrapStatus: 200, location: '/', cookies: [cookie], anonymousStatus: 401, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/wrong', cookies: [cookie], anonymousStatus: 401, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/', cookies: [], anonymousStatus: 401, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/', cookies: [cookie, cookie], anonymousStatus: 401, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/', cookies: ['invalid'], anonymousStatus: 401, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/', cookies: [cookie], anonymousStatus: 200, authorizedStatus: 200 },
      { bootstrapStatus: 303, location: '/', cookies: [cookie], anonymousStatus: 401, authorizedStatus: 401 },
    ]
    for (const responseCase of cases) {
      const executable = fixture(`#!${process.execPath}
        import { createServer } from 'node:http'
        const config = ${JSON.stringify(responseCase)}
        const server = createServer((request, response) => {
          const url = new URL(request.url, 'http://127.0.0.1')
          if (url.searchParams.has('token')) {
            const headers = { location: config.location }
            if (config.cookies.length > 0) headers['set-cookie'] = config.cookies
            response.writeHead(config.bootstrapStatus, headers)
          } else if (request.headers.cookie) response.writeHead(config.authorizedStatus)
          else response.writeHead(config.anonymousStatus)
          response.end()
        })
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address()
          console.log('dsh web: http://127.0.0.1:' + port + '/?token=fixture')
        })
        setInterval(() => {}, 1000)
      `)
      const factory = new DshWebProfileWorkerFactory({
        nodeExecutablePath: process.execPath, dshEntrypointPath: executable,
        attestListener: async () => undefined,
      })
      await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
    }
  })

  it('returns only an attested origin from a real child and discards its access token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
      const cookieName = 'dsh-auth-${'a'.repeat(43)}'
      const cookieValue = 'v1.${'b'.repeat(8)}.${'c'.repeat(43)}'
      let assetReads = 0
      const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1')
        if (url.pathname === '/internal/desktop-model-text') {
          if (request.headers.authorization !== 'Bearer ' + process.env.DSH_PROFILE_MODEL_TOKEN) {
            response.writeHead(403).end()
            return
          }
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ provider: 'deepseek', model: 'chat', text: 'answer' }))
          return
        }
        if (url.pathname === '/internal/desktop-remote-session') {
          if (request.headers.authorization !== 'Bearer ' + process.env.DSH_PROFILE_REMOTE_SESSION_TOKEN) {
            response.writeHead(403).end()
            return
          }
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ value: { items: [] } }))
          return
        }
        if (url.pathname === '/internal/desktop-remote-ui') {
          if (request.headers.authorization !== 'Bearer ' + process.env.DSH_PROFILE_REMOTE_UI_TOKEN) {
            response.writeHead(403).end()
            return
          }
          const body = await new Promise(resolve => {
            let text = ''
            request.on('data', chunk => { text += chunk })
            request.on('end', () => resolve(JSON.parse(text)))
          })
          if (body.endpoint === 'boot/injections') {
            response.writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ value: { injections: [
                { kind: 'script-src', placement: 'head', src: '/plugins/??a/client.js&rev=1' },
                { kind: 'script-preload', src: '/plugins/??large/client.js&rev=1' },
                { kind: 'script-preload', src: '/plugins/??missing/client.js&rev=1' },
              ] } }))
            return
          }
          response.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ value: { items: [] } }))
          return
        }
        if (url.pathname === '/internal/desktop-remote-ui-stream') {
          if (request.headers.authorization !== 'Bearer ' + process.env.DSH_PROFILE_REMOTE_UI_TOKEN) {
            response.writeHead(403).end()
            return
          }
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
            .end('{"type":"item","value":{"cursor":1}}\\n{"type":"end"}\\n')
          return
        }
        if (url.searchParams.get('token') === 'must-stay-owner-only') {
          response.writeHead(303, {
            location: '/',
            'set-cookie': cookieName + '=' + cookieValue + '; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict',
          })
          response.end()
          return
        }
        if (request.headers.cookie === cookieName + '=' + cookieValue) {
          if (url.pathname === '/plugins/' && url.search === '??a/client.js&rev=1') {
            assetReads++
            response.writeHead(200, { 'content-type': 'text/javascript' })
              .end(assetReads === 1 ? 'registered();' : 'changed();')
            return
          }
          if (url.pathname === '/plugins/' && url.search === '??large/client.js&rev=1') {
            response.writeHead(200, { 'content-type': 'text/javascript' }).end(Buffer.alloc(8 * 1024 * 1024 + 1))
            return
          }
          if (url.pathname === '/plugins/' && url.search === '??missing/client.js&rev=1') {
            response.writeHead(404).end()
            return
          }
          response.end(process.env.DSH_PROFILE_ID)
          return
        }
        response.writeHead(401)
        response.end('unauthorized')
      })
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        console.log('dsh web: http://127.0.0.1:' + port + '/?token=must-stay-owner-only')
      })
      process.on('SIGTERM', () => server.close(() => process.exit(0)))
    `)
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: executable,
      attestListener: async (pid, origin) => {
        expect(pid).toBeGreaterThan(0)
        await expect(fetch(origin).then(response => response.status)).resolves.toBe(401)
      },
    })
    const worker = await factory.create(spec(root))
    onTestFinished(async () => { worker.closeNotifications(); worker.abort(); await worker.done })
    expect(worker.viewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(worker.viewOrigin).not.toContain('access_key')
    expect(JSON.stringify(worker)).not.toContain('must-stay-owner-only')
    expect(worker.bootstrapCookie).toEqual({
      name: `dsh-auth-${'a'.repeat(43)}`, value: `v1.${'b'.repeat(8)}.${'c'.repeat(43)}`,
    })
    expect((await fetch(`${worker.viewOrigin}/internal/desktop-model-text`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${worker.viewOrigin}/internal/desktop-remote-session`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${worker.viewOrigin}/internal/desktop-remote-ui`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`${worker.viewOrigin}/internal/desktop-remote-ui-stream`, { method: 'POST' })).status).toBe(403)
    await expect(worker.generateText?.('question', new AbortController().signal)).resolves.toEqual({
      provider: 'deepseek', model: 'chat', text: 'answer',
    })
    await expect(worker.remoteSession?.({
      operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    }, new AbortController().signal)).resolves.toEqual({ items: [] })
    await expect(worker.remoteUiRead?.('session/list', { args: { _request: {} } },
      new AbortController().signal)).resolves.toEqual({ items: [] })
    const events: unknown[] = []
    for await (const event of worker.remoteUiStream!('session/follow', { args: {} }, new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([{ cursor: 1 }])
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: 0 } },
      new AbortController().signal)).resolves.toEqual({ bytes: Buffer.from('registered();').toString('base64url'), total: 13 })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: 1 } },
      new AbortController().signal)).resolves.toEqual({ bytes: Buffer.from('egistered();').toString('base64url'), total: 13 })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??b/client.js&rev=1', offset: 0 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: 'https://evil.test/plugins/a.js', offset: 0 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: -1 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??a/client.js&rev=1', offset: 14 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??missing/client.js&rev=1', offset: 0 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(worker.remoteUiRead?.('asset/read', { args: { url: '/plugins/??large/client.js&rev=1', offset: 0 } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects caller attempts to replace the selected DSH home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    })
    await expect(factory.create({ ...spec(root), env: { DSH_HOME: '/tmp/attacker' } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(factory.create({ ...spec(root), env: { DSH_PROFILE_REMOTE_UI_TOKEN: 'attacker' } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('aborts a child whose loopback bootstrap exchange never responds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
      const server = createServer(() => {})
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        console.log('dsh web: http://127.0.0.1:' + port + '/?token=never-completes')
      })
    `)
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: executable,
      attestListener: async () => undefined,
      readyTimeoutMs: 75,
    })
    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
  })
})
