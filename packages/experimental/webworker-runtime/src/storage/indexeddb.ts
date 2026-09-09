/** Encrypted, environment-scoped persistence for the browser Worker VFS. */
import { DEFAULT_ROOT, IMAGE_OVERLAY_DIRECTORIES } from '../image-layout.ts'
import { join, normalize } from '../module-system/posix-path.ts'
import type { MemoryVfs } from './memory.ts'
import type { VfsMutation, VfsMutationSink } from './types.ts'

const DATABASE_NAME = 'dsh-web-local-vfs'
const DATABASE_VERSION = 1
const PROFILE_STORE = 'profiles'
const ENTRY_STORE = 'entries'
const ENTRY_NAMESPACE_INDEX = 'namespace'
const ENTRY_VERSION = 1 as const
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Durable key-check envelope for one environment-scoped local profile. */
export interface StoredVfsProfile {
  readonly namespace: string
  readonly createdAt: number
  readonly keyCheckIv: Uint8Array<ArrayBuffer>
  readonly keyCheckCiphertext: ArrayBuffer
}

interface StoredVfsEntryBase {
  readonly id: string
  readonly namespace: string
  readonly version: typeof ENTRY_VERSION
  readonly path: string
  readonly mode: number
  readonly mtimeMs: number
}

/** Encrypted file or directory metadata stored for one profile namespace. */
export type StoredVfsEntry =
  | StoredVfsEntryBase & {
    readonly kind: 'file'
    readonly linkGroup: string
    readonly iv: Uint8Array<ArrayBuffer>
    readonly ciphertext: ArrayBuffer
  }
  | StoredVfsEntryBase & {
    readonly kind: 'directory'
    readonly iv: Uint8Array<ArrayBuffer>
    readonly ciphertext: ArrayBuffer
  }

/** Storage seam kept separate from crypto and mutation ordering for deterministic tests. */
export interface VfsProfileBackend {
  getOrCreateProfile(candidate: StoredVfsProfile): Promise<StoredVfsProfile>
  listEntries(namespace: string): Promise<readonly StoredVfsEntry[]>
  getEntry(namespace: string, path: string): Promise<StoredVfsEntry | null>
  /** Commit one logical mutation atomically, including every hard-linked name. */
  putEntries(entries: readonly StoredVfsEntry[]): Promise<void>
  removeSubtree(namespace: string, path: string): Promise<void>
}

/** Outcome of negotiating durable storage, exclusive ownership and profile decryption. */
export type WebVfsPersistenceAvailability =
  | {
    readonly kind: 'durable'
    readonly mirror: EncryptedVfsMirror
    readonly release: () => Promise<void>
  }
  | {
    readonly kind: 'session_only'
    readonly reasonCode:
      | 'WEB_DSH_STORAGE_NOT_DURABLE'
      | 'WEB_DSH_STORAGE_UNAVAILABLE'
      | 'WEB_DSH_EXCLUSIVE_LOCK_UNAVAILABLE'
  }
  | { readonly kind: 'blocked'; readonly reasonCode: 'WEB_DSH_PROFILE_IN_USE' }
  | { readonly kind: 'blocked'; readonly reasonCode: 'WEB_DSH_PROFILE_LOCKED' }
  | { readonly kind: 'blocked'; readonly reasonCode: 'WEB_DSH_PROFILE_CORRUPT' }

/** Minimal Web Locks capability required to hold one profile's exclusive lease. */
export interface WebLockManager {
  request(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable: true },
    callback: (lock: Lock | null) => Promise<void>,
  ): Promise<void>
}

/** Inputs and browser capability overrides for opening one encrypted local profile. */
export interface OpenWebVfsProfileOptions {
  readonly environmentId: string
  readonly profileId: string
  /** Non-extractable key unwrapped by page-side passkey PRF or recovery material. */
  readonly encryptionKey: CryptoKey
  readonly backend?: VfsProfileBackend
  readonly storage?: Pick<StorageManager, 'persisted' | 'persist'> | null
  readonly locks?: WebLockManager | null
  readonly crypto?: Crypto
  readonly now?: () => number
  readonly onFailure?: (reason: unknown) => void
}

function profileNamespace(environmentId: string, profileId: string): string {
  if (!IDENTIFIER.test(environmentId)) throw new Error('web VFS: invalid environment id')
  if (!PROFILE_ID.test(profileId)) throw new Error('web VFS: invalid profile id')
  return `${environmentId}:${profileId}`
}

