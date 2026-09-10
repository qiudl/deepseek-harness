/** Authenticated export and atomic import for one encrypted browser-local DSH profile. */

import {
  createWebDshLocalProfileRecord,
  parseWebDshLocalProfileRecord,
  type WebDshLocalProfileRecord,
} from './local-profile-registry.ts'
import {
  parseWebDshRecoveryEnvelope,
  unlockWebDshRecoveryProfile,
  type WebDshLocalProfileEnrollment,
  type WebDshRecoveryEnvelope,
} from './passkey-profile.ts'
import {
  createStoredVfsProfile,
  parseStoredVfsEntry,
  parseStoredVfsProfile,
  storedVfsProfileAcceptsKey,
  type StoredVfsEntry,
  type StoredVfsProfile,
} from '../storage/indexeddb.ts'
import {
  openWebDshDatabase,
  WEB_DSH_ENTRY_NAMESPACE_INDEX,
  WEB_DSH_ENTRY_STORE,
  WEB_DSH_LOCAL_PROFILE_STORE,
  WEB_DSH_VFS_PROFILE_STORE,
} from '../storage/indexeddb-schema.ts'

const PACK_VERSION = 1 as const
const PAYLOAD_VERSION = 1 as const
const MAX_PACK_CHARACTERS = 256 * 1024 * 1024
const MAX_ENTRY_COUNT = 100_000
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Authenticated recovery-pack header; only the encrypted payload contains VFS metadata. */
export interface WebDshRecoveryPack {
  readonly version: typeof PACK_VERSION
  readonly environmentId: string
  readonly profileId: string
  readonly createdAt: number
  readonly recoveryEnvelope: WebDshRecoveryEnvelope
  readonly iv: string
  readonly ciphertext: string
}

/** Complete consistent IndexedDB snapshot for one Web-local profile. */
export interface WebDshLocalProfileSnapshot {
  readonly record: WebDshLocalProfileRecord
  readonly vfsProfile: StoredVfsProfile
  readonly entries: readonly StoredVfsEntry[]
}

/** Storage seam for consistent export and all-or-nothing import. */
export interface WebDshLocalProfileSnapshotStore {
  /**
   * Read all profile records from one consistent database transaction.
   * @param environmentId - Exact environment owner.
   * @param profileId - Exact local profile identity.
   * @returns Complete snapshot, or `null` when no part of the profile exists.
   */
  readSnapshot(
    environmentId: string,
    profileId: string,
  ): Promise<WebDshLocalProfileSnapshot | null>
  /**
   * Insert one snapshot without replacing any existing registry, key-check, or entry record.
   * @param snapshot - Strict complete snapshot to commit through one transaction.
   */
  importSnapshot(snapshot: WebDshLocalProfileSnapshot): Promise<void>
}

/** Inputs for creating one authenticated recovery pack. */
export interface ExportWebDshRecoveryPackOptions {
  readonly environmentId: string
  readonly profileId: string
  readonly encryptionKey: CryptoKey
  readonly store?: WebDshLocalProfileSnapshotStore
  readonly crypto?: Crypto
  readonly now?: () => number
}

/** Inputs for recovering and atomically importing one authenticated profile pack. */
export interface ImportWebDshRecoveryPackOptions {
  readonly expectedEnvironmentId: string
  readonly pack: string
  readonly recoveryPassphrase: string
  readonly store?: WebDshLocalProfileSnapshotStore
  readonly crypto?: Crypto
}

/** Inputs for the one-time atomic creation of a newly enrolled local profile. */
export interface InitializeWebDshLocalProfileOptions {
  readonly displayName: string
  readonly enrollment: WebDshLocalProfileEnrollment
  readonly store?: WebDshLocalProfileSnapshotStore
  readonly crypto?: Crypto
}

/** Successful recovery import result for immediate local use. */
export interface ImportedWebDshLocalProfile {
  readonly record: WebDshLocalProfileRecord
  readonly encryptionKey: CryptoKey
}

interface SerializableVfsProfile {
  readonly namespace: string
  readonly createdAt: number
  readonly keyCheckIv: string
  readonly keyCheckCiphertext: string
}

interface SerializableVfsEntry {
  readonly id: string
  readonly namespace: string
  readonly version: 1
  readonly path: string
  readonly kind: 'file' | 'directory'
  readonly mode: number
  readonly mtimeMs: number
  readonly iv: string
  readonly ciphertext: string
  readonly linkGroup?: string
}

