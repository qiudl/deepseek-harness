import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { startDesktopHostApplication, type Config } from '../src/startup.ts'
import type { UnixHostServer } from '../src/unix-transport.ts'

function fixture(): { config: Config; root: string; keyring: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-safety-'))
  const artifact = join(root, 'artifact')
  const deviceKey = join(root, 'device.key')
  const keyringPath = join(root, 'keyring.json')
  const privateKey = join(root, 'installation.pem')
  const account = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const installation = generateKeyPairSync('ed25519')
  const keyring = `${JSON.stringify({
    version: 2, issuer: 'https://accounts.dsh.colorbuyai.com',
    keys: [{ kid: 'fixture', publicJwk: account.publicKey.export({ format: 'jwk' }) }],
  })}\n`
  writeFileSync(artifact, 'fixture', { mode: 0o700 })
  writeFileSync(deviceKey, Buffer.alloc(32, 1), { mode: 0o600 })
  writeFileSync(keyringPath, keyring, { mode: 0o600 })
  writeFileSync(privateKey, installation.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return {
    root,
    keyring,
    config: {
      root, registrationRoot: join(root, 'registration'), nodeExecutablePath: artifact,
      dshEntrypointPath: artifact, deviceIndexKeyPath: deviceKey,
      accountKeyringPath: keyringPath, accountKeyringSha256: createHash('sha256').update(keyring).digest('hex'),
      installationPrivateKeyPath: privateKey,
      installationPublicKey: (installation.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url'),
      installationId: randomUUID(), endpointRegistrationId: randomUUID(), hostInstanceId: randomUUID(),
      processNonce: Buffer.alloc(32, 2).toString('base64url'), executableSignatureDigest: '1'.repeat(64),
      desktopTeamIdentifiers: [], desktopExecutableDigests: ['2'.repeat(64)], runtimeGeneration: 1, schemaGeneration: 1,
    },
  }
}

function attempt(config: Config) {
  const server = { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } as unknown as UnixHostServer
  return startDesktopHostApplication(config, { now: Date.now }, {
    platform: 'darwin', profileWorkerFactory: async () => { throw Error('unused') },
    attestPeer: async () => ({ uid: process.getuid!(), executableSignatureDigest: '2'.repeat(64) }),
    createServer: () => server,
  })
}

it.skipIf(process.platform === 'win32')('rejects unsupported platforms and unavailable uid', async () => {
  const { config } = fixture()
  await expect(startDesktopHostApplication(config, undefined, { platform: 'linux' }))
    .rejects.toMatchObject({ code: 'unavailable' })
  const getuid = vi.spyOn(process, 'getuid').mockReturnValue(undefined as never)
  await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  getuid.mockRestore()
  await expect(startDesktopHostApplication(Object.assign({}, config, {
    root: undefined, nodeExecutablePath: 'relative',
  }), undefined, {
    platform: 'darwin',
  })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(startDesktopHostApplication(Object.assign({}, config, { root: 'relative' })))
    .rejects.toMatchObject({ code: process.platform === 'darwin' ? 'invalid_input' : 'unavailable' })
})

it.skipIf(process.platform === 'win32')('rejects relative startup and owner-file paths', async () => {
  for (const patch of [
    { root: 'relative' }, { nodeExecutablePath: 'relative' }, { dshEntrypointPath: 'relative' },
    { deviceIndexKeyPath: 'relative' }, { installationPrivateKeyPath: 'relative' },
  ]) {
    const { config } = fixture()
    await expect(attempt(Object.assign({}, config, patch))).rejects.toMatchObject({ code: 'invalid_input' })
  }
})

it.skipIf(process.platform === 'win32')('rejects unsafe owner files and pinned keyrings', async () => {
  {
    const { config } = fixture()
    writeFileSync(config.deviceIndexKeyPath, Buffer.alloc(31), { mode: 0o600 })
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
  {
    const { config } = fixture()
    chmodSync(config.deviceIndexKeyPath, 0o644)
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
  {
    const { config } = fixture()
    await expect(attempt(Object.assign({}, config, { accountKeyringSha256: 'invalid' })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  }
  for (const contents of ['', 'different', 'x'.repeat(16 * 1024 + 1)]) {
    const { config } = fixture()
    writeFileSync(config.accountKeyringPath, contents, { mode: 0o600 })
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
})

it.skipIf(process.platform === 'win32')('rejects unsafe executable artifacts and host roots', async () => {
  {
    const { config } = fixture()
    chmodSync(config.nodeExecutablePath, 0o722)
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
  {
    const { config } = fixture()
    rmSync(config.nodeExecutablePath)
    mkdirSync(config.nodeExecutablePath, { mode: 0o700 })
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
  {
    const { config, root } = fixture()
    chmodSync(root, 0o777)
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
})

it.skipIf(process.platform === 'win32')('rejects malformed registration ownership and contents', async () => {
  {
    const { config } = fixture()
    await expect(attempt(Object.assign({}, config, { endpointRegistrationId: 'invalid' })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  }
  {
    const { config } = fixture()
    await expect(attempt(Object.assign({}, config, { registrationRoot: 'relative' })))
      .rejects.toMatchObject({ code: 'invalid_input' })
  }
  for (const contents of ['not-json', 'null', '[]']) {
    const { config } = fixture()
    mkdirSync(config.registrationRoot!, { mode: 0o700 })
    writeFileSync(join(config.registrationRoot!, 'registration.v1.json'), contents, { mode: 0o600 })
    await expect(attempt(config)).rejects.toMatchObject({ code: 'unavailable' })
  }
  {
    const { config, root } = fixture()
    const container = mkdtempSync(join(tmpdir(), 'dsh-registration-container-'))
    onTestFinished(() => { rmSync(container, { recursive: true, force: true }) })
    chmodSync(container, 0o777)
    await expect(attempt(Object.assign({}, config, { root, registrationRoot: join(container, 'host') })))
      .rejects.toMatchObject({ code: 'unavailable' })
  }
})

it.skipIf(process.platform === 'win32')('contains startup cleanup failures without replacing the primary error', async () => {
  const { config, root } = fixture()
  const serverClose = vi.fn(async () => { throw new Error('listener cleanup failure') })
  const server = {
    start: vi.fn(async () => {
      rmSync(join(root, 'host.lock'))
      throw new Error('primary startup failure')
    }),
    close: serverClose,
  } as unknown as UnixHostServer
  await expect(startDesktopHostApplication(config, { now: Date.now }, {
    platform: 'darwin', profileWorkerFactory: async () => { throw Error('unused') },
    attestPeer: async () => ({ uid: process.getuid!(), executableSignatureDigest: '2'.repeat(64) }),
    createServer: () => server,
  })).rejects.toThrow('primary startup failure')
  expect(serverClose).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')('publishes registration beneath the private default home', async () => {
  const { config, root } = fixture()
  const privateHome = join(root, 'home')
  mkdirSync(privateHome, { mode: 0o700 })
  vi.stubEnv('HOME', privateHome)
  try {
    const application = await attempt(Object.assign({}, config, { registrationRoot: undefined }))
    await application.close()
  } finally {
    vi.unstubAllEnvs()
  }
})