function persistedRoot(path: string): boolean {
  if (normalize(path) !== path) return false
  return IMAGE_OVERLAY_DIRECTORIES.some((directory) => {
    const root = join(DEFAULT_ROOT, directory)
    return path === root || path.startsWith(`${root}/`)
  })
}

function mutationTouchesPersistence(mutation: VfsMutation): boolean {
  if (persistedRoot(mutation.path)) return true
  if (mutation.kind !== 'remove') return false
  const prefix = mutation.path === '/' ? '/' : `${mutation.path}/`
  return IMAGE_OVERLAY_DIRECTORIES.some(directory =>
    join(DEFAULT_ROOT, directory).startsWith(prefix))
}

function entryId(namespace: string, path: string): string {
  return `${namespace}\u0000${path}`
}

function associatedData(
  entry: Pick<StoredVfsEntry, 'namespace' | 'version' | 'path' | 'kind' | 'mode' | 'mtimeMs'>
    & { readonly linkGroup?: string },
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({
    namespace: entry.namespace,
    version: entry.version,
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    ...(entry.linkGroup === undefined ? {} : { linkGroup: entry.linkGroup }),
  }))
}

function validateEntry(value: unknown, namespace: string): asserts value is StoredVfsEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.path !== 'string' || entry.id !== entryId(namespace, entry.path)
    || entry.namespace !== namespace || entry.version !== ENTRY_VERSION || !persistedRoot(entry.path)
    || !Number.isInteger(entry.mode) || (entry.mode as number) < 0 || (entry.mode as number) > 0o777
    || !Number.isSafeInteger(entry.mtimeMs) || (entry.mtimeMs as number) < 0) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
  if (entry.kind === 'file') {
    if (Object.keys(entry).toSorted().join(',')
      !== 'ciphertext,id,iv,kind,linkGroup,mode,mtimeMs,namespace,path,version'
      || typeof entry.linkGroup !== 'string' || entry.linkGroup.length < 1 || entry.linkGroup.length > 128
      || !(entry.iv instanceof Uint8Array) || entry.iv.byteLength !== 12
      || !(entry.ciphertext instanceof ArrayBuffer) || entry.ciphertext.byteLength < 16) {
      throw new Error('WEB_DSH_PROFILE_CORRUPT')
    }
    return
  }
  if (entry.kind !== 'directory'
    || Object.keys(entry).toSorted().join(',') !== 'ciphertext,id,iv,kind,mode,mtimeMs,namespace,path,version'
    || !(entry.iv instanceof Uint8Array) || entry.iv.byteLength !== 12
    || !(entry.ciphertext instanceof ArrayBuffer) || entry.ciphertext.byteLength !== 16) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
}

function cloneMutation(mutation: VfsMutation): VfsMutation {
  return mutation.kind === 'write' || mutation.kind === 'chmod' && mutation.entryKind === 'file'
    ? { ...mutation, bytes: mutation.bytes.slice() }
    : { ...mutation }
}

const KEY_CHECK_PLAINTEXT = new TextEncoder().encode('dsh-web-vfs-profile-key/v1')

function keyCheckData(namespace: string, createdAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ namespace, createdAt, purpose: 'profile-key-check', version: 1 }))
}

function validEncryptionKey(key: CryptoKey): boolean {
  return key.type === 'secret' && !key.extractable
    && key.algorithm.name === 'AES-GCM'
    && (key.algorithm as AesKeyAlgorithm).length === 256
    && key.usages.includes('encrypt') && key.usages.includes('decrypt')
}

function validateProfile(value: unknown, namespace: string): asserts value is StoredVfsProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
  const profile = value as Record<string, unknown>
  if (Object.keys(profile).toSorted().join(',') !== 'createdAt,keyCheckCiphertext,keyCheckIv,namespace'
    || profile.namespace !== namespace || !Number.isSafeInteger(profile.createdAt)
    || (profile.createdAt as number) < 0
    || !(profile.keyCheckIv instanceof Uint8Array) || profile.keyCheckIv.byteLength !== 12
    || !(profile.keyCheckCiphertext instanceof ArrayBuffer) || profile.keyCheckCiphertext.byteLength < 16) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
}

async function createProfileEnvelope(
  namespace: string,
  key: CryptoKey,
  crypto: Crypto,
  createdAt: number,
): Promise<StoredVfsProfile> {
  const keyCheckIv = crypto.getRandomValues(new Uint8Array(12))
  const keyCheckCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: keyCheckIv, additionalData: keyCheckData(namespace, createdAt) },
    key,
    KEY_CHECK_PLAINTEXT,
  )
  return { namespace, createdAt, keyCheckIv, keyCheckCiphertext }
}

