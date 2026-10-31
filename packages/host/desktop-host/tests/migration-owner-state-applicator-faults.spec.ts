import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'

const faults = vi.hoisted(() => ({ publicationFailure: null as null | 'EEXIST' | 'without-code' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      if (faults.publicationFailure && newPath.endsWith('/migration-owner-state/5')) {
        const error = new Error('generation publication failed')
        if (faults.publicationFailure === 'EEXIST') Object.assign(error, { code: 'EEXIST' })
        throw error
      }
      return actual.rename(oldPath, newPath)
    },
  }
})

const { MigrationOwnerStateApplicator } = await import('../src/migration-owner-state-applicator.ts')

const roots: string[] = []
const uid = process.getuid?.() ?? 0
const state: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

afterEach(async () => {
  faults.publicationFailure = null
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['EEXIST', 'without-code'] as const)(
  'rejects a %s publication failure without accepting a missing generation', async (failure) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-lost-race-'))
    roots.push(root)
    faults.publicationFailure = failure
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state)).rejects.toThrow('generation publication failed')
  },
)
