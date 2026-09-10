/** Origin-owned registry for encrypted browser-local DSH profiles. */

import {
  parseWebDshPasskeyEnvelope,
  parseWebDshRecoveryEnvelope,
  type WebDshLocalProfileEnrollment,
  type WebDshPasskeyEnvelope,
  type WebDshRecoveryEnvelope,
} from './passkey-profile.ts'
import {
  openWebDshDatabase,
  WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX,
  WEB_DSH_LOCAL_PROFILE_STORE,
} from '../storage/indexeddb-schema.ts'

const RECORD_VERSION = 1 as const
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Durable profile selection metadata; it contains wrappers but never an unwrapped key. */
export interface WebDshLocalProfileRecord {
  readonly version: typeof RECORD_VERSION
  readonly environmentId: string
  readonly profileId: string
  readonly displayName: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly passkeyEnvelope: WebDshPasskeyEnvelope
  readonly recoveryEnvelope: WebDshRecoveryEnvelope
}

/** Minimal origin registry used by first-run and environment-selection UI. */
export interface WebDshLocalProfileRegistry {
  /**
   * List profiles owned by exactly one environment.
   * @param environmentId - Environment namespace to list.
   * @returns Valid records, newest update first.
   */
  list(environmentId: string): Promise<readonly WebDshLocalProfileRecord[]>
  /**
   * Read one exact environment/profile pair.
   * @param environmentId - Expected environment owner.
   * @param profileId - Expected profile identity.
   * @returns The valid record, or `null` when it does not exist.
   */
  get(environmentId: string, profileId: string): Promise<WebDshLocalProfileRecord | null>
}

function profileKey(environmentId: string, profileId: string): string {
  return `${environmentId}:${profileId}`
}

function validDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
    && value.length <= 256
    && Array.from(value).length >= 1 && Array.from(value).length <= 128
    && new TextEncoder().encode(value).byteLength <= 512
}

/**
 * Build registry metadata from one completed dual-wrapper enrollment.
 * @param displayName - User-facing local profile name without surrounding whitespace.
 * @param enrollment - Passkey/recovery envelopes and the transient Worker key.
 * @returns A serializable record that excludes the unwrapped key.
 * @throws `WEB_DSH_PROFILE_RECORD_INVALID` when the name or wrapper ownership is invalid.
 */
export function createWebDshLocalProfileRecord(
  displayName: string,
  enrollment: WebDshLocalProfileEnrollment,
): WebDshLocalProfileRecord {
  const passkeyEnvelope = parseWebDshPasskeyEnvelope(enrollment.passkeyEnvelope)
  const recoveryEnvelope = parseWebDshRecoveryEnvelope(enrollment.recoveryEnvelope)
  if (!validDisplayName(displayName) || passkeyEnvelope === null || recoveryEnvelope === null
    || passkeyEnvelope.environmentId !== recoveryEnvelope.environmentId
    || passkeyEnvelope.profileId !== recoveryEnvelope.profileId) {
    throw new Error('WEB_DSH_PROFILE_RECORD_INVALID')
  }
  return {
    version: RECORD_VERSION,
    environmentId: passkeyEnvelope.environmentId,
    profileId: passkeyEnvelope.profileId,
    displayName,
    createdAt: Math.min(passkeyEnvelope.createdAt, recoveryEnvelope.createdAt),
    updatedAt: Math.max(passkeyEnvelope.createdAt, recoveryEnvelope.createdAt),
    passkeyEnvelope,
    recoveryEnvelope,
  }
}

/**
 * Parse untrusted registry metadata and cross-check both key wrappers.
 * @param value - IndexedDB or imported value to validate.
 * @returns The exact record, or `null` for unsupported, mismatched, or malformed data.
 */