async function profileAcceptsKey(
  profile: StoredVfsProfile,
  key: CryptoKey,
  crypto: Crypto,
): Promise<boolean> {
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM', iv: profile.keyCheckIv,
        additionalData: keyCheckData(profile.namespace, profile.createdAt),
      },
      key,
      profile.keyCheckCiphertext,
    ))
    return plaintext.length === KEY_CHECK_PLAINTEXT.length
      && plaintext.every((byte, index) => byte === KEY_CHECK_PLAINTEXT[index])
  } catch {
    return false
  }
}

/** Ordered encrypted write-behind mirror; one failed write permanently stops this instance. */
export class EncryptedVfsMirror implements VfsMutationSink {
  private pending: Promise<void> = Promise.resolve()
  private failed = false

  constructor(
    private readonly namespace: string,
    private readonly key: CryptoKey,
    private readonly backend: VfsProfileBackend,
    private readonly crypto: Crypto,
    private readonly now: () => number,
    private readonly onFailure: (reason: unknown) => void,
  ) {}

  record(mutation: VfsMutation): void {
    if (this.failed || !mutationTouchesPersistence(mutation)) return
    const captured = cloneMutation(mutation)
    this.pending = this.pending
      .then(async () => {
        if (!this.failed) await this.apply(captured)
      })
      .catch((reason: unknown) => {
        this.failed = true
        try {
          this.onFailure(reason)
        } catch (callbackError) {
          console.error('web VFS: failure observer failed', callbackError)
        }
      })
  }

  async flush(): Promise<void> {
    await this.pending
  }

  /**
   * Apply the last durable snapshot over the immutable base image before the tree boots.
   * @param vfs - In-memory filesystem that receives the decrypted profile overlay.
   */
  async hydrate(vfs: MemoryVfs): Promise<void> {
    const entries = await this.backend.listEntries(this.namespace)
    for (const entry of entries) validateEntry(entry, this.namespace)
    const directories = entries
      .filter(entry => entry.kind === 'directory')
      .toSorted((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path))
    const files = entries
      .filter(entry => entry.kind === 'file')
      .toSorted((left, right) => left.path.localeCompare(right.path))
    for (const entry of directories) {
      if ((await this.decryptEntry(entry)).byteLength !== 0) {
        throw new Error('WEB_DSH_PROFILE_CORRUPT')
      }
      vfs.seedDirectory(entry.path, { mode: entry.mode, mtimeMs: entry.mtimeMs })
    }
    for (const entry of files) {
      const plaintext = await this.decryptEntry(entry)
      vfs.seed(entry.path, new Uint8Array(plaintext), {
        mode: entry.mode, mtimeMs: entry.mtimeMs, linkGroup: entry.linkGroup,
      })
    }
  }

  private async apply(mutation: VfsMutation): Promise<void> {
    if (mutation.kind === 'remove') {
      await this.backend.removeSubtree(this.namespace, mutation.path)
      return
    }
    if (mutation.kind === 'chmod') {
      if (mutation.entryKind === 'directory') {
        await this.putEncryptedDirectory(mutation.path, mutation.mode)
      } else {
        await this.putEncryptedFiles(
          mutation.linkedPaths,
          mutation.bytes,
          mutation.linkGroup,
          mutation.mode,
        )
      }
      return
    }
    if (mutation.kind === 'mkdir') {
      await this.putEncryptedDirectory(mutation.path, mutation.mode)
      return
    }
    await this.putEncryptedFiles(
      mutation.linkedPaths,
      mutation.bytes,
      mutation.linkGroup,
      mutation.mode,
    )
  }

