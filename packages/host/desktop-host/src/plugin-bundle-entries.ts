import { composeEntries, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'

type Layers = readonly Pick<ProfileLayer, 'packageName' | 'patches'>[]
/**
 * Derive observable changed rows through the same ordered patch composition as the worker.
 * @param layers Installed bundle layers.
 * @param overrides Profile and home patches in runtime order.
 * @param packageName Installed bundle identity.
 * @returns Changed enabled root rows; unobservable, grouped or conditional contributions reject acknowledgement.
 */
export function pluginBundleEntries(
  layers: Layers, overrides: ProfileLayer['patches'], packageName: string,
): { entryId: string; moduleName: string }[] {
  if (layers.filter(layer => layer.packageName === packageName).length !== 1) throw Error('plugin_bundle_missing')
  const before = composeEntries([...layers.filter(layer => layer.packageName !== packageName).map(layer => layer.patches), overrides])
  const after = composeEntries([...layers.map(layer => layer.patches), overrides], () => { throw Error('plugin_patch_not_applied') })
  const original = new Map(before.map(row => [row.id, JSON.stringify(row)]))
  const changed = after.filter(row => original.get(row.id) !== JSON.stringify(row))
  if (!changed.length || before.some(row => !after.some(candidate => candidate.id === row.id))) throw Error('plugin_contribution_unobservable')
  const ids = new Set<string>()
  for (const row of after) {
    if (ids.has(row.id)) throw Error('plugin_entry_ambiguous')
    ids.add(row.id)
  }
  return changed.map((row) => {
    if (!row.id || !row.name || row.group || row.disabled) {
      throw Error('plugin_contribution_unobservable')
    }
    return { entryId: `include:${row.id}`, moduleName: row.name }
  })
}
