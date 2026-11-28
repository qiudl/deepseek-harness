import { composeEntries, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'

type Layers = readonly Pick<ProfileLayer, 'packageName' | 'patches'>[]
type RuntimeEntry = { entryId: string; moduleName: string }
/**
 * Root entry IDs the worker would compose now.
 * @param layers Installed bundle layers. @param overrides Profile and home patches in runtime order.
 * @returns IDs of composed root rows.
 */
export function composedEntryIds(layers: Layers, overrides: ProfileLayer['patches']): ReadonlySet<string> {
  return new Set(composeEntries([...layers.map(layer => layer.patches), overrides]).flatMap(row => row.id ? [row.id] : []))
}

/**
 * Derive observable changed rows through the same ordered patch composition as the worker.
 * @param layers Installed bundle layers.
 * @param overrides Profile and home patches in runtime order.
 * @param packageName Installed bundle identity.
 * @returns Changed enabled root rows; unobservable, grouped or conditional contributions reject acknowledgement.
 */
export function pluginBundleEntries(
  layers: Layers, overrides: ProfileLayer['patches'], packageName: string,
): RuntimeEntry[] {
  return pluginBundleContributions(layers, overrides, packageName).active
}

/**
 * Observe active contributions and one explicitly authorized shell deactivation.
 * @param layers Installed bundle layers.
 * @param overrides Profile and home patches in runtime order.
 * @param packageName Installed bundle identity.
 * @param allowedDisabledId Root legacy shell that this trusted bundle may explicitly disable.
 * @returns Active and disabled entries to verify on the same fresh worker.
 */
export function pluginBundleContributions(
  layers: Layers, overrides: ProfileLayer['patches'], packageName: string, allowedDisabledId?: string,
): { active: RuntimeEntry[]; disabled: RuntimeEntry[] } {
  const [bundle, duplicate] = layers.filter(layer => layer.packageName === packageName)
  if (!bundle || duplicate) throw Error('plugin_bundle_missing')
  const before = composeEntries([...layers.filter(layer => layer.packageName !== packageName).map(layer => layer.patches), overrides])
  const after = composeEntries([...layers.map(layer => layer.patches), overrides], () => { throw Error('plugin_patch_not_applied') })
  const original = new Map(before.map(row => [row.id, row]))
  const changed = after.filter(row => JSON.stringify(original.get(row.id)) !== JSON.stringify(row))
  if (!changed.length || before.some(row => !after.some(candidate => candidate.id === row.id))) throw Error('plugin_contribution_unobservable')
  const ids = new Set<string>()
  for (const row of after) {
    if (ids.has(row.id)) throw Error('plugin_entry_ambiguous')
    ids.add(row.id)
  }
  const active: RuntimeEntry[] = [], disabled: RuntimeEntry[] = []
  for (const row of changed) {
    if (!row.id || !row.name || row.group) throw Error('plugin_contribution_unobservable')
    const entry = { entryId: `include:${row.id}`, moduleName: row.name }
    if (!row.disabled) {
      active.push(entry)
      continue
    }
    const prior = original.get(row.id)
    if (row.id !== allowedDisabledId || !prior || prior.disabled || prior.group
      || !bundle.patches.some(patch => 'id' in patch && patch.id === row.id && patch.disabled === true
        && Object.keys(patch).length === 2)
      || JSON.stringify({ ...prior, disabled: undefined }) !== JSON.stringify({ ...row, disabled: undefined })) {
      throw Error('plugin_contribution_unobservable')
    }
    disabled.push(entry)
  }
  if (!active.length) throw Error('plugin_contribution_unobservable')
  return { active, disabled }
}