  private async putEncryptedFiles(
    paths: readonly string[],
    bytes: Uint8Array,
    linkGroup: string,
    mode: number,
  ): Promise<void> {
    const entries: StoredVfsEntry[] = []
    for (const path of paths.filter(persistedRoot)) {
      const envelope = {
        id: entryId(this.namespace, path),
        namespace: this.namespace,
        version: ENTRY_VERSION,
        path,
        kind: 'file' as const,
        linkGroup,
        mode,
        mtimeMs: this.now(),
      }
      const iv = this.crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await this.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: associatedData(envelope) },
        this.key,
        Uint8Array.from(bytes),
      )
      entries.push({ ...envelope, iv, ciphertext })
    }
    if (entries.length > 0) await this.backend.putEntries(entries)
  }

  private async putEncryptedDirectory(path: string, mode: number): Promise<void> {
    const envelope = {
      id: entryId(this.namespace, path),
      namespace: this.namespace,
      version: ENTRY_VERSION,
      path,
      kind: 'directory' as const,
      mode,
      mtimeMs: this.now(),
    }
    const iv = this.crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await this.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData(envelope) },
      this.key,
      new Uint8Array(),
    )
    await this.backend.putEntries([{ ...envelope, iv, ciphertext }])
  }

  private async decryptEntry(entry: StoredVfsEntry): Promise<ArrayBuffer> {
    try {
      return await this.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: entry.iv, additionalData: associatedData(entry) },
        this.key,
        entry.ciphertext,
      )
    } catch (cause) {
      throw new Error('WEB_DSH_PROFILE_CORRUPT', { cause })
    }
  }
}

/**
 * Open one encrypted profile under a durable exclusive browser lease.
 * @param options - Exact environment/profile identity, unlocked key and optional browser replacements.
 * @returns Durable access, a session-only reason, or a fail-closed profile reason.
 */
