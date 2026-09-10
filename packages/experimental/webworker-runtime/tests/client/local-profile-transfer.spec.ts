import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import {
  openEncryptedWebVfsProfile,
  type StoredVfsEntry,
  type StoredVfsProfile,
  type VfsProfileBackend,
  type WebLockManager,
} from '../../src/storage/indexeddb.ts'
import { createWebDshLocalProfileRecord } from '../../src/client/local-profile-registry.ts'
import {
  exportWebDshRecoveryPack,
  importWebDshRecoveryPack,
  initializeWebDshLocalProfile,
  IndexedDbWebDshLocalProfileSnapshotStore,
  parseWebDshRecoveryPack,
  type WebDshLocalProfileSnapshot,
  type WebDshLocalProfileSnapshotStore,
} from '../../src/client/local-profile-transfer.ts'
import {
  enrollWebDshLocalProfile,
  type WebDshLocalProfileEnrollment,
} from '../../src/client/passkey-profile.ts'

const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140'
const namespace = `staging:${profileId}`
const passphrase = 'correct horse battery staple 2026'
const prf = Uint8Array.from({ length: 32 }, (_, index) => index + 1).buffer

class FakePublicKeyCredential {
  readonly rawId = Uint8Array.from({ length: 32 }, (_, index) => 255 - index).buffer
  getClientExtensionResults(): object {
    return { prf: { enabled: true, results: { first: prf.slice(0) } } }
  }
}

class MemoryBackend implements VfsProfileBackend {
  readonly profiles = new Map<string, StoredVfsProfile>()
  readonly entries = new Map<string, StoredVfsEntry>()

  async getOrCreateProfile(candidate: StoredVfsProfile): Promise<StoredVfsProfile> {
    const profile = this.profiles.get(candidate.namespace) ?? candidate
    this.profiles.set(profile.namespace, profile)
    return profile
  }

  async listEntries(expectedNamespace: string): Promise<readonly StoredVfsEntry[]> {
    return [...this.entries.values()].filter(entry => entry.namespace === expectedNamespace)
  }

  async getEntry(expectedNamespace: string, path: string): Promise<StoredVfsEntry | null> {
    return [...this.entries.values()].find(entry =>
      entry.namespace === expectedNamespace && entry.path === path) ?? null
  }

  async putEntries(entries: readonly StoredVfsEntry[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.id, entry)
  }

  async removeSubtree(expectedNamespace: string, path: string): Promise<void> {
    const prefix = `${path}/`
    for (const [id, entry] of this.entries) {
      if (entry.namespace === expectedNamespace
        && (entry.path === path || entry.path.startsWith(prefix))) this.entries.delete(id)
    }
  }
}

class MemorySnapshotStore implements WebDshLocalProfileSnapshotStore {
  imported: WebDshLocalProfileSnapshot | null = null

  constructor(private readonly source: WebDshLocalProfileSnapshot | null = null) {}

  async readSnapshot(environmentId: string, expectedProfileId: string) {
    if (this.source?.record.environmentId !== environmentId
      || this.source.record.profileId !== expectedProfileId) return null
    return this.source
  }

  async importSnapshot(snapshot: WebDshLocalProfileSnapshot): Promise<void> {
    if (this.imported !== null) throw new Error('WEB_DSH_PROFILE_ALREADY_EXISTS')
    this.imported = snapshot
  }
}

const durableStorage = { persisted: async () => true, persist: async () => true }

function grantedLocks(): WebLockManager {
  return {
    request: async (_name, _options, callback) => {
      await callback({ name: _name, mode: 'exclusive' })
    },
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: FakePublicKeyCredential,
    configurable: true,
  })
})

async function fixture(): Promise<{
  enrollment: WebDshLocalProfileEnrollment
  snapshot: WebDshLocalProfileSnapshot
  encryptionKey: CryptoKey
}> {
  const enrolled = await enrollWebDshLocalProfile(
    'staging',
    { relyingParty: 'DSH Web', profile: 'Local workspace' },
    passphrase,
    {
      credentials: {
        create: async () => new FakePublicKeyCredential() as unknown as Credential,
        get: async () => new FakePublicKeyCredential() as unknown as Credential,
      },
      crypto: webcrypto as unknown as Crypto,
      randomUuid: () => profileId,
      now: () => 1_800_000_000_000,
    },
  )
  const backend = new MemoryBackend()
  const opened = await openEncryptedWebVfsProfile({
    environmentId: 'staging', profileId, encryptionKey: enrolled.encryptionKey,
    backend, storage: durableStorage, locks: grantedLocks(),
    crypto: webcrypto as unknown as Crypto, now: () => 1_800_000_000_000,
  })
  if (opened.kind !== 'durable') throw new Error('expected durable fixture')
  const vfs = new MemoryVfs({ sink: opened.mirror })
  vfs.seedDirectory('/dsh/workspace')
  vfs.writeFileSync('/dsh/workspace/private.txt', 'private local content')
  await vfs.flush()
  await opened.release()
  const profile = backend.profiles.get(namespace)
  if (profile === undefined) throw new Error('expected stored profile')
  return {
    enrollment: enrolled,
    encryptionKey: enrolled.encryptionKey,
    snapshot: {
      record: createWebDshLocalProfileRecord('My local workspace', enrolled),
      vfsProfile: profile,
      entries: [...backend.entries.values()],
    },
  }
}

