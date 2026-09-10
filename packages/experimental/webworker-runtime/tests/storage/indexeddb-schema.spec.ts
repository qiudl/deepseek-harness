import { describe, expect, it } from 'vitest'
import {
  upgradeWebDshDatabase,
  WEB_DSH_DATABASE_NAME,
  WEB_DSH_DATABASE_VERSION,
  WEB_DSH_ENTRY_NAMESPACE_INDEX,
  WEB_DSH_ENTRY_STORE,
  WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX,
  WEB_DSH_LOCAL_PROFILE_STORE,
  WEB_DSH_VFS_PROFILE_STORE,
} from '../../src/storage/indexeddb-schema.ts'

describe('Web-local IndexedDB schema', () => {
  it('owns VFS and local-profile registry stores in one versioned database', () => {
    const stores = new Set<string>()
    const indexes: Array<{ store: string; name: string; keyPath: string }> = []
    const database = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => {
        stores.add(name)
        return {
          createIndex: (indexName: string, keyPath: string) => {
            indexes.push({ store: name, name: indexName, keyPath })
          },
        }
      },
    }

    upgradeWebDshDatabase(database as unknown as IDBDatabase)

    expect(WEB_DSH_DATABASE_NAME).toBe('dsh-web-local-vfs')
    expect(WEB_DSH_DATABASE_VERSION).toBe(2)
    expect([...stores]).toEqual([
      WEB_DSH_VFS_PROFILE_STORE,
      WEB_DSH_ENTRY_STORE,
      WEB_DSH_LOCAL_PROFILE_STORE,
    ])
    expect(indexes).toEqual([
      {
        store: WEB_DSH_ENTRY_STORE,
        name: WEB_DSH_ENTRY_NAMESPACE_INDEX,
        keyPath: 'namespace',
      },
      {
        store: WEB_DSH_LOCAL_PROFILE_STORE,
        name: WEB_DSH_LOCAL_PROFILE_ENVIRONMENT_INDEX,
        keyPath: 'environmentId',
      },
    ])
  })

  it('does not recreate stores during a later opener', () => {
    const stores = new Set([
      WEB_DSH_VFS_PROFILE_STORE,
      WEB_DSH_ENTRY_STORE,
      WEB_DSH_LOCAL_PROFILE_STORE,
    ])
    let creations = 0
    upgradeWebDshDatabase({
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: () => { creations += 1; return {} },
    } as unknown as IDBDatabase)
    expect(creations).toBe(0)
  })
})
