/** REQ-20261022-0022: private, read-only selection preflight for trusted plugin archives. */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { type BundledPluginCatalog } from './bundled-plugins.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { inspectProfileImportPluginArchives } from './profile-import-plugin-trust.ts'
import { compareProfileImportInventory, inspectProfileImportInventory } from './profile-import-preview.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

function manifest(profileRoot: string, uid: number): { text: string
  dependencies: Record<string, string>
  occupied: ReadonlySet<string> } {
  const text = readExtensionStateFile(join(profileRoot, 'profiles', 'web', 'package.json'), uid,
    1_048_576, 'profile_import_manifest_unsafe')
  if (text === null) throw Error('profile_import_manifest_invalid')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw Error('profile_import_manifest_invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('profile_import_manifest_invalid')
  const row = parsed as Record<string, unknown>
  const occupied = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = row[field]
    if (dependencies === undefined) continue
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw Error('profile_import_manifest_invalid')
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string') throw Error('profile_import_manifest_invalid')
      occupied.add(name)
    }
  }
  const dependencies = row.dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw Error('profile_import_manifest_invalid')
  }
  return { text, dependencies: dependencies as Record<string, string>, occupied }
}

function pluginStateDigest(profileRoot: string, uid: number): string {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
    'cordis.patch.yml', 'compatibility.json']
  const values = files.flatMap(file => [
    readExtensionStateFile(join(profileRoot, file), uid, 16_777_216, 'profile_import_plugin_target_unsafe'),
    readExtensionStateFile(join(profileRoot, 'profiles', 'web', file), uid, 16_777_216,
      'profile_import_plugin_target_unsafe'),
  ])
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

async function targetInstallationExists(profileRoot: string, name: string): Promise<boolean> {
  const path = join(profileRoot, 'profiles', 'web', 'node_modules', name)
  try { await lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export type ProfileImportPluginPlan = Readonly<{
  previewDigest: string
  sourceSnapshotDigest: string
  targetSnapshotDigest: string
  targetPluginStateDigest: string
  composedEntryDigest: string
  plugins: readonly Readonly<{ name: string
    version: string
    archiveDigest: string
    entryIds: readonly string[] }>[]
}>

/** Build no install or write action; every selected plugin must have a trusted package and a free target identity. */
export async function planSelectedProfileImportPlugins(input: Readonly<{
  source: Profile
  target: Profile
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  catalog: BundledPluginCatalog
  expectedPreviewDigest: string
  selectedPluginNames: readonly string[]
  composedEntryIds(): ReadonlySet<string>
  assertQuiescent(): Promise<void>
  signal?: AbortSignal
}>): Promise<ProfileImportPluginPlan> {
  const { source, target, uid, operationId, fence, signal, selectedPluginNames } = input
  if (selectedPluginNames.length < 1 || selectedPluginNames.length > 128
    || new Set(selectedPluginNames).size !== selectedPluginNames.length) {
    throw Error('profile_import_plugin_selection_invalid')
  }
  const check = async () => {
    signal?.throwIfAborted()
    fence.assertOwnedPair(source.profileId, target.profileId, operationId)
    await input.assertQuiescent()
    fence.assertOwnedPair(source.profileId, target.profileId, operationId)
  }
  await check()
  const inventoryInput = (profile: Profile) => ({ profileRoot: profile.profileRoot, target: profile.target, uid,
    ...(signal ? { signal } : {}) })
  const [sourceInventory, targetInventory] = await Promise.all([
    inspectProfileImportInventory(inventoryInput(source)), inspectProfileImportInventory(inventoryInput(target)),
  ])
  const preview = compareProfileImportInventory(sourceInventory, targetInventory)
  if (preview.previewDigest !== input.expectedPreviewDigest) throw Error('profile_import_inventory_changed')
  const candidates = new Map(preview.plugins.map(row => [row.source.name, row.state]))
  if (selectedPluginNames.some(name => candidates.get(name) !== 'new')) {
    throw Error('profile_import_plugin_selection_invalid')
  }
  const sourceManifest = manifest(source.profileRoot, uid)
  const targetManifest = manifest(target.profileRoot, uid)
  const targetPluginStateDigest = pluginStateDigest(target.profileRoot, uid)
  if (selectedPluginNames.some(name => targetManifest.occupied.has(name))
    || (await Promise.all(selectedPluginNames.map(name => targetInstallationExists(target.profileRoot, name))))
      .some(Boolean)) {
    throw Error('profile_import_plugin_target_conflict')
  }
  const composed = [...input.composedEntryIds()].sort()
  if (composed.some(id => typeof id !== 'string')) throw Error('profile_import_plugin_target_conflict')
  const occupiedEntries = new Set(composed)
  const evidence = await inspectProfileImportPluginArchives({ profileRoot: source.profileRoot,
    target: source.target, uid, expectedSnapshotDigest: sourceInventory.snapshotDigest,
    selectedPluginNames, catalog: input.catalog, ...(signal ? { signal } : {}) })
  const plugins = evidence.map((item) => {
    if (item.status !== 'installed_verified' || item.lockfileResolutionVerified !== true
      || !item.archiveDigest) throw Error('profile_import_plugin_source_unverified')
    const plugin = input.catalog.getForDependency(item.name, sourceManifest.dependencies[item.name])
    if (!plugin || plugin.sha256 !== item.archiveDigest
      || new Set(plugin.entryIds).size !== plugin.entryIds.length
      || plugin.entryIds.some(id => occupiedEntries.has(id))) {
      throw Error('profile_import_plugin_entry_conflict')
    }
    for (const id of plugin.entryIds) occupiedEntries.add(id)
    return { name: plugin.name, version: plugin.version, archiveDigest: plugin.sha256,
      entryIds: [...plugin.entryIds] }
  })
  await check()
  const [sourceFinal, targetFinal] = await Promise.all([
    inspectProfileImportInventory(inventoryInput(source)), inspectProfileImportInventory(inventoryInput(target)),
  ])
  if (sourceFinal.snapshotDigest !== sourceInventory.snapshotDigest
    || targetFinal.snapshotDigest !== targetInventory.snapshotDigest
    || manifest(source.profileRoot, uid).text !== sourceManifest.text
    || manifest(target.profileRoot, uid).text !== targetManifest.text
    || pluginStateDigest(target.profileRoot, uid) !== targetPluginStateDigest
    || JSON.stringify([...input.composedEntryIds()].sort()) !== JSON.stringify(composed)
    || (await Promise.all(selectedPluginNames.map(name => targetInstallationExists(target.profileRoot, name))))
      .some(Boolean)) {
    throw Error('profile_import_inventory_changed')
  }
  return { previewDigest: preview.previewDigest, sourceSnapshotDigest: sourceInventory.snapshotDigest,
    targetSnapshotDigest: targetInventory.snapshotDigest, targetPluginStateDigest,
    composedEntryDigest: createHash('sha256').update(JSON.stringify(composed)).digest('hex'), plugins }
}