describe('encrypted Web-local recovery pack', () => {
  it('initializes registry metadata and the VFS key check as one empty snapshot', async () => {
    const source = await fixture()
    const destination = new MemorySnapshotStore()
    const initialization = initializeWebDshLocalProfile({
      displayName: 'My local workspace',
      enrollment: source.enrollment,
      store: destination,
      crypto: webcrypto as unknown as Crypto,
    })
    Object.assign(source.enrollment.passkeyEnvelope, { environmentId: 'production' })
    await initialization
    expect(destination.imported).toMatchObject({
      record: {
        environmentId: 'staging', profileId,
        passkeyEnvelope: { environmentId: 'staging' },
      },
      vfsProfile: { namespace },
      entries: [],
    })
  })

  it('round-trips an authenticated complete profile snapshot with recovery material', async () => {
    const source = await fixture()
    const pack = await exportWebDshRecoveryPack({
      environmentId: 'staging', profileId, encryptionKey: source.encryptionKey,
      store: new MemorySnapshotStore(source.snapshot),
      crypto: webcrypto as unknown as Crypto, now: () => 1_800_000_000_123,
    })
    expect(pack).not.toContain('private local content')
    expect(parseWebDshRecoveryPack(pack)).toMatchObject({
      version: 1, environmentId: 'staging', profileId,
    })

    const destination = new MemorySnapshotStore()
    const imported = await importWebDshRecoveryPack({
      expectedEnvironmentId: 'staging', pack, recoveryPassphrase: passphrase,
      store: destination, crypto: webcrypto as unknown as Crypto,
    })
    expect(imported.record.displayName).toBe('My local workspace')
    expect(imported.encryptionKey.extractable).toBe(false)
    expect(destination.imported).not.toBeNull()

    const restoredBackend = new MemoryBackend()
    if (destination.imported === null) throw new Error('expected imported snapshot')
    restoredBackend.profiles.set(namespace, destination.imported.vfsProfile)
    for (const entry of destination.imported.entries) restoredBackend.entries.set(entry.id, entry)
    const opened = await openEncryptedWebVfsProfile({
      environmentId: 'staging', profileId, encryptionKey: imported.encryptionKey,
      backend: restoredBackend, storage: durableStorage, locks: grantedLocks(),
      crypto: webcrypto as unknown as Crypto,
    })
    if (opened.kind !== 'durable') throw new Error('expected recovered profile')
    const restored = new MemoryVfs()
    await opened.mirror.hydrate(restored)
    expect(restored.readFileSync('/dsh/workspace/private.txt', 'utf8'))
      .toBe('private local content')
    await opened.release()
  })

  it('fails before storage mutation for wrong phrases, environment mismatch, or tampering', async () => {
    const source = await fixture()
    const pack = await exportWebDshRecoveryPack({
      environmentId: 'staging', profileId, encryptionKey: source.encryptionKey,
      store: new MemorySnapshotStore(source.snapshot), crypto: webcrypto as unknown as Crypto,
    })
    const tampered = JSON.parse(pack) as { ciphertext: string }
    tampered.ciphertext = `${tampered.ciphertext.slice(0, -1)}${tampered.ciphertext.endsWith('A') ? 'B' : 'A'}`
    for (const [expectedEnvironmentId, candidatePack, phrase] of [
      ['staging', pack, 'a different recovery phrase 2026'],
      ['production', pack, passphrase],
      ['staging', JSON.stringify(tampered), passphrase],
    ] as const) {
      const destination = new MemorySnapshotStore()
      await expect(importWebDshRecoveryPack({
        expectedEnvironmentId, pack: candidatePack, recoveryPassphrase: phrase,
        store: destination, crypto: webcrypto as unknown as Crypto,
      })).rejects.toThrow()
      expect(destination.imported).toBeNull()
    }
  })

  it('rejects unknown fields and refuses to overwrite an existing profile', async () => {
    const source = await fixture()
    const pack = await exportWebDshRecoveryPack({
      environmentId: 'staging', profileId, encryptionKey: source.encryptionKey,
      store: new MemorySnapshotStore(source.snapshot), crypto: webcrypto as unknown as Crypto,
    })
    expect(parseWebDshRecoveryPack(JSON.stringify({ ...JSON.parse(pack), accountId: 'forbidden' })))
      .toBeNull()
    expect(parseWebDshRecoveryPack(null as unknown as string)).toBeNull()
    await expect(new IndexedDbWebDshLocalProfileSnapshotStore({} as IDBFactory)
      .importSnapshot(null))
      .rejects.toThrow('WEB_DSH_PROFILE_CORRUPT')
    const destination = new MemorySnapshotStore()
    destination.imported = source.snapshot
    await expect(importWebDshRecoveryPack({
      expectedEnvironmentId: 'staging', pack, recoveryPassphrase: passphrase,
      store: destination, crypto: webcrypto as unknown as Crypto,
    })).rejects.toThrow('WEB_DSH_PROFILE_ALREADY_EXISTS')
  })
})