interface RecoveryPackPayload {
  readonly version: typeof PAYLOAD_VERSION
  readonly record: WebDshLocalProfileRecord
  readonly vfsProfile: SerializableVfsProfile
  readonly entries: readonly SerializableVfsEntry[]
}

function namespace(environmentId: string, profileId: string): string {
  if (!IDENTIFIER.test(environmentId) || !PROFILE_ID.test(profileId)) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  return `${environmentId}:${profileId}`
}

function validEncryptionKey(key: CryptoKey): boolean {
  return key.type === 'secret' && !key.extractable && key.algorithm.name === 'AES-GCM'
    && (key.algorithm as AesKeyAlgorithm).length === 256
    && key.usages.includes('encrypt') && key.usages.includes('decrypt')
}

function base64Url(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  const binary = chunks.join('')
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function decodeBase64Url(value: string, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (value.length < 1 || value.length > Math.ceil(maximum * 4 / 3) + 4 || !BASE64URL.test(value)) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding)
  const decoded = Uint8Array.from(binary, character => character.charCodeAt(0))
  if (decoded.byteLength < minimum || decoded.byteLength > maximum || base64Url(decoded) !== value) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  return decoded
}

function packHeader(pack: Omit<WebDshRecoveryPack, 'ciphertext'>): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(pack))
}

function sameRecoveryEnvelope(left: WebDshRecoveryEnvelope, right: WebDshRecoveryEnvelope): boolean {
  return left.environmentId === right.environmentId && left.profileId === right.profileId
    && left.createdAt === right.createdAt
    && left.recoverySalt === right.recoverySalt && left.wrappedDataKey === right.wrappedDataKey
}

function serializableProfile(profile: StoredVfsProfile): SerializableVfsProfile {
  return {
    namespace: profile.namespace,
    createdAt: profile.createdAt,
    keyCheckIv: base64Url(profile.keyCheckIv),
    keyCheckCiphertext: base64Url(new Uint8Array(profile.keyCheckCiphertext)),
  }
}

function serializableEntry(entry: StoredVfsEntry): SerializableVfsEntry {
  return {
    id: entry.id,
    namespace: entry.namespace,
    version: entry.version,
    path: entry.path,
    kind: entry.kind,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    iv: base64Url(entry.iv),
    ciphertext: base64Url(new Uint8Array(entry.ciphertext)),
    ...(entry.kind === 'file' ? { linkGroup: entry.linkGroup } : {}),
  }
}

function parseSerializableProfile(value: unknown, expectedNamespace: string): StoredVfsProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',')
    !== 'createdAt,keyCheckCiphertext,keyCheckIv,namespace'
    || item.namespace !== expectedNamespace || !Number.isSafeInteger(item.createdAt)
    || typeof item.keyCheckIv !== 'string' || typeof item.keyCheckCiphertext !== 'string') return null
  try {
    return parseStoredVfsProfile({
      namespace: item.namespace,
      createdAt: item.createdAt,
      keyCheckIv: decodeBase64Url(item.keyCheckIv, 12, 12),
      keyCheckCiphertext: decodeBase64Url(item.keyCheckCiphertext, 16, 1024).buffer,
    }, expectedNamespace)
  } catch {
    return null
  }
}

function parseSerializableEntry(value: unknown, expectedNamespace: string): StoredVfsEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const expectedKeys = item.kind === 'file'
    ? 'ciphertext,id,iv,kind,linkGroup,mode,mtimeMs,namespace,path,version'
    : 'ciphertext,id,iv,kind,mode,mtimeMs,namespace,path,version'
  if (Object.keys(item).toSorted().join(',') !== expectedKeys
    || typeof item.iv !== 'string' || typeof item.ciphertext !== 'string') return null
  try {
    return parseStoredVfsEntry({
      ...item,
      iv: decodeBase64Url(item.iv, 12, 12),
      ciphertext: decodeBase64Url(item.ciphertext, 16, MAX_PACK_CHARACTERS).buffer,
    }, expectedNamespace)
  } catch {
    return null
  }
}

