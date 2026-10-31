import { describe, expect, it, vi } from 'vitest'
import { FileOwnerJsonlMigrationGenerationTarget,
  type ExistingPersistenceInspection } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { compareProfileImportInventory, type ProfileImportInventory } from '../src/profile-import-preview.ts'
import { stageSelectedProfileImportSessions } from '../src/profile-import-stage.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'

const stagePolicy = vi.hoisted(() => ({
  source: null as ProfileImportInventory | null,
  target: null as ProfileImportInventory | null,
  readerMode: 'normal' as 'normal' | 'source-owner' | 'target-owner' | 'staged-owner',
  readerCount: 0,
}))

vi.mock('../src/profile-import-preview.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profile-import-preview.ts')>()
  return { ...actual, inspectProfileImportInventory: async (
    input: Parameters<typeof actual.inspectProfileImportInventory>[0],
  ) => {
    const inventory = input.profileRoot.endsWith('/source') ? stagePolicy.source : stagePolicy.target
    if (!inventory) throw Error('missing synthetic inventory')
    return inventory
  } }
})

vi.mock('@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts')>()
  return { ...actual, FileJsonlMigrationExportSource: class {
    constructor(_root: string, _uid: number, ownerState: { read(): unknown }) {
      stagePolicy.readerCount += 1
      if ((stagePolicy.readerMode === 'source-owner' && stagePolicy.readerCount === 1)
        || (stagePolicy.readerMode === 'target-owner' && stagePolicy.readerCount === 2)
        || (stagePolicy.readerMode === 'staged-owner' && stagePolicy.readerCount === 3)) ownerState.read()
    }
    async readImportSessions() { return [] }
    async listImportInventory() { return [] }
  } }
})

const uid = process.getuid?.() ?? 0
const sourceProfileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e4120'
const targetProfileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e4121'
const operationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e4122'
const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
  { kind: 'settings', schemaVersion: 1, value: {} },
  { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
  { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
  { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
] }

type SessionRow = ProfileImportInventory['sessions'][number]
function row(id: string, digest: string, parentSession?: string): SessionRow {
  return { id, createdAt: 1, eventCount: 0, semanticDigest: digest, revision: 'v1',
    ...(parentSession ? { parentSession } : {}) }
}

function fixture(sourceSessions: SessionRow[], targetSessions: SessionRow[] = [], targetGeneration = 1) {
  stagePolicy.source = { generation: 1, snapshotDigest: 'a'.repeat(64), sessions: sourceSessions, plugins: [] }
  stagePolicy.target = { generation: targetGeneration, snapshotDigest: 'b'.repeat(64),
    sessions: targetSessions, plugins: [] }
  stagePolicy.readerMode = 'normal'
  stagePolicy.readerCount = 0
  const source = { profileRoot: '/tmp/dsh-stage-policy/source',
    target: new FileOwnerJsonlMigrationGenerationTarget('/tmp/dsh-stage-policy/source/persistence', uid, 1) }
  const target = { profileRoot: '/tmp/dsh-stage-policy/target',
    target: new FileOwnerJsonlMigrationGenerationTarget('/tmp/dsh-stage-policy/target/persistence', uid, 1) }
  const markers = new Map<string, Buffer>()
  const fence = new ProfileImportWorkerFence({
    read: id => markers.get(id), replace: (id, bytes) => { markers.set(id, bytes) },
  })
  fence.reservePair(sourceProfileId, targetProfileId, operationId)
  return { source, target, sourceProfileId, targetProfileId, operationId, fence, uid,
    expectedPreviewDigest: compareProfileImportInventory(stagePolicy.source, stagePolicy.target).previewDigest,
    selectedSessionIds: ['child'], assertQuiescent: async () => {} }
}

function active(root: string, generation: number): ExistingPersistenceInspection {
  return { root, compression: 'none', generation, sessionCount: 0, inventoryDigest: 'c'.repeat(64) }
}

function stubPersistence(input: ReturnType<typeof fixture>, targetGeneration = 1) {
  vi.spyOn(input.source.target, 'inspectExistingPersistence')
    .mockResolvedValue(active('/tmp/dsh-stage-policy/source/active', 1))
  vi.spyOn(input.target.target, 'inspectExistingPersistence')
    .mockResolvedValue(active('/tmp/dsh-stage-policy/target/active', targetGeneration))
  vi.spyOn(input.target.target, 'activeOwnerState').mockResolvedValue(ownerState)
  vi.spyOn(input.target.target, 'prepareEmptyGeneration').mockResolvedValue(undefined)
  vi.spyOn(input.target.target, 'importOwnerState').mockResolvedValue(undefined)
  const abort = vi.spyOn(input.target.target, 'abortGeneration').mockResolvedValue(undefined)
  vi.spyOn(input.target.target, 'generationRoot').mockReturnValue('/tmp/dsh-stage-policy/target/staged')
  return { abort }
}

describe('Profile import session stage policy', () => {
  it('requires a missing parent to be selected with its new child', async () => {
    const input = fixture([row('parent', 'c'.repeat(64)), row('child', 'd'.repeat(64), 'parent')])
    await expect(stageSelectedProfileImportSessions(input)).rejects.toThrow('profile_import_selection_invalid')
  })

  it('rejects a parent whose target copy differs from the source', async () => {
    const input = fixture([row('parent', 'c'.repeat(64)), row('child', 'd'.repeat(64), 'parent')],
      [row('parent', 'e'.repeat(64))])
    await expect(stageSelectedProfileImportSessions(input)).rejects.toThrow('profile_import_selection_invalid')
  })

  it.each([
    ['matching-target', [row('parent', 'c'.repeat(64)), row('child', 'd'.repeat(64), 'parent')],
      [row('parent', 'c'.repeat(64))], ['child']],
    ['target-only-parent', [row('child', 'd'.repeat(64), 'parent')],
      [row('parent', 'c'.repeat(64))], ['child']],
    ['selected-parent', [row('parent', 'c'.repeat(64)), row('child', 'd'.repeat(64), 'parent')],
      [], ['parent', 'child']],
  ] as const)('passes %s parent selection into persistence validation', async (_name, source, target, selected) => {
    const input = fixture([...source], [...target])
    const inspect = vi.spyOn(input.source.target, 'inspectExistingPersistence')
      .mockRejectedValue(Error('past parent policy'))
    await expect(stageSelectedProfileImportSessions({ ...input, selectedSessionIds: selected }))
      .rejects.toThrow('past parent policy')
    expect(inspect).toHaveBeenCalled()
  })

  it.each(['source-owner', 'target-owner', 'staged-owner'] as const)
  ('fails closed when %s unexpectedly requests owner state', async (mode) => {
    const input = fixture([])
    const { abort } = stubPersistence(input)
    stagePolicy.readerMode = mode
    await expect(stageSelectedProfileImportSessions({ ...input, selectedSessionIds: [] }))
      .rejects.toThrow('profile_import_owner_state_unavailable')
    if (mode === 'staged-owner') {
      expect(abort).toHaveBeenCalledWith(2)
    }
  })

  it('rejects a target generation beyond the safe integer range', async () => {
    const input = fixture([], [], Number.MAX_SAFE_INTEGER)
    stubPersistence(input, Number.MAX_SAFE_INTEGER)
    await expect(stageSelectedProfileImportSessions({ ...input, selectedSessionIds: [] }))
      .rejects.toThrow('profile_import_inventory_invalid')
  })
})
