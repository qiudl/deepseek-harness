import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/types.ts'
import { projectOperationMemoryDatabases, projectOperationMemoryStoreLayout } from '../src/project-operation-memory-stores.ts'

describe('project operation memory store layout', () => {
  it('derives each role root, purpose and legacy roots under the platform joiner', () => {
    expect(projectOperationMemoryStoreLayout('source', '/p', (...parts) => posix.join(...parts))).toStrictEqual({
      root: '/p/project-operation-memory-sqlite-v1',
      legacyRoots: ['/p/project-operation-memory', '/p/project-operation-memory-source-exports'],
    })
    expect(projectOperationMemoryStoreLayout('recipient', '/p', (...parts) => posix.join(...parts))).toStrictEqual({
      root: '/p/project-operation-memory-recipient-sqlite-v1',
      storePurpose: 'recipient_import',
      legacyRoots: [],
    })
    expect(projectOperationMemoryStoreLayout('native', 'C:\\p', (...parts) => win32.join(...parts))).toStrictEqual({
      root: 'C:\\p\\project-operation-memory-native-source-sqlite-v1',
      storePurpose: 'native_source_export',
      legacyRoots: [],
    })
  })
  it('opens each Profile owner only from its own role files', async () => {
    const files = vi.fn(async () => {
        throw new HostAuthorityError('stale')
      }),
      services = projectOperationMemoryDatabases(files).services({ installationId: 'i', publicKey: 'k' }, [])
    await expect(services.createProjectOperationMemoryMetadata('a')).rejects.toThrow(HostAuthorityError)
    await expect(services.createProjectOperationMemoryRecipientImports('b', {} as never)).rejects.toThrow(
      HostAuthorityError,
    )
    await expect(services.createProjectOperationMemoryNativeSource?.('c')).rejects.toThrow(HostAuthorityError)
    expect(files.mock.calls).toStrictEqual([
      ['a', 'source'],
      ['b', 'recipient'],
      ['c', 'native'],
    ])
  })
})