function parsePayload(value: unknown, pack: WebDshRecoveryPack): WebDshLocalProfileSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',') !== 'entries,record,version,vfsProfile'
    || item.version !== PAYLOAD_VERSION || !Array.isArray(item.entries)
    || item.entries.length > MAX_ENTRY_COUNT) return null
  const record = parseWebDshLocalProfileRecord(item.record)
  const expectedNamespace = namespace(pack.environmentId, pack.profileId)
  const vfsProfile = parseSerializableProfile(item.vfsProfile, expectedNamespace)
  if (record === null || vfsProfile === null || record.environmentId !== pack.environmentId
    || record.profileId !== pack.profileId
    || !sameRecoveryEnvelope(record.recoveryEnvelope, pack.recoveryEnvelope)) return null
  const entries: StoredVfsEntry[] = []
  const ids = new Set<string>()
  let previousPath = ''
  for (const valueEntry of item.entries) {
    const entry = parseSerializableEntry(valueEntry, expectedNamespace)
    if (entry === null || ids.has(entry.id) || entry.path.localeCompare(previousPath) < 0) return null
    ids.add(entry.id)
    previousPath = entry.path
    entries.push(entry)
  }
  return { record, vfsProfile, entries }
}

function strictSnapshot(
  snapshot: unknown,
  environmentId: string,
  profileId: string,
): WebDshLocalProfileSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
  const item = snapshot as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',') !== 'entries,record,vfsProfile'
    || !Array.isArray(item.entries)) throw new Error('WEB_DSH_PROFILE_CORRUPT')
  const record = parseWebDshLocalProfileRecord(item.record)
  const expectedNamespace = namespace(environmentId, profileId)
  const vfsProfile = parseStoredVfsProfile(item.vfsProfile, expectedNamespace)
  if (record === null || record.environmentId !== environmentId || record.profileId !== profileId
    || vfsProfile === null || item.entries.length > MAX_ENTRY_COUNT) {
    throw new Error('WEB_DSH_PROFILE_CORRUPT')
  }
  const entries: StoredVfsEntry[] = []
  const ids = new Set<string>()
  for (const value of item.entries) {
    const entry = parseStoredVfsEntry(value, expectedNamespace)
    if (entry === null || ids.has(entry.id)) throw new Error('WEB_DSH_PROFILE_CORRUPT')
    ids.add(entry.id)
    entries.push(entry)
  }
  return { record, vfsProfile, entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)) }
}

/**
 * Parse an untrusted recovery-pack JSON header without deriving a key or mutating storage.
 * @param value - Serialized recovery pack selected by the user.
 * @returns Strict bounded pack header, or `null` for malformed or unsupported data.
 */
export function parseWebDshRecoveryPack(value: string): WebDshRecoveryPack | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_PACK_CHARACTERS) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const item = parsed as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',')
    !== 'ciphertext,createdAt,environmentId,iv,profileId,recoveryEnvelope,version'
    || item.version !== PACK_VERSION || typeof item.environmentId !== 'string'
    || typeof item.profileId !== 'string' || !IDENTIFIER.test(item.environmentId)
    || !PROFILE_ID.test(item.profileId) || !Number.isSafeInteger(item.createdAt)
    || (item.createdAt as number) < 0 || typeof item.iv !== 'string'
    || typeof item.ciphertext !== 'string') return null
  const recoveryEnvelope = parseWebDshRecoveryEnvelope(item.recoveryEnvelope)
  if (recoveryEnvelope === null || recoveryEnvelope.environmentId !== item.environmentId
    || recoveryEnvelope.profileId !== item.profileId) return null
  try {
    decodeBase64Url(item.iv, 12, 12)
    decodeBase64Url(item.ciphertext, 16, MAX_PACK_CHARACTERS)
  } catch {
    return null
  }
  return item as unknown as WebDshRecoveryPack
}

/**
 * Commit a new registry record and its VFS key check atomically before Worker startup.
 * @param options - Newly enrolled record, matching key, and browser storage seams.
 */
export async function initializeWebDshLocalProfile(
  options: InitializeWebDshLocalProfileOptions,
): Promise<void> {
  const record = parseWebDshLocalProfileRecord(structuredClone(
    createWebDshLocalProfileRecord(options.displayName, options.enrollment),
  ))
  if (record === null) throw new Error('WEB_DSH_PROFILE_RECORD_INVALID')
  if (!validEncryptionKey(options.enrollment.encryptionKey)) throw new Error('WEB_DSH_PROFILE_LOCKED')
  const expectedNamespace = namespace(record.environmentId, record.profileId)
  const vfsProfile = await createStoredVfsProfile(
    expectedNamespace,
    options.enrollment.encryptionKey,
    options.crypto ?? globalThis.crypto,
    record.createdAt,
  )
  await (options.store ?? new IndexedDbWebDshLocalProfileSnapshotStore()).importSnapshot({
    record,
    vfsProfile,
    entries: [],
  })
}

