/** REQ-20261022-0022: inactive, owner-only session import staging. */
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { compareProfileImportInventory, inspectProfileImportInventory } from './profile-import-preview.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'

type Profile = Readonly<{ profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>

/**
 * Copy target sessions and selected new source sessions into an inactive generation.
 * The caller must first stop both workers and retain their durable markers through
 * a separate commit or abort. This function rechecks marker ownership and caller
 * quiescence throughout, never switches the active generation, and is intentionally
 * not exposed by the Host protocol.
 */
export async function stageSelectedProfileImportSessions(input: Readonly<{
  source: Profile
  target: Profile
  sourceProfileId: string
  targetProfileId: string
  operationId: string
  fence: ProfileImportWorkerFence
  uid: number
  expectedPreviewDigest: string
  selectedSessionIds: readonly string[]
  assertQuiescent: () => Promise<void>
  signal?: AbortSignal
}>): Promise<Readonly<{ generation: number
  sourceSnapshotDigest: string
  targetSnapshotDigest: string
  stagedSessionCount: number }>> {
  const { source, target, sourceProfileId, targetProfileId, operationId, fence,
    uid, expectedPreviewDigest, selectedSessionIds, assertQuiescent, signal } = input
  if (selectedSessionIds.length > 10_000 || new Set(selectedSessionIds).size !== selectedSessionIds.length
    || selectedSessionIds.some(id => typeof id !== 'string' || id.length < 1)) {
    throw new Error('profile_import_selection_invalid')
  }
  signal?.throwIfAborted()
  const checkFence = async () => {
    fence.assertOwnedPair(sourceProfileId, targetProfileId, operationId)
    await assertQuiescent()
    fence.assertOwnedPair(sourceProfileId, targetProfileId, operationId)
  }
  await checkFence()
  const [sourceInventory, targetInventory] = await Promise.all([
    inspectProfileImportInventory({ ...source, uid, ...(signal ? { signal } : {}) }),
    inspectProfileImportInventory({ ...target, uid, ...(signal ? { signal } : {}) }),
  ])
  const preview = compareProfileImportInventory(sourceInventory, targetInventory)
  if (preview.previewDigest !== expectedPreviewDigest) throw new Error('profile_import_inventory_changed')
  const sourceById = new Map(preview.sessions.map(row => [row.source.id, row]))
  const targetById = new Map(targetInventory.sessions.map(row => [row.id, row]))
  const selected = new Set(selectedSessionIds)
  for (const id of selected) {
    const row = sourceById.get(id)
    if (!row || row.state !== 'new') throw new Error('profile_import_selection_invalid')
    const parent = row.source.parentSession
    if (parent && !selected.has(parent)) {
      const existingParent = targetById.get(parent)
      const sourceParent = sourceById.get(parent)?.source
      if (!existingParent || (sourceParent && sourceParent.semanticDigest !== existingParent.semanticDigest)) {
        throw new Error('profile_import_selection_invalid')
      }
    }
  }
  const [sourceActive, targetActive] = await Promise.all([
    source.target.inspectExistingPersistence(), target.target.inspectExistingPersistence(),
  ])
  if (sourceActive.generation !== sourceInventory.generation || targetActive.generation !== targetInventory.generation) {
    throw new Error('profile_import_inventory_changed')
  }
  const sourceReader = new FileJsonlMigrationExportSource(sourceActive.root, uid, {
    read: () => { throw new Error('profile_import_owner_state_unavailable') },
  })
  const targetReader = new FileJsonlMigrationExportSource(targetActive.root, uid, {
    read: () => { throw new Error('profile_import_owner_state_unavailable') },
  })
  const [sourceSessions, targetSessions, ownerState] = await Promise.all([
    sourceReader.readImportSessions(selectedSessionIds, signal),
    targetReader.readImportSessions(targetInventory.sessions.map(row => row.id), signal),
    target.target.activeOwnerState(),
  ])
  await checkFence()
  const [sourceAgain, targetAgain] = await Promise.all([
    inspectProfileImportInventory({ ...source, uid, ...(signal ? { signal } : {}) }),
    inspectProfileImportInventory({ ...target, uid, ...(signal ? { signal } : {}) }),
  ])
  if (sourceAgain.snapshotDigest !== sourceInventory.snapshotDigest
    || targetAgain.snapshotDigest !== targetInventory.snapshotDigest) {
    throw new Error('profile_import_inventory_changed')
  }
  const generation = targetInventory.generation + 1
  if (!Number.isSafeInteger(generation)) throw new Error('profile_import_inventory_invalid')
  await target.target.prepareEmptyGeneration(generation)
  try {
    await target.target.importOwnerState(generation, ownerState)
    for (const session of [...targetSessions, ...sourceSessions]) {
      signal?.throwIfAborted()
      await checkFence()
      await target.target.importSession(generation, session.meta, session.events)
    }
    const stagedReader = new FileJsonlMigrationExportSource(target.target.generationRoot(generation), uid, {
      read: () => { throw new Error('profile_import_owner_state_unavailable') },
    })
    const staged = await stagedReader.listImportInventory(signal)
    const expected = new Map([...targetInventory.sessions, ...sourceInventory.sessions.filter(row => selected.has(row.id))]
      .map(row => [row.id, row.semanticDigest]))
    if (staged.length !== expected.size || staged.some(row => expected.get(row.id) !== row.semanticDigest)) {
      throw new Error('profile_import_stage_mismatch')
    }
    await checkFence()
    const [sourceFinal, targetFinal] = await Promise.all([
      inspectProfileImportInventory({ ...source, uid, ...(signal ? { signal } : {}) }),
      inspectProfileImportInventory({ ...target, uid, ...(signal ? { signal } : {}) }),
    ])
    if (sourceFinal.snapshotDigest !== sourceInventory.snapshotDigest
      || targetFinal.snapshotDigest !== targetInventory.snapshotDigest) {
      throw new Error('profile_import_inventory_changed')
    }
    return { generation, sourceSnapshotDigest: sourceInventory.snapshotDigest,
      targetSnapshotDigest: targetInventory.snapshotDigest, stagedSessionCount: staged.length }
  } catch (error) {
    await target.target.abortGeneration(generation)
    throw error
  }
}
