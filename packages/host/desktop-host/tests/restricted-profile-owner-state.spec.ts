import { expect, it, vi } from 'vitest'
import { restrictedProfileOwnerState } from '../src/restricted-profile-owner-state.ts'

it('copies only workspace metadata into a restricted history Profile', async () => {
  const workspace = { kind: 'workspace' as const, schemaVersion: 1 as const, value: { grants: ['/fixture'] } }
  const readWorkspace = vi.fn(async () => workspace)
  await expect(restrictedProfileOwnerState({ readWorkspace })).resolves.toEqual({ version: 1, documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    workspace,
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ] })
  expect(readWorkspace).toHaveBeenCalledOnce()
})