/**
 * Encrypt one consistent profile snapshot for user-controlled recovery export.
 * @param options - Exact profile identity, unlocked key, store and browser seams.
 * @returns Canonical JSON pack whose complete snapshot is authenticated and encrypted.
 */
export async function exportWebDshRecoveryPack(
  options: ExportWebDshRecoveryPackOptions,
): Promise<string> {
  if (!validEncryptionKey(options.encryptionKey)) throw new Error('WEB_DSH_PROFILE_LOCKED')
  const store = options.store ?? new IndexedDbWebDshLocalProfileSnapshotStore()
  const source = await store.readSnapshot(options.environmentId, options.profileId)
  if (source === null) throw new Error('WEB_DSH_PROFILE_NOT_FOUND')
  const snapshot = strictSnapshot(source, options.environmentId, options.profileId)
  const crypto = options.crypto ?? globalThis.crypto
  if (!await storedVfsProfileAcceptsKey(snapshot.vfsProfile, options.encryptionKey, crypto)) {
    throw new Error('WEB_DSH_PROFILE_LOCKED')
  }
  const payload: RecoveryPackPayload = {
    version: PAYLOAD_VERSION,
    record: snapshot.record,
    vfsProfile: serializableProfile(snapshot.vfsProfile),
    entries: snapshot.entries.map(serializableEntry),
  }
  const plaintext = encoder.encode(JSON.stringify(payload))
  if (plaintext.byteLength > MAX_PACK_CHARACTERS) {
    plaintext.fill(0)
    throw new Error('WEB_DSH_RECOVERY_PACK_TOO_LARGE')
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const createdAt = (options.now ?? Date.now)()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  const header = {
    version: PACK_VERSION,
    environmentId: options.environmentId,
    profileId: options.profileId,
    createdAt,
    recoveryEnvelope: snapshot.record.recoveryEnvelope,
    iv: base64Url(iv),
  }
  let ciphertext: ArrayBuffer
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: packHeader(header) },
      options.encryptionKey,
      plaintext,
    )
  } finally {
    plaintext.fill(0)
  }
  const serialized = JSON.stringify({ ...header, ciphertext: base64Url(new Uint8Array(ciphertext)) })
  if (serialized.length > MAX_PACK_CHARACTERS) throw new Error('WEB_DSH_RECOVERY_PACK_TOO_LARGE')
  return serialized
}

/**
 * Recover, authenticate and atomically import one user-selected profile pack.
 * @param options - Independently selected environment, recovery phrase, pack and storage seams.
 * @returns Imported registry record and non-extractable key for immediate Worker startup.
 */
export async function importWebDshRecoveryPack(
  options: ImportWebDshRecoveryPackOptions,
): Promise<ImportedWebDshLocalProfile> {
  const pack = parseWebDshRecoveryPack(options.pack)
  if (pack === null || pack.environmentId !== options.expectedEnvironmentId) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  const crypto = options.crypto ?? globalThis.crypto
  const encryptionKey = await unlockWebDshRecoveryProfile(
    options.expectedEnvironmentId,
    pack.profileId,
    pack.recoveryEnvelope,
    options.recoveryPassphrase,
    { crypto },
  )
  const header = {
    version: pack.version,
    environmentId: pack.environmentId,
    profileId: pack.profileId,
    createdAt: pack.createdAt,
    recoveryEnvelope: pack.recoveryEnvelope,
    iv: pack.iv,
  }
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64Url(pack.iv, 12, 12),
        additionalData: packHeader(header),
      },
      encryptionKey,
      decodeBase64Url(pack.ciphertext, 16, MAX_PACK_CHARACTERS),
    )
  } catch (cause) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID', { cause })
  }
  let snapshot: WebDshLocalProfileSnapshot | null = null
  try {
    snapshot = parsePayload(JSON.parse(decoder.decode(plaintext)), pack)
  } catch {
    snapshot = null
  } finally {
    new Uint8Array(plaintext).fill(0)
  }
  if (snapshot === null
    || !await storedVfsProfileAcceptsKey(snapshot.vfsProfile, encryptionKey, crypto)) {
    throw new Error('WEB_DSH_RECOVERY_PACK_INVALID')
  }
  await (options.store ?? new IndexedDbWebDshLocalProfileSnapshotStore()).importSnapshot(snapshot)
  return { record: snapshot.record, encryptionKey }
}

function transactionFailure(cause?: unknown): Error {
  return new Error('WEB_DSH_RECOVERY_STORE_UNAVAILABLE', cause === undefined ? undefined : { cause })
}

