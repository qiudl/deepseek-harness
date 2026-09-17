import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DshWebProfileWorkerFactory, ProfileWorkerProcessFactory, redactWorkerDiagnostic } from '../src/index.ts'
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

async function readyHandle(child: ControlledChild): Promise<ProfileWorkerHandle> {
  const factory = new ProfileWorkerProcessFactory({ executablePath: process.execPath, arguments: () => [] })
  const pending = (factory as unknown as { readyHandle(child: ChildProcess): Promise<ProfileWorkerHandle> })
    .readyHandle(child as unknown as ChildProcess)
  child.emit('message', { type: 'ready' })
  return await pending
}

describe('profile worker child process', () => {
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
    const child = () => {
      const controlled = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill(signal?: string | number): boolean
      }
      controlled.stdout = new PassThrough()
      controlled.stderr = new PassThrough()
      controlled.kill = () => true
      return controlled
    }

    const errored = child()
    const failed = handle(errored as unknown as ChildProcess, 'http://127.0.0.1:1', cookie, 1)
    const failure = expect(failed.done).rejects.toThrow('worker error')
    errored.emit('error', new Error('worker error'))
    errored.emit('exit', 1, null)
    await failure

    const crashed = child()
    const unexpected = handle(crashed as unknown as ChildProcess, 'http://127.0.0.1:2', cookie, 2)
    crashed.emit('exit', 73, 'SIGABRT')
    await expect(unexpected.done).rejects.toThrow('73')

    const clean = child()
    const completed = handle(clean as unknown as ChildProcess, 'http://127.0.0.1:3', cookie, 3)
    clean.emit('exit', 0, null)
    clean.emit('error', new Error('late error'))
    await expect(completed.done).resolves.toBeUndefined()
    completed.abort()

    const signals: (string | number | undefined)[] = []
    const stubborn = child()
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
      const raced = child()
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

  it.each([
    { name: 'direct process environment', platform: 'darwin' as const },
    { name: 'Windows private configuration pipe', platform: 'win32' as const },
  ])('returns only an attested origin through $name and discards its access token', async ({ platform }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
      export async function runCli() {
        if (process.env.DSH_TEST_SECRET || process.env.DSH_TEST_CONFIGURATION !== 'carried') process.exit(91)
        if (process.execArgv.includes('--expose-internals') !== (process.env.DSH_EXPECT_EXPOSE === 'true')) process.exit(92)
        const cookieName = 'dsh-auth-${'a'.repeat(43)}'
        const cookieValue = 'v1.${'b'.repeat(8)}.${'c'.repeat(43)}'
        const server = createServer((request, response) => {
          const url = new URL(request.url, 'http://127.0.0.1')
          if (url.searchParams.get('token') === 'must-stay-owner-only') {
            response.writeHead(303, {
              location: '/',
              'set-cookie': cookieName + '=' + cookieValue + '; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict',
            })
            response.end()
            return
          }
          if (request.headers.cookie === cookieName + '=' + cookieValue) {
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
      }
      if (import.meta.main) await runCli()
    `)
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: executable,
      platform,
      attestListener: async (pid, origin) => {
        expect(pid).toBeGreaterThan(0)
        await expect(fetch(origin).then(response => response.status)).resolves.toBe(401)
      },
    })
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    const worker = await factory.create({
      ...spec(root), env: { DSH_TEST_CONFIGURATION: 'carried', DSH_EXPECT_EXPOSE: String(platform === 'win32') },
    }).finally(() => { delete process.env.DSH_TEST_SECRET })
    expect(worker.viewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(worker.viewOrigin).not.toContain('access_key')
    expect(JSON.stringify(worker)).not.toContain('must-stay-owner-only')
    expect(worker.bootstrapCookie).toEqual({
      name: `dsh-auth-${'a'.repeat(43)}`, value: `v1.${'b'.repeat(8)}.${'c'.repeat(43)}`,
    })
    worker.closeNotifications(); worker.abort()
    await expect(worker.done).resolves.toBeUndefined()
  })

  it('rejects caller attempts to replace the selected DSH home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
    })
    await expect(factory.create({ ...spec(root), env: { DSH_HOME: '/tmp/attacker' } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects oversized Windows configuration before starting a child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    let spawns = 0
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: process.execPath,
      platform: 'win32',
      spawnProcess: () => { spawns += 1; throw new Error('must not spawn') },
    })
    await expect(factory.create({ ...spec(root), env: { LARGE: 'x'.repeat(64 * 1024) } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(spawns).toBe(0)
  })

  it('terminates and rejects a Windows child without its private configuration descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      killed: boolean
      stdout: PassThrough
      stderr: PassThrough
      stdio: [null, PassThrough, PassThrough]
      kill(): boolean
    }
    child.pid = 123
    child.killed = false
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdio = [null, child.stdout, child.stderr]
    child.kill = () => { child.killed = true; return true }
    const diagnostics: string[] = []
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: process.execPath,
      platform: 'win32',
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      onDiagnostic: (detail) => { diagnostics.push(detail) },
    })
    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
    expect(child.killed).toBe(true)
    expect(diagnostics).toEqual(['profile worker started without its private configuration channel'])
  })

  it('terminates a Windows child that rejects its private configuration input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      killed: boolean
      stdout: PassThrough
      stderr: PassThrough
      stdio: Array<null | PassThrough | Writable>
      kill(): boolean
    }
    child.pid = 124
    child.killed = false
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdio = [
      null,
      child.stdout,
      child.stderr,
      new Writable({ write: (_chunk, _encoding, callback) => { callback(new Error('closed')) } }),
    ]
    child.kill = () => {
      child.killed = true
      queueMicrotask(() => { child.emit('exit', null, 'SIGKILL') })
      return true
    }
    const diagnostics: string[] = []
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: process.execPath,
      platform: 'win32',
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
      onDiagnostic: (detail) => { diagnostics.push(detail) },
    })
    // The closed Host vocabulary still reports `unavailable` on the wire; the child's own
    // failure has to survive here, or a dead worker is indistinguishable from a timeout.
    await expect(factory.create(spec(root))).rejects.toThrow('exited before readiness')
    expect(child.killed).toBe(true)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('exited before readiness')
    expect(diagnostics[0]).not.toContain('readiness timeout')
  })

  it('reports a worker that never prints readiness, with its own stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      process.stderr.write('plugin tree failed to load: ERR_DLOPEN_FAILED\\n')
      setTimeout(() => {}, 60_000)
    `)
    const diagnostics: string[] = []
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: executable,
      readyTimeoutMs: 150,
      onDiagnostic: (detail) => { diagnostics.push(detail) },
    })

    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })

    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('readiness timeout 150ms')
    expect(diagnostics[0]).toContain('ERR_DLOPEN_FAILED')
  })

  it('keeps the readiness token out of a worker diagnostic', () => {
    expect(redactWorkerDiagnostic('dsh web: http://127.0.0.1:41/?token=secret-value\nnext line'))
      .toBe('dsh web: http://127.0.0.1:41/?token=<redacted> next line')
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
