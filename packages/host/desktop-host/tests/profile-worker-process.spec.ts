import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
