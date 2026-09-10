/** Shared IndexedDB schema for encrypted Web-local profiles and their selection metadata. */

export const WEB_DSH_DATABASE_NAME = 'dsh-web-local-vfs'
/** Current shared Web-local database schema version. */
export const WEB_DSH_DATABASE_VERSION = 2
/** Store containing one encrypted VFS key-check per profile namespace. */
export const WEB_DSH_VFS_PROFILE_STORE = 'profiles'
/** Store containing encrypted mutable VFS entries. */
export const WEB_DSH_ENTRY_STORE = 'entries'
/** Entry-store index selecting records by exact environment/profile namespace. */
export const WEB_DSH_ENTRY_NAMESPACE_INDEX = 'namespace'
/** Store containing local profile selection and wrapped-key metadata. */
export const WEB_DSH_LOCAL_PROFILE_STORE = 'localProfiles'
/** Registry-store index selecting profiles by exact environment. */
export const WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX = 'environmentId'

/**
 * Create every store used by a Web-local profile under one upgrade transaction.
 * @param database - Database opened by the page or its same-origin Host Worker.
 */
export function upgradeWebDshDatabase(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(WEB_DSH_VFS_PROFILE_STORE)) {
    database.createObjectStore(WEB_DSH_VFS_PROFILE_STORE, { keyPath: 'namespace' })
  }
  if (!database.objectStoreNames.contains(WEB_DSH_ENTRY_STORE)) {
    database.createObjectStore(WEB_DSH_ENTRY_STORE, { keyPath: 'id' })
      .createIndex(WEB_DSH_ENTRY_NAMESPACE_INDEX, 'namespace', { unique: false })
  }
  if (!database.objectStoreNames.contains(WEB_DSH_LOCAL_PROFILE_STORE)) {
    database.createObjectStore(
      WEB_DSH_LOCAL_PROFILE_STORE,
      { keyPath: ['environmentId', 'profileId'] },
    ).createIndex(
      WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX,
      'environmentId',
      { unique: false },
    )
  }
}

/**
 * Open the shared Web-local profile database and release stale connections on upgrades.
 * @param factory - Browser IndexedDB factory, replaceable by integration tests.
 * @returns The current schema connection.
 */
export function openWebDshDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = factory.open(WEB_DSH_DATABASE_NAME, WEB_DSH_DATABASE_VERSION)
    request.onupgradeneeded = () => { upgradeWebDshDatabase(request.result) }
    request.onsuccess = () => {
      if (settled) { request.result.close(); return }
      settled = true
      request.result.onversionchange = () => { request.result.close() }
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
