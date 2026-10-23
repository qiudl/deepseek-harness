/** REQ-20261022-0022: fenced, private archive staging; live plugin files are never changed here. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { type BundledPluginCatalog } from './bundled-plugins.ts'
import { FileProfileImportOperationJournal } from './profile-import-operation-journal.ts'
import { planSelectedProfileImportPlugins, type ProfileImportPluginPlan } from './profile-import-plugin-plan.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
const HEX = /^[a-f0-9]{64}$/u

function planDigest(plan: ProfileImportPluginPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

function receiptBytes(operationId: string, plan: ProfileImportPluginPlan): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, operationId,
    previewDigest: plan.previewDigest, planDigest: planDigest(plan),
    archives: plan.plugins.map(plugin => ({ name: plugin.name, digest: plugin.archiveDigest,
      file: `${plugin.archiveDigest}.tgz` })) })}\n`)
}

async function checkedDirectory(path: string, uid: number): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw Error('profile_import_plugin_stage_unsafe')
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function createPrivateFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function verifyPrivateArchive(path: string, uid: number, digest: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(uid) || before.nlink !== 1n
      || (before.mode & 0o077n) !== 0n || before.size < 1n || before.size > 33_554_432n) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
  } finally { await handle.close() }
}

/** The result is an immutable input to a future isolated install, never an install receipt. */
export async function stageSelectedProfileImportPluginArchives(input: Readonly<{
  source: Profile
  target: Profile
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  journal: FileProfileImportOperationJournal
  catalog: BundledPluginCatalog
  plan: ProfileImportPluginPlan
  composedEntryIds(): ReadonlySet<string>
  assertQuiescent(): Promise<void>
  signal?: AbortSignal
}>): Promise<{ stageRoot: string; plan: ProfileImportPluginPlan }> {
  const { source, target, uid, operationId, fence, plan, signal } = input
  signal?.throwIfAborted()
  const intent = await input.journal.load(operationId)
  if (!intent || intent.phase !== 'fenced' || intent.sourceProfileId !== source.profileId
    || intent.targetProfileId !== target.profileId
    || intent.previewDigest !== plan.previewDigest
    || intent.sourceSnapshotDigest !== plan.sourceSnapshotDigest
    || intent.targetSnapshotDigest !== plan.targetSnapshotDigest
    || JSON.stringify(intent.selectedPluginNames) !== JSON.stringify(plan.plugins.map(plugin => plugin.name))) {
    throw Error('profile_import_plugin_stage_intent_invalid')
  }
  fence.assertOwnedPair(source.profileId, target.profileId, operationId)
  const replan = () => planSelectedProfileImportPlugins({ source, target, uid, operationId, fence,
    catalog: input.catalog, expectedPreviewDigest: plan.previewDigest,
    selectedPluginNames: intent.selectedPluginNames, composedEntryIds: input.composedEntryIds,
    assertQuiescent: input.assertQuiescent, ...(signal ? { signal } : {}) })
  if (JSON.stringify(await replan()) !== JSON.stringify(plan)) throw Error('profile_import_plugin_stage_plan_changed')
  await checkedDirectory(target.profileRoot, uid)
  const stagingParent = join(target.profileRoot, 'profile-import-plugin-staging')
  try { await mkdir(stagingParent, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await checkedDirectory(stagingParent, uid)
  const stageRoot = join(stagingParent, operationId)
  // An interrupted stage stays private and fails closed; it is never overwritten on retry.
  await mkdir(stageRoot, { mode: 0o700 })
  await checkedDirectory(stageRoot, uid)
  const archives: { name: string; digest: string; file: string }[] = []
  for (const plugin of plan.plugins) {
    signal?.throwIfAborted()
    if (!HEX.test(plugin.archiveDigest)) throw Error('profile_import_plugin_stage_plan_changed')
    const entry = input.catalog.get(plugin.name, plugin.version)
    if (!entry || entry.sha256 !== plugin.archiveDigest) throw Error('profile_import_plugin_stage_plan_changed')
    const bytes = input.catalog.readArchive(entry)
    if (createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    const file = `${plugin.archiveDigest}.tgz`
    await createPrivateFile(join(stageRoot, file), bytes)
    archives.push({ name: plugin.name, digest: plugin.archiveDigest, file })
  }
  await syncDirectory(stageRoot)
  if (JSON.stringify(await replan()) !== JSON.stringify(plan)) throw Error('profile_import_plugin_stage_plan_changed')
  const currentIntent = await input.journal.load(operationId)
  if (JSON.stringify(currentIntent) !== JSON.stringify(intent)) throw Error('profile_import_plugin_stage_intent_invalid')
  for (const item of archives) {
    await verifyPrivateArchive(join(stageRoot, item.file), uid, item.digest)
  }
  const receipt = receiptBytes(operationId, plan)
  await createPrivateFile(join(stageRoot, 'receipt.json'), receipt)
  await syncDirectory(stageRoot)
  await syncDirectory(stagingParent)
  fence.assertOwnedPair(source.profileId, target.profileId, operationId)
  if (JSON.stringify(await input.journal.load(operationId)) !== JSON.stringify(intent)) {
    throw Error('profile_import_plugin_stage_intent_invalid')
  }
  return { stageRoot, plan }
}

/** Read-only crash check; missing receipt or extra files keep the import fenced. */
export async function inspectStagedProfileImportPluginArchives(input: Readonly<{
  target: Profile
  sourceProfileId: string
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  journal: FileProfileImportOperationJournal
  catalog: BundledPluginCatalog
  plan: ProfileImportPluginPlan
}>): Promise<{ stageRoot: string; plan: ProfileImportPluginPlan } | null> {
  const { target, sourceProfileId, uid, operationId, fence, plan } = input
  const intent = await input.journal.load(operationId)
  if (!intent || !['fenced', 'staged', 'committing'].includes(intent.phase)
    || intent.sourceProfileId !== sourceProfileId
    || intent.targetProfileId !== target.profileId
    || intent.previewDigest !== plan.previewDigest
    || intent.sourceSnapshotDigest !== plan.sourceSnapshotDigest
    || intent.targetSnapshotDigest !== plan.targetSnapshotDigest
    || JSON.stringify(intent.selectedPluginNames) !== JSON.stringify(plan.plugins.map(plugin => plugin.name))) {
    throw Error('profile_import_plugin_stage_intent_invalid')
  }
  fence.assertOwnedPair(sourceProfileId, target.profileId, operationId)
  const parent = join(target.profileRoot, 'profile-import-plugin-staging')
  try { await checkedDirectory(parent, uid) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const stageRoot = join(parent, operationId)
  try { await checkedDirectory(stageRoot, uid) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const expected = receiptBytes(operationId, plan)
  const receipt = readOwnerPrivateFile(join(stageRoot, 'receipt.json'), uid, 65_536,
    () => Error('profile_import_plugin_stage_incomplete'))
  if (!receipt?.equals(expected)) throw Error('profile_import_plugin_stage_incomplete')
  const expectedFiles = ['receipt.json', ...plan.plugins.map(plugin => `${plugin.archiveDigest}.tgz`)].sort()
  if (JSON.stringify((await readdir(stageRoot)).sort()) !== JSON.stringify(expectedFiles)) {
    throw Error('profile_import_plugin_stage_incomplete')
  }
  for (const plugin of plan.plugins) {
    const entry = input.catalog.get(plugin.name, plugin.version)
    if (!entry || entry.sha256 !== plugin.archiveDigest
      || createHash('sha256').update(input.catalog.readArchive(entry)).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    await verifyPrivateArchive(join(stageRoot, `${plugin.archiveDigest}.tgz`), uid, plugin.archiveDigest)
  }
  fence.assertOwnedPair(sourceProfileId, target.profileId, operationId)
  if (JSON.stringify(await input.journal.load(operationId)) !== JSON.stringify(intent)) {
    throw Error('profile_import_plugin_stage_intent_invalid')
  }
  return { stageRoot, plan }
}
