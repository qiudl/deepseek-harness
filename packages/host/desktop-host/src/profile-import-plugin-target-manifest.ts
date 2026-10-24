/** REQ-20261022-0022: read-only target manifest merge intent for selected trusted plugins. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { bundledDependencySpec, type BundledPluginCatalog } from './bundled-plugins.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { planSelectedProfileImportPlugins, type ProfileImportPluginPlan } from './profile-import-plugin-plan.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('profile_import_plugin_target_manifest_invalid')
  }
  return value as Record<string, unknown>
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export type ProfileImportPluginTargetManifestPlan = Readonly<{
  sourcePlanDigest: string
  currentManifestDigest: string
  nextManifestDigest: string
  nextManifest: string
  addedBundleNames: readonly string[]
}>

/** Preserve target declarations semantically, append only selected bundle names, and never write. */
export async function planProfileImportPluginTargetManifest(input: Readonly<{
  source: Profile
  target: Profile
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  catalog: BundledPluginCatalog
  plan: ProfileImportPluginPlan
  composedEntryIds(): ReadonlySet<string>
  assertQuiescent(): Promise<void>
  signal?: AbortSignal
}>): Promise<ProfileImportPluginTargetManifestPlan> {
  const { source, target, uid, operationId, plan, signal } = input
  const checkPlan = () => planSelectedProfileImportPlugins({ source, target, uid, operationId,
    fence: input.fence, catalog: input.catalog, expectedPreviewDigest: plan.previewDigest,
    selectedPluginNames: plan.plugins.map(plugin => plugin.name),
    composedEntryIds: input.composedEntryIds, assertQuiescent: input.assertQuiescent,
    ...(signal ? { signal } : {}) })
  if (JSON.stringify(await checkPlan()) !== JSON.stringify(plan)) {
    throw Error('profile_import_plugin_target_plan_changed')
  }
  const path = join(target.profileRoot, 'profiles', 'web', 'package.json')
  const currentManifest = readExtensionStateFile(path, uid, 1_048_576, 'profile_import_manifest_unsafe')
  if (currentManifest === null) throw Error('profile_import_plugin_target_manifest_invalid')
  let parsed: unknown
  try { parsed = JSON.parse(currentManifest) } catch { throw Error('profile_import_plugin_target_manifest_invalid') }
  const manifest = record(parsed)
  const dependencies = record(manifest.dependencies)
  const dsh = record(manifest.dsh)
  const profile = record(dsh.profile)
  const bundles = profile.bundles
  if (!Array.isArray(bundles)) throw Error('profile_import_plugin_target_manifest_invalid')
  const bundleNames: string[] = bundles.map((name: unknown) => {
    if (typeof name !== 'string') throw Error('profile_import_plugin_target_manifest_invalid')
    return name
  })
  if (new Set(bundleNames).size !== bundleNames.length) throw Error('profile_import_plugin_target_manifest_invalid')
  const names = plan.plugins.map(plugin => plugin.name)
  if (names.some(name => Object.hasOwn(dependencies, name) || bundleNames.includes(name))) {
    throw Error('profile_import_plugin_target_conflict')
  }
  const nextDependencies = { ...dependencies }
  for (const plugin of plan.plugins) {
    nextDependencies[plugin.name] = bundledDependencySpec(plugin.archiveDigest)
  }
  const nextManifest = `${JSON.stringify({ ...manifest, dependencies: nextDependencies,
    dsh: { ...dsh, profile: { ...profile, bundles: [...bundleNames, ...names] } } }, null, 2)}\n`
  if (readExtensionStateFile(path, uid, 1_048_576, 'profile_import_manifest_unsafe') !== currentManifest
    || JSON.stringify(await checkPlan()) !== JSON.stringify(plan)) {
    throw Error('profile_import_inventory_changed')
  }
  return { sourcePlanDigest: digest(JSON.stringify(plan)), currentManifestDigest: digest(currentManifest),
    nextManifestDigest: digest(nextManifest), nextManifest, addedBundleNames: names }
}
