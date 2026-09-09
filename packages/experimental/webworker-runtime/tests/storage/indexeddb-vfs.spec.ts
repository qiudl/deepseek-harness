import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  openEncryptedWebVfsProfile,
  type StoredVfsEntry,
  type StoredVfsProfile,
  type VfsProfileBackend,
  type WebLockManager,
} from '../../src/storage/indexeddb.ts'

class MemoryBackend implements VfsProfileBackend {
  readonly profiles = new Map<string, StoredVfsProfile>()
  readonly entries = new Map<string, StoredVfsEntry>()

  async getOrCreateProfile(candidate: StoredVfsProfile): Promise<StoredVfsProfile> {
    const existing = this.profiles.get(candidate.namespace)
    if (existing !== undefined) return existing
    this.profiles.set(candidate.namespace, candidate)
    return candidate
  }

  async listEntries(namespace: string): Promise<readonly StoredVfsEntry[]> {
    return [...this.entries.values()].filter(entry => entry.namespace === namespace)
  }

  async getEntry(namespace: string, path: string): Promise<StoredVfsEntry | null> {
    return [...this.entries.values()].find(entry => entry.namespace === namespace && entry.path === path) ?? null
  }

  async putEntries(entries: readonly StoredVfsEntry[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.id, entry)
  }

  async removeSubtree(namespace: string, path: string): Promise<void> {
    const prefix = `${path}/`
    for (const [id, entry] of this.entries) {
      if (entry.namespace === namespace && (entry.path === path || entry.path.startsWith(prefix))) {
        this.entries.delete(id)
      }
    }
  }
}

const durableStorage = { persisted: async (): Promise<boolean> => true, persist: async (): Promise<boolean> => true }
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140'
const keys = new Map<string, CryptoKey>()

async function keyFor(environmentId: string): Promise<CryptoKey> {
  const existing = keys.get(environmentId)
  if (existing !== undefined) return existing
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt', 'decrypt',
  ])
  keys.set(environmentId, key)
  return key
}

function grantedLocks(): WebLockManager {
  return {
    request: async (_name, _options, callback) => {
      await callback({ name: _name, mode: 'exclusive' })
    },
  }
}

async function mirror(backend: MemoryBackend, environmentId = 'staging') {
  const opened = await openEncryptedWebVfsProfile({
    environmentId,
    profileId,
    encryptionKey: await keyFor(environmentId),
    backend,
    storage: durableStorage,
    locks: grantedLocks(),
    crypto: webcrypto as unknown as Crypto,
    now: () => 1_800_000_000_000,
  })
  if (opened.kind !== 'durable') throw new Error('expected durable test profile')
  return opened.mirror
}

