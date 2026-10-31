/** REQ-20261022-0022: compare inactive plugin composition using the DSH profile loader. */
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { composeEntries, createRuntimeResolution, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { inspectResolvedProfileImportTargetPluginLayer } from './profile-import-plugin-target-install.ts'
import { type ProfileImportTargetResolutionEvidence } from './profile-import-plugin-target-resolution.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Parse bundle layers without importing plugin modules or changing the live target. */
export async function inspectProfileImportPluginComposition(input: ProfileImportTargetResolutionEvidence & Readonly<{
  installAnchor: string
}>): Promise<{ beforeEntryDigest: string; afterEntryDigest: string; addedEntryIds: readonly string[] }> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  if (!isAbsolute(input.installAnchor) || !lstatSync(input.installAnchor).isFile()) {
    throw Error('profile_import_plugin_install_anchor_invalid')
  }
  const layer = await inspectResolvedProfileImportTargetPluginLayer(input)
  if (!layer) throw Error('profile_import_plugin_target_install_incomplete')
  const baselineRoot = join(layer.installationRoot, 'baseline-composition')
  const targetRoot = layer.installationRoot
  const baselineManifest = readExtensionStateFile(join(baselineRoot, 'package.json'), input.uid,
    1_048_576, 'profile_import_plugin_composition_invalid')
  const candidateManifest = readExtensionStateFile(join(targetRoot, 'package.json'), input.uid,
    1_048_576, 'profile_import_plugin_composition_invalid')
  if (baselineManifest === null || candidateManifest !== input.manifestPlan.nextManifest) {
    throw Error('profile_import_plugin_composition_invalid')
  }
  const before = loadProfileDirectory('dsh', baselineRoot, input.installAnchor)
  const after = loadProfileDirectory('dsh', targetRoot, input.installAnchor)
  if (before.skippedBundles.length || after.skippedBundles.length
    || after.layers.length !== before.layers.length + input.plan.plugins.length) {
    throw Error('profile_import_plugin_composition_skipped')
  }
  for (const plugin of input.plan.plugins) {
    const layers = after.layers.filter(row => row.packageName === plugin.name)
    if (layers.length !== 1 || !layers[0] || realpathSync(layers[0].packageDir)
      !== realpathSync(join(targetRoot, 'node_modules', plugin.name))) {
      throw Error('profile_import_plugin_composition_shadowed')
    }
  }
  const [beforeRuntime, afterRuntime] = await Promise.all([
    createRuntimeResolution({ installAnchor: input.installAnchor, profile: before,
      home: input.target.profileRoot }),
    createRuntimeResolution({ installAnchor: input.installAnchor, profile: after,
      home: input.target.profileRoot }),
  ])
  const profileEntries = (entries: typeof beforeRuntime.entries) => entries
    .filter(row => row.scope === 'profile').map(row => [row.name, row.version ?? null] as const)
  const oldPackages = profileEntries(beforeRuntime.entries)
  const newPackages = profileEntries(afterRuntime.entries)
  const oldByName = new Map(oldPackages)
  const oldLocal = new Set(beforeRuntime.localPackageNames)
  const newLocal = new Set(afterRuntime.localPackageNames)
  if (oldByName.size !== oldPackages.length
    || new Set(newPackages.map(row => row[0])).size !== newPackages.length
    || oldPackages.some(([name, version]) => !newPackages.some(candidate => candidate[0] === name
      && candidate[1] === version))
    || newPackages.some(([name]) => !oldByName.has(name))
    || oldLocal.size !== beforeRuntime.localPackageNames.length
    || newLocal.size !== afterRuntime.localPackageNames.length
    || [...oldLocal].some(name => !newLocal.has(name))
    || JSON.stringify([...newLocal].filter(name => !oldLocal.has(name)).sort())
      !== JSON.stringify(input.plan.plugins.map(plugin => plugin.name).sort())) {
    throw Error('profile_import_plugin_composition_resolution_changed')
  }
  for (const plugin of input.plan.plugins) {
    const layer = after.layers.find(row => row.packageName === plugin.name)
    if (!newLocal.has(plugin.name) || !layer
      || realpathSync(layer.packageDir)
        !== realpathSync(join(targetRoot, 'node_modules', plugin.name))) {
      throw Error('profile_import_plugin_composition_resolution_changed')
    }
  }
  const beforeWarnings: string[] = []; const afterWarnings: string[] = []
  const beforeEntries = composeEntries([...before.layers.map(row => row.patches), before.patches],
    (warning) => { beforeWarnings.push(warning) })
  const afterEntries = composeEntries([...after.layers.map(row => row.patches), after.patches],
    (warning) => { afterWarnings.push(warning) })
  if (beforeWarnings.length || afterWarnings.length) throw Error('profile_import_plugin_composition_invalid')
  const beforeById = new Map(beforeEntries.map(row => [row.id, JSON.stringify(row)]))
  if (beforeById.size !== beforeEntries.length
    || new Set(afterEntries.map(row => row.id)).size !== afterEntries.length
    || beforeEntries.some(row => !afterEntries.some(candidate => candidate.id === row.id
      && JSON.stringify(candidate) === beforeById.get(row.id)))) {
    throw Error('profile_import_plugin_composition_changed')
  }
  const added = afterEntries.filter(row => !beforeById.has(row.id)).map(row => row.id).sort()
  const expected = input.plan.plugins.flatMap(plugin => plugin.entryIds).sort()
  if (JSON.stringify(added) !== JSON.stringify(expected)) {
    throw Error('profile_import_plugin_composition_changed')
  }
  if (readExtensionStateFile(join(baselineRoot, 'package.json'), input.uid, 1_048_576,
    'profile_import_plugin_composition_invalid') !== baselineManifest
    || readExtensionStateFile(join(targetRoot, 'package.json'), input.uid, 1_048_576,
      'profile_import_plugin_composition_invalid') !== candidateManifest
    || !(await inspectResolvedProfileImportTargetPluginLayer(input))) {
    throw Error('profile_import_plugin_composition_changed')
  }
  return { beforeEntryDigest: digest(beforeEntries), afterEntryDigest: digest(afterEntries),
    addedEntryIds: added }
}