export function parseWebDshLocalProfileRecord(value: unknown): WebDshLocalProfileRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).toSorted().join(',')
    !== 'createdAt,displayName,environmentId,passkeyEnvelope,profileId,recoveryEnvelope,updatedAt,version'
    || item.version !== RECORD_VERSION || typeof item.environmentId !== 'string'
    || typeof item.profileId !== 'string' || !IDENTIFIER.test(item.environmentId)
    || !validDisplayName(item.displayName) || !Number.isSafeInteger(item.createdAt)
    || !Number.isSafeInteger(item.updatedAt) || (item.createdAt as number) < 0
    || (item.updatedAt as number) < (item.createdAt as number)) return null
  const passkeyEnvelope = parseWebDshPasskeyEnvelope(item.passkeyEnvelope)
  const recoveryEnvelope = parseWebDshRecoveryEnvelope(item.recoveryEnvelope)
  if (passkeyEnvelope === null || recoveryEnvelope === null
    || passkeyEnvelope.environmentId !== item.environmentId
    || recoveryEnvelope.environmentId !== item.environmentId
    || passkeyEnvelope.profileId !== item.profileId || recoveryEnvelope.profileId !== item.profileId
    || (item.createdAt as number) > Math.min(passkeyEnvelope.createdAt, recoveryEnvelope.createdAt)
    || (item.updatedAt as number) < Math.max(passkeyEnvelope.createdAt, recoveryEnvelope.createdAt)) return null
  return item as unknown as WebDshLocalProfileRecord
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
      else reject(new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE'))
    }
    transaction.onerror = () => {
      database.close()
      reject(new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE', {
        ...(transaction.error === null ? {} : { cause: transaction.error }),
      }))
    }
    transaction.onabort = transaction.onerror
  })
}

/** IndexedDB implementation owned by the DSH page origin. */
export class IndexedDbWebDshLocalProfileRegistry implements WebDshLocalProfileRegistry {
  constructor(private readonly factory: IDBFactory = indexedDB) {}

  async list(environmentId: string): Promise<readonly WebDshLocalProfileRecord[]> {
    if (!IDENTIFIER.test(environmentId)) throw new Error('WEB_DSH_PROFILE_RECORD_INVALID')
    const database = await openWebDshDatabase(this.factory)
      .catch((cause: unknown) => { throw new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE', { cause }) })
    const transaction = database.transaction(WEB_DSH_LOCAL_PROFILE_STORE, 'readonly')
    return await settleTransaction(database, transaction, (finish, reject) => {
      const request = transaction.objectStore(WEB_DSH_LOCAL_PROFILE_STORE)
        .index(WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX).getAll(environmentId)
      request.onsuccess = () => {
        const records = (request.result as unknown[]).map(parseWebDshLocalProfileRecord)
        if (records.some(record => record === null)) {
          reject(new Error('WEB_DSH_PROFILE_REGISTRY_CORRUPT'))
          return
        }
        finish((records as WebDshLocalProfileRecord[])
          .toSorted((left, right) => right.updatedAt - left.updatedAt || left.profileId.localeCompare(right.profileId)))
      }
      request.onerror = () => {
        reject(new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE', {
          ...(request.error === null ? {} : { cause: request.error }),
        }))
      }
    })
  }

  async get(environmentId: string, profileId: string): Promise<WebDshLocalProfileRecord | null> {
    const key = profileKey(environmentId, profileId)
    if (!IDENTIFIER.test(environmentId) || !PROFILE_ID.test(profileId) || key.length > 128) {
      throw new Error('WEB_DSH_PROFILE_RECORD_INVALID')
    }
    const database = await openWebDshDatabase(this.factory)
      .catch((cause: unknown) => { throw new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE', { cause }) })
    const transaction = database.transaction(WEB_DSH_LOCAL_PROFILE_STORE, 'readonly')
    return await settleTransaction(database, transaction, (finish, reject) => {
      const request = transaction.objectStore(WEB_DSH_LOCAL_PROFILE_STORE).get([environmentId, profileId])
      request.onsuccess = () => {
        if (request.result === undefined) { finish(null); return }
        const record = parseWebDshLocalProfileRecord(request.result)
        if (record === null || profileKey(record.environmentId, record.profileId) !== key) {
          reject(new Error('WEB_DSH_PROFILE_REGISTRY_CORRUPT'))
          return
        }
        finish(record)
      }
      request.onerror = () => {
        reject(new Error('WEB_DSH_PROFILE_REGISTRY_UNAVAILABLE', {
          ...(request.error === null ? {} : { cause: request.error }),
        }))
      }
    })
  }
}