describe('encrypted Web VFS persistence', () => {
  it('encrypts mutable data and hydrates it over a fresh base image', async () => {
    const backend = new MemoryBackend()
    const firstMirror = await mirror(backend)
    const first = new MemoryVfs({ sink: firstMirror })
    first.seedDirectory('/dsh/home')
    first.seedDirectory('/dsh/workspace')
    first.mkdirSync('/dsh/home/sessions')
    first.writeFileSync('/dsh/home/sessions/private.jsonl', 'secret session')
    first.writeFileSync('/dsh/workspace/note.txt', 'private note')
    await first.flush()

    expect(backend.entries.size).toBe(3)
    const serialized = JSON.stringify([...backend.entries.values()])
    expect(serialized).not.toContain('secret session')
    expect(serialized).not.toContain('private note')
    expect([...backend.entries.values()].every(entry =>
      entry.iv.byteLength === 12 && entry.ciphertext instanceof ArrayBuffer)).toBe(true)

    const restored = new MemoryVfs()
    restored.seed('/dsh/workspace/note.txt', 'base value')
    await (await mirror(backend)).hydrate(restored)
    expect(restored.readFileSync('/dsh/home/sessions/private.jsonl', 'utf8')).toBe('secret session')
    expect(restored.readFileSync('/dsh/workspace/note.txt', 'utf8')).toBe('private note')
  })

  it('keeps production and staging profiles cryptographically isolated', async () => {
    const backend = new MemoryBackend()
    const staging = new MemoryVfs({ sink: await mirror(backend, 'staging') })
    staging.seedDirectory('/dsh/home')
    staging.writeFileSync('/dsh/home/environment', 'staging-only')
    await staging.flush()

    const productionMirror = await mirror(backend, 'production')
    const production = new MemoryVfs()
    production.seedDirectory('/dsh/home')
    await productionMirror.hydrate(production)
    expect(production.existsSync('/dsh/home/environment')).toBe(false)
    expect(backend.profiles.size).toBe(2)
  })

  it('replays ordered writes and subtree removal without resurrecting stale files', async () => {
    const backend = new MemoryBackend()
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/workspace')
    vfs.mkdirSync('/dsh/workspace/tree')
    vfs.writeFileSync('/dsh/workspace/tree/one', 'one')
    vfs.writeFileSync('/dsh/workspace/tree/two', 'two')
    vfs.rmSync('/dsh/workspace/tree', { recursive: true })
    await vfs.flush()
    expect(backend.entries.size).toBe(0)
  })

  it('mirrors removal of an ancestor that contains both persistent roots', async () => {
    const backend = new MemoryBackend()
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/home')
    vfs.seedDirectory('/dsh/workspace')
    vfs.writeFileSync('/dsh/home/session', 'home')
    vfs.writeFileSync('/dsh/workspace/file', 'workspace')
    await vfs.flush()
    vfs.rmSync('/dsh', { recursive: true })
    await vfs.flush()
    expect(backend.entries.size).toBe(0)
  })

  it('restores hard links as one shared file identity', async () => {
    const backend = new MemoryBackend()
    const firstMirror = await mirror(backend)
    const first = new MemoryVfs({ sink: firstMirror })
    first.seedDirectory('/dsh/home')
    first.writeFileSync('/dsh/home/object', 'shared')
    first.linkSync('/dsh/home/object', '/dsh/home/alias')
    await first.flush()

    const restoredMirror = await mirror(backend)
    const restored = new MemoryVfs({ sink: restoredMirror })
    await restoredMirror.hydrate(restored)
    const object = restored.statSync('/dsh/home/object', { bigint: true })
    const alias = restored.statSync('/dsh/home/alias', { bigint: true })
    expect(object.ino).toBe(alias.ino)
    restored.appendFileSync('/dsh/home/alias', '-changed')
    expect(restored.readFileSync('/dsh/home/object', 'utf8')).toBe('shared-changed')

    restored.writeFileSync('/dsh/home/independent', 'separate')
    await restored.flush()
    const storedObject = [...backend.entries.values()].find(entry => entry.path === '/dsh/home/object')
    const storedIndependent = [...backend.entries.values()].find(entry => entry.path === '/dsh/home/independent')
    expect(storedObject?.kind).toBe('file')
    expect(storedIndependent?.kind).toBe('file')
    if (storedObject?.kind !== 'file' || storedIndependent?.kind !== 'file') {
      throw new Error('expected durable files')
    }
    expect(storedIndependent.linkGroup).not.toBe(storedObject.linkGroup)

    const reopenedMirror = await mirror(backend)
    const reopened = new MemoryVfs()
    await reopenedMirror.hydrate(reopened)
    expect(reopened.readFileSync('/dsh/home/independent', 'utf8')).toBe('separate')
  })

  it('does not persist runtime code, config, or temporary files', async () => {
    const backend = new MemoryBackend()
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/node_modules')
    vfs.seedDirectory('/dsh/config')
    vfs.seedDirectory('/dsh/tmp')
    vfs.writeFileSync('/dsh/node_modules/injected.js', 'code')
    vfs.writeFileSync('/dsh/config/cordis.yml', 'config')
    vfs.writeFileSync('/dsh/tmp/secret', 'temporary')
    await vfs.flush()
    expect(backend.entries.size).toBe(0)
  })

  it('returns an explicit session-only boundary when persistent storage is denied', async () => {
    const backend = new MemoryBackend()
    const opened = await openEncryptedWebVfsProfile({
      environmentId: 'staging',
      profileId,
      encryptionKey: await keyFor('staging'),
      backend,
      storage: { persisted: async () => false, persist: async () => false },
      locks: grantedLocks(),
      crypto: webcrypto as unknown as Crypto,
    })
    expect(opened).toEqual({ kind: 'session_only', reasonCode: 'WEB_DSH_STORAGE_NOT_DURABLE' })
    expect(backend.profiles.size).toBe(0)
  })

  it('stops mirroring after a storage failure without rolling back in-memory work', async () => {
    const backend = new MemoryBackend()
    const put = vi.spyOn(backend, 'putEntries')
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockResolvedValue(undefined)
    const failures: unknown[] = []
    const opened = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'),
      locks: grantedLocks(), crypto: webcrypto as unknown as Crypto,
      onFailure: (reason) => { failures.push(reason) },
    })
    if (opened.kind !== 'durable') throw new Error('expected durable test profile')
    const vfs = new MemoryVfs({ sink: opened.mirror })
    vfs.seedDirectory('/dsh/home')
    vfs.writeFileSync('/dsh/home/one', 'one')
    await vfs.flush()
    vfs.writeFileSync('/dsh/home/two', 'two')
    await vfs.flush()
    expect(vfs.readFileSync('/dsh/home/two', 'utf8')).toBe('two')
    expect(put).toHaveBeenCalledOnce()
    expect(failures).toHaveLength(1)
    await opened.release()
  })

  it('skips mutations that were queued behind the first durable write failure', async () => {
    const backend = new MemoryBackend()
    const put = vi.spyOn(backend, 'putEntries').mockRejectedValueOnce(undefined)
    const failures: unknown[] = []
    const opened = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'), locks: grantedLocks(),
      crypto: webcrypto as unknown as Crypto,
      onFailure: (reason) => { failures.push(reason) },
    })
    if (opened.kind !== 'durable') throw new Error('expected durable test profile')
    const vfs = new MemoryVfs({ sink: opened.mirror })
    vfs.seedDirectory('/dsh/home')
    vfs.writeFileSync('/dsh/home/one', 'one')
    vfs.writeFileSync('/dsh/home/two', 'two')
    await vfs.flush()
    expect(put).toHaveBeenCalledOnce()
    expect(failures).toHaveLength(1)
    await opened.release()
  })

  it('commits every hard-linked name through one atomic backend mutation', async () => {
    const backend = new MemoryBackend()
    const put = vi.spyOn(backend, 'putEntries')
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/home')
    vfs.writeFileSync('/dsh/home/object', 'shared')
    await vfs.flush()
    put.mockClear()
    vfs.linkSync('/dsh/home/object', '/dsh/home/alias')
    await vfs.flush()
    expect(put).toHaveBeenCalledOnce()
    expect(put.mock.calls[0]?.[0]).toHaveLength(2)

    put.mockClear()
    vfs.writeFileSync('/dsh/home/object', 'changed')
    await vfs.flush()
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls.every(call => call[0].length === 2)).toBe(true)
  })

  it('persists chmod snapshots for immutable-base entries and hard links', async () => {
    const backend = new MemoryBackend()
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/home')
    vfs.seed('/dsh/home/base', 'base')
    vfs.linkSync('/dsh/home/base', '/dsh/home/alias')
    await vfs.flush()
    vfs.chmodSync('/dsh/home/base', 0o600)
    await vfs.flush()

    const restoredMirror = await mirror(backend)
    const restored = new MemoryVfs({ sink: restoredMirror })
    await restoredMirror.hydrate(restored)
    expect(Number(restored.statSync('/dsh/home/base').mode) & 0o777).toBe(0o600)
    expect(Number(restored.statSync('/dsh/home/alias').mode) & 0o777).toBe(0o600)

    restored.seedDirectory('/dsh/workspace')
    restored.chmodSync('/dsh/workspace', 0o700)
    await restored.flush()
    const durableDirectory = [...backend.entries.values()].find(entry => entry.path === '/dsh/workspace')
    expect(durableDirectory?.kind).toBe('directory')
  })

  it('blocks a second writer while another tab owns the profile lease', async () => {
    let held = false
    const locks: WebLockManager = {
      request: async (_name, _options, callback) => {
        if (held) { await callback(null); return }
        held = true
        try { await callback({ name: _name, mode: 'exclusive' }) } finally { held = false }
      },
    }
    const backend = new MemoryBackend()
    const first = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'),
      locks, crypto: webcrypto as unknown as Crypto,
    })
    const second = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'),
      locks, crypto: webcrypto as unknown as Crypto,
    })
    expect(first.kind).toBe('durable')
    expect(second).toEqual({ kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_IN_USE' })
    if (first.kind === 'durable') await first.release()
  })

  it('falls back to session-only when durable storage initialization fails', async () => {
    const backend = new MemoryBackend()
    vi.spyOn(backend, 'getOrCreateProfile').mockRejectedValue(new Error('IndexedDB unavailable'))
    const opened = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'), locks: grantedLocks(),
      crypto: webcrypto as unknown as Crypto,
    })
    expect(opened).toEqual({ kind: 'session_only', reasonCode: 'WEB_DSH_STORAGE_UNAVAILABLE' })
  })

  it('uses stable boundaries for a failed Web Lock API and corrupt profile metadata', async () => {
    const backend = new MemoryBackend()
    const lockFailure = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'), crypto: webcrypto as unknown as Crypto,
      locks: { request: async () => { throw new Error('locks unavailable') } },
    })
    expect(lockFailure).toEqual({
      kind: 'session_only', reasonCode: 'WEB_DSH_EXCLUSIVE_LOCK_UNAVAILABLE',
    })

    backend.profiles.set(`staging:${profileId}`, {
      namespace: `staging:${profileId}`, createdAt: 0,
      keyCheckIv: new Uint8Array(1), keyCheckCiphertext: new ArrayBuffer(16),
    })
    const corrupt = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, backend, storage: durableStorage,
      encryptionKey: await keyFor('staging'), locks: grantedLocks(), crypto: webcrypto as unknown as Crypto,
    })
    expect(corrupt).toEqual({ kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_CORRUPT' })
  })

  it('rejects non-canonical paths and authenticated metadata tampering', async () => {
    const backend = new MemoryBackend()
    const localMirror = await mirror(backend)
    const vfs = new MemoryVfs({ sink: localMirror })
    vfs.seedDirectory('/dsh/home')
    vfs.mkdirSync('/dsh/home/sessions')
    vfs.writeFileSync('/dsh/home/session.jsonl', 'private')
    await vfs.flush()

    const storedFile = [...backend.entries.values()].find(entry => entry.kind === 'file')
    if (storedFile?.kind !== 'file') throw new Error('expected durable file')
    backend.entries.set(storedFile.id, { ...storedFile, mode: 0o777 })
    await expect((await mirror(backend)).hydrate(new MemoryVfs()))
      .rejects.toThrow('WEB_DSH_PROFILE_CORRUPT')

    backend.entries.delete(storedFile.id)
    const storedDirectory = [...backend.entries.values()].find(entry => entry.kind === 'directory')
    if (storedDirectory?.kind !== 'directory') throw new Error('expected durable directory')
    const path = '/dsh/home/../config'
    const namespace = `staging:${profileId}`
    backend.entries.clear()
    backend.entries.set(`${namespace}\u0000${path}`, {
      ...storedDirectory,
      id: `${namespace}\u0000${path}`,
      path,
    })
    await expect((await mirror(backend)).hydrate(new MemoryVfs()))
      .rejects.toThrow('WEB_DSH_PROFILE_CORRUPT')
  })

  it('never stores the unwrapped key and rejects incorrect unlock material', async () => {
    const backend = new MemoryBackend()
    const first = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, encryptionKey: await keyFor('staging'),
      backend, storage: durableStorage, locks: grantedLocks(), crypto: webcrypto as unknown as Crypto,
    })
    expect(first.kind).toBe('durable')
    if (first.kind === 'durable') await first.release()
    expect(JSON.stringify([...backend.profiles.values()])).not.toContain('encryptionKey')

    const wrongKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt', 'decrypt',
    ])
    const reopened = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, encryptionKey: wrongKey,
      backend, storage: durableStorage, locks: grantedLocks(), crypto: webcrypto as unknown as Crypto,
    })
    expect(reopened).toEqual({ kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_LOCKED' })
  })
})
