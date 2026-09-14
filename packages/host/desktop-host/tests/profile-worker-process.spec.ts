import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
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
  it('returns only an attested origin from a real child and discards its access token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-web-'))
    const executable = fixture(`#!${process.execPath}
      import { createServer } from 'node:http'
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
      attestListener: async (pid, origin) => {
        expect(pid).toBeGreaterThan(0)
        await expect(fetch(origin).then(response => response.status)).resolves.toBe(401)
      },
    })
    const worker = await factory.create(spec(root))
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
