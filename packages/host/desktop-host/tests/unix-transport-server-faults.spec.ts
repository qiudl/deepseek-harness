import { once } from 'node:events'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeHostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'
import type { SingleHostLock } from '../src/single-instance.ts'
import { UnixHostServer, type UnixHostServerOptions } from '../src/unix-transport.ts'

const uid = process.getuid!()
const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  .subarray(-32).toString('base64url')
const allowedDigest = '1'.repeat(64)

function options(socketPath: string, overrides: Partial<UnixHostServerOptions> = {}): UnixHostServerOptions {
  const ownership = { assertOwner: vi.fn() } as unknown as SingleHostLock
  const host = {
    supportsOfflineAccountRecovery: () => false,
    revokeOwner: vi.fn(),
  } as unknown as DesktopHost
  return {
    socketPath,
    ownership,
    expectedUid: uid,
    allowedDesktopExecutableDigests: new Set([allowedDigest]),
    attestPeer: async () => ({ uid, executableSignatureDigest: allowedDigest }),
    identity: {
      hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
      installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43),
      executableSignatureDigest: allowedDigest, runtimeGeneration: 5, schemaGeneration: 1,
    },
    host,
    profilePersistenceGeneration: () => 1,
    now: () => 1_000,
    ...overrides,
  }
}

async function listen(path: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  return server
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() })
  })
}

describe('Unix Host server resource ownership', () => {
  it('replaces one stale owned socket, rejects a duplicate start, and removes its exact inode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-'))
    const socketPath = join(root, 'host.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const stale = await listen(socketPath)
    expect(existsSync(socketPath)).toBe(true)
    const server = new UnixHostServer(options(socketPath))
    await server.start()
    await expect(server.start()).rejects.toMatchObject({ code: 'conflict' })
    await server.close()
    expect(existsSync(socketPath)).toBe(false)
    await server.close()
    await close(stale)
  })

  it('rejects non-sockets and a socket owned by another expected uid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-entry-'))
    const file = join(root, 'file.sock')
    const socketPath = join(root, 'host.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    writeFileSync(file, 'not a socket')
    await expect(new UnixHostServer(options(file)).start()).rejects.toMatchObject({ code: 'conflict' })
    const stale = await listen(socketPath)
    await expect(new UnixHostServer(options(socketPath, { expectedUid: uid + 1 })).start())
      .rejects.toMatchObject({ code: 'conflict' })
    await close(stale)
  })

  it('does not unlink a replacement socket after the original listener closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-replace-'))
    const socketPath = join(root, 'host.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const replacement = await listen(socketPath)
    const identity = lstatSync(socketPath)
    const server = new UnixHostServer(options(socketPath))
    ;(server as unknown as { server: { close(callback: (error?: Error) => void): void } }).server = {
      close: (callback) => { callback() },
    }
    ;(server as unknown as { socketIdentity: { dev: number; ino: number } }).socketIdentity = {
      dev: identity.dev + 1, ino: identity.ino,
    }
    await server.close()
    expect(existsSync(socketPath)).toBe(true)
    const unlinker = new UnixHostServer(options(socketPath))
    ;(unlinker as unknown as { server: { close(callback: (error?: Error) => void): void } }).server = {
      close: (callback) => { callback() },
    }
    ;(unlinker as unknown as { socketIdentity: { dev: number; ino: number } }).socketIdentity = {
      dev: identity.dev, ino: identity.ino,
    }
    await unlinker.close()
    expect(existsSync(socketPath)).toBe(false)
    await close(replacement)
  })

  it('surfaces an injected listener close failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-close-'))
    const socketPath = join(root, 'missing.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const server = new UnixHostServer(options(socketPath))
    const failure = new Error('close failed')
    ;(server as unknown as { server: { close(callback: (error?: Error) => void): void } }).server = {
      close: (callback) => { callback(failure) },
    }
    await expect(server.close()).rejects.toBe(failure)
  })

  it('surfaces an unexpected socket inspection failure during close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-inspect-'))
    const blocked = join(root, 'blocked')
    mkdirSync(blocked)
    chmodSync(blocked, 0o000)
    onTestFinished(() => { chmodSync(blocked, 0o700); rmSync(root, { recursive: true, force: true }) })
    const server = new UnixHostServer(options(join(blocked, 'host.sock')))
    await expect(server.close()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects each invalid peer fact before opening a control session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-peer-'))
    const socketPath = join(root, 'host.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const peers = [
      { uid: uid + 1, executableSignatureDigest: allowedDigest },
      { uid, executableSignatureDigest: 'invalid' },
      { uid, executableSignatureDigest: '2'.repeat(64) },
    ]
    const server = new UnixHostServer(options(socketPath, { attestPeer: async () => peers.shift()! }))
    await server.start()
    for (let index = 0; index < 3; index++) {
      const socket = createConnection(socketPath)
      await once(socket, 'close')
    }
    await server.close()
  })

  it('destroys a server channel when an authenticated peer sends an unsupported inspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-unix-server-request-'))
    const socketPath = join(root, 'host.sock')
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const host = { supportsOfflineAccountRecovery: () => { throw new Error('inspection failed') },
      revokeOwner: vi.fn() } as unknown as DesktopHost
    const server = new UnixHostServer(options(socketPath, { host }))
    await server.start()
    const socket = createConnection(socketPath)
    await once(socket, 'connect')
    socket.write(encodeHostControlFrame({
      version: 1, type: 'request', request_id: randomUUID() as never, method: 'host.inspect', params: {
        challenge: 'A'.repeat(43) as never, client_instance_id: randomUUID() as never, supported_versions: [1],
      },
    }))
    await once(socket, 'close')
    await server.close()
  })
})
