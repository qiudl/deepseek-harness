import { expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...(await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()),
  PROFILE_TEMPLATES: {},
}))

import { compareProfileImportInventory } from '../src/profile-import-preview.ts'

it('keeps inventory comparison available when no web template is installed', () => {
  const source = { generation: 1, snapshotDigest: 'a'.repeat(64), sessions: [], plugins: [] }
  const target = { ...source, snapshotDigest: 'b'.repeat(64) }
  const preview = compareProfileImportInventory(source, target)
  expect(preview.sessions).toEqual([])
  expect(preview.plugins).toEqual([])
})