/** IndexedDB snapshot store using one transaction across registry, key-check and entry stores. */
export class IndexedDbWebDshLocalProfileSnapshotStore implements WebDshLocalProfileSnapshotStore {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async readSnapshot(
    environmentId: string,
    profileId: string,
  ): Promise<WebDshLocalProfileSnapshot | null> {
    const expectedNamespace = namespace(environmentId, profileId)
    const database = await openWebDshDatabase(this.factory).catch((cause: unknown) => {
      throw transactionFailure(cause)
    })
    const transaction = database.transaction([
      WEB_DSH_LOCAL_PROFILE_STORE,
      WEB_DSH_VFS_PROFILE_STORE,
      WEB_DSH_ENTRY_STORE,
    ], 'readonly')
    const recordRequest = transaction.objectStore(WEB_DSH_LOCAL_PROFILE_STORE)
      .get([environmentId, profileId])
    const profileRequest = transaction.objectStore(WEB_DSH_VFS_PROFILE_STORE).get(expectedNamespace)
    const entriesRequest = transaction.objectStore(WEB_DSH_ENTRY_STORE)
      .index(WEB_DSH_ENTRY_NAMESPACE_INDEX).getAll(expectedNamespace)
    return await new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        database.close()
        const record = recordRequest.result as unknown
        const profile = profileRequest.result as unknown
        const entries = entriesRequest.result as unknown[]
        if (record === undefined && profile === undefined && entries.length === 0) { resolve(null); return }
        if (record === undefined || profile === undefined) { reject(new Error('WEB_DSH_PROFILE_CORRUPT')); return }
        try {
          resolve(strictSnapshot({
            record: record as WebDshLocalProfileRecord,
            vfsProfile: profile as StoredVfsProfile,
            entries: entries as StoredVfsEntry[],
          }, environmentId, profileId))
        } catch (cause) {
          reject(cause instanceof Error ? cause : transactionFailure(cause))
        }
      }
      transaction.onerror = () => { database.close(); reject(transactionFailure(transaction.error)) }
      transaction.onabort = transaction.onerror
    })
  }

  async importSnapshot(snapshot: unknown): Promise<void> {
    const record = parseWebDshLocalProfileRecord(
      typeof snapshot === 'object' && snapshot !== null
        ? (snapshot as { readonly record?: unknown }).record
        : undefined,
    )
    if (record === null) throw new Error('WEB_DSH_PROFILE_CORRUPT')
    const parsed = strictSnapshot(
      snapshot, record.environmentId, record.profileId,
    )
    const expectedNamespace = parsed.vfsProfile.namespace
    const database = await openWebDshDatabase(this.factory).catch((cause: unknown) => {
      throw transactionFailure(cause)
    })
    const transaction = database.transaction([
      WEB_DSH_LOCAL_PROFILE_STORE,
      WEB_DSH_VFS_PROFILE_STORE,
      WEB_DSH_ENTRY_STORE,
    ], 'readwrite')
    const recordStore = transaction.objectStore(WEB_DSH_LOCAL_PROFILE_STORE)
    const profileStore = transaction.objectStore(WEB_DSH_VFS_PROFILE_STORE)
    const entryStore = transaction.objectStore(WEB_DSH_ENTRY_STORE)
    const recordRequest = recordStore.get([parsed.record.environmentId, parsed.record.profileId])
    const profileRequest = profileStore.get(expectedNamespace)
    const entryCountRequest = entryStore.index(WEB_DSH_ENTRY_NAMESPACE_INDEX).count(expectedNamespace)
    await new Promise<void>((resolve, reject) => {
      let reads = 0
      let domainFailure: Error | null = null
      const write = () => {
        reads += 1
        if (reads !== 3) return
        if (recordRequest.result !== undefined || profileRequest.result !== undefined
          || entryCountRequest.result !== 0) {
          domainFailure = new Error('WEB_DSH_PROFILE_ALREADY_EXISTS')
          transaction.abort()
          return
        }
        recordStore.add(parsed.record)
        profileStore.add(parsed.vfsProfile)
        for (const entry of parsed.entries) entryStore.add(entry)
      }
      recordRequest.onsuccess = write
      profileRequest.onsuccess = write
      entryCountRequest.onsuccess = write
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => {
        database.close()
        reject(domainFailure ?? transactionFailure(transaction.error))
      }
      transaction.onabort = transaction.onerror
    })
  }
}