export async function openEncryptedWebVfsProfile(
  options: OpenWebVfsProfileOptions,
): Promise<WebVfsPersistenceAvailability> {
  const namespace = profileNamespace(options.environmentId, options.profileId)
  const storage = options.storage === undefined
    ? typeof navigator === 'undefined' ? null : navigator.storage
    : options.storage
  let durable = false
  try {
    durable = storage !== null && (await storage.persisted() || await storage.persist())
  } catch {
    durable = false
  }
  if (!durable) return { kind: 'session_only', reasonCode: 'WEB_DSH_STORAGE_NOT_DURABLE' }

  const locks = options.locks === undefined
    ? typeof navigator === 'undefined' ? null : navigator.locks
    : options.locks
  if (locks === null) {
    return { kind: 'session_only', reasonCode: 'WEB_DSH_EXCLUSIVE_LOCK_UNAVAILABLE' }
  }
  let lease: ExclusiveProfileLease | null
  try {
    lease = await acquireExclusiveProfileLease(locks, namespace)
  } catch (reason) {
    options.onFailure?.(reason)
    return { kind: 'session_only', reasonCode: 'WEB_DSH_EXCLUSIVE_LOCK_UNAVAILABLE' }
  }
  if (lease === null) return { kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_IN_USE' }

  const crypto = options.crypto ?? globalThis.crypto
  if (!validEncryptionKey(options.encryptionKey)) {
    await lease.release()
    return { kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_LOCKED' }
  }
  try {
    const backend = options.backend ?? new IndexedDbVfsProfileBackend()
    const profile = await backend.getOrCreateProfile(await createProfileEnvelope(
      namespace, options.encryptionKey, crypto, (options.now ?? Date.now)(),
    ))
    validateProfile(profile, namespace)
    if (!await profileAcceptsKey(profile, options.encryptionKey, crypto)) {
      await lease.release()
      return { kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_LOCKED' }
    }
    return {
      kind: 'durable',
      mirror: new EncryptedVfsMirror(
        namespace,
        options.encryptionKey,
        backend,
        crypto,
        options.now ?? Date.now,
        options.onFailure ?? ((reason) => { console.error('web VFS: durable mirror stopped', reason) }),
      ),
      release: lease.release,
    }
  } catch (reason) {
    await lease.release()
    options.onFailure?.(reason)
    if (reason instanceof Error && reason.message === 'WEB_DSH_PROFILE_CORRUPT') {
      return { kind: 'blocked', reasonCode: 'WEB_DSH_PROFILE_CORRUPT' }
    }
    return { kind: 'session_only', reasonCode: 'WEB_DSH_STORAGE_UNAVAILABLE' }
  }
}

interface ExclusiveProfileLease {
  readonly release: () => Promise<void>
}

async function acquireExclusiveProfileLease(
  locks: WebLockManager,
  namespace: string,
): Promise<ExclusiveProfileLease | null> {
  const acquired = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<void>()
  const completed = locks.request(
    `dsh-web-vfs:${namespace}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      acquired.resolve(lock !== null)
      if (lock !== null) await release.promise
    },
  )
  void completed.catch((reason: unknown) => { acquired.reject(reason) })
  if (!await acquired.promise) {
    await completed
    return null
  }
  let released = false
  return {
    release: async () => {
      if (!released) { released = true; release.resolve() }
      await completed
    },
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        database.createObjectStore(PROFILE_STORE, { keyPath: 'namespace' })
      }
      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        database.createObjectStore(ENTRY_STORE, { keyPath: 'id' })
          .createIndex(ENTRY_NAMESPACE_INDEX, 'namespace', { unique: false })
      }
    }
    request.onsuccess = () => {
      if (settled) { request.result.close(); return }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (settled) return
      settled = true
      reject(request.error ?? new Error('web VFS: IndexedDB open failed'))
    }
    request.onblocked = () => {
      if (settled) return
      settled = true
      reject(new Error('web VFS: IndexedDB upgrade blocked'))
    }
  })
}

function settleTransaction<T>(
  database: IDBDatabase,
  transaction: IDBTransaction,
  operation: (finish: (value: T) => void, reject: (reason: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let value: T
    let hasValue = false
    operation((next) => { value = next; hasValue = true }, reject)
    transaction.oncomplete = () => {
      database.close()
      if (hasValue) resolve(value)
      else reject(new Error('web VFS: IndexedDB transaction completed without a result'))
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('web VFS: IndexedDB transaction failed'))
    }
    transaction.onabort = transaction.onerror
  })
}

/** IndexedDB backend used inside the dedicated Host Worker. */
export class IndexedDbVfsProfileBackend implements VfsProfileBackend {
  async getOrCreateProfile(candidate: StoredVfsProfile): Promise<StoredVfsProfile> {
    const database = await openDatabase()
    const transaction = database.transaction(PROFILE_STORE, 'readwrite')
    const store = transaction.objectStore(PROFILE_STORE)
    return await settleTransaction(database, transaction, (finish, reject) => {
      const request = store.get(candidate.namespace)
      request.onsuccess = () => {
        const found = request.result as StoredVfsProfile | undefined
        if (found !== undefined) { finish(found); return }
        const write = store.put(candidate)
        write.onsuccess = () => { finish(candidate) }
        write.onerror = () => { reject(write.error) }
      }
      request.onerror = () => { reject(request.error) }
    })
  }

  async listEntries(namespace: string): Promise<readonly StoredVfsEntry[]> {
    const database = await openDatabase()
    const transaction = database.transaction(ENTRY_STORE, 'readonly')
    return await settleTransaction(database, transaction, (finish, reject) => {
      const request = transaction.objectStore(ENTRY_STORE).index(ENTRY_NAMESPACE_INDEX).getAll(namespace)
      request.onsuccess = () => { finish(request.result as StoredVfsEntry[]) }
      request.onerror = () => { reject(request.error) }
    })
  }

  async getEntry(namespace: string, path: string): Promise<StoredVfsEntry | null> {
    const database = await openDatabase()
    const transaction = database.transaction(ENTRY_STORE, 'readonly')
    return await settleTransaction(database, transaction, (finish, reject) => {
      const request = transaction.objectStore(ENTRY_STORE).get(entryId(namespace, path))
      request.onsuccess = () => { finish((request.result as StoredVfsEntry | undefined) ?? null) }
      request.onerror = () => { reject(request.error) }
    })
  }

  async putEntries(entries: readonly StoredVfsEntry[]): Promise<void> {
    if (entries.length === 0) return
    const database = await openDatabase()
    const transaction = database.transaction(ENTRY_STORE, 'readwrite')
    await settleTransaction(database, transaction, (finish, reject) => {
      const store = transaction.objectStore(ENTRY_STORE)
      let remaining = entries.length
      for (const entry of entries) {
        const request = store.put(entry)
        request.onsuccess = () => {
          remaining -= 1
          if (remaining === 0) finish(undefined)
        }
        request.onerror = () => { reject(request.error) }
      }
    })
  }

  async removeSubtree(namespace: string, path: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(ENTRY_STORE, 'readwrite')
    const store = transaction.objectStore(ENTRY_STORE)
    await settleTransaction(database, transaction, (finish, reject) => {
      const request = store.index(ENTRY_NAMESPACE_INDEX).getAll(namespace)
      request.onsuccess = () => {
        const prefix = `${path}/`
        for (const entry of request.result as StoredVfsEntry[]) {
          if (entry.path === path || entry.path.startsWith(prefix)) store.delete(entry.id)
        }
        finish(undefined)
      }
      request.onerror = () => { reject(request.error) }
    })
  }
}
