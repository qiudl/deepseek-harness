import { posix, win32 } from 'node:path'
import { expect, it } from 'vitest'
import { projectMemoryDatabaseLayout } from '../src/project-operation-memory-layout.ts'

it('keeps each database purpose and legacy path on its original platform', () => {
  for (const [root, separator, pathJoin] of [
    ['/private/profile', '/', (...parts: string[]) => posix.join(...parts)],
    ['C:\\private\\profile', '\\', (...parts: string[]) => win32.join(...parts)],
  ] as const) {
    expect(projectMemoryDatabaseLayout(root, 'source', pathJoin)).toEqual({
      root: root + separator + 'project-operation-memory-sqlite-v1',
      legacyRoots: [root + separator + 'project-operation-memory', root + separator + 'project-operation-memory-source-exports'],
    })
    expect(projectMemoryDatabaseLayout(root, 'recipient', pathJoin)).toEqual({
      root: root + separator + 'project-operation-memory-recipient-sqlite-v1',
      storePurpose: 'recipient_import', legacyRoots: [],
    })
    expect(projectMemoryDatabaseLayout(root, 'native', pathJoin)).toEqual({
      root: root + separator + 'project-operation-memory-native-source-sqlite-v1',
      storePurpose: 'native_source_export', legacyRoots: [],
    })
  }
})
