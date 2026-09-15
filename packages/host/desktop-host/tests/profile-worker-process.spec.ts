import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DshWebProfileWorkerFactory, ProfileWorkerProcessFactory } from '../src/index.ts'

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

describe('profile worker child process', () => {
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
  it.each([
    { name: 'direct process environment', platform: 'darwin' as const },
    { name: 'Windows private configuration pipe', platform: 'win32' as const },
  ])('returns only an attested origin through $name and discards its access token', async ({ platform }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
      if (process.env.DSH_TEST_SECRET || process.env.DSH_TEST_CONFIGURATION !== 'carried') process.exit(91)
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
      ...spec(root), env: { DSH_TEST_CONFIGURATION: 'carried' },
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
      spawnProcess: (() => { spawns += 1; throw new Error('must not spawn') }) as typeof import('node:child_process').spawn,
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
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: process.execPath,
      platform: 'win32',
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    })
    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
    expect(child.killed).toBe(true)
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
    const factory = new DshWebProfileWorkerFactory({
      nodeExecutablePath: process.execPath,
      dshEntrypointPath: process.execPath,
      platform: 'win32',
      spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
    })
    await expect(factory.create(spec(root))).rejects.toMatchObject({ code: 'unavailable' })
    expect(child.killed).toBe(true)
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
