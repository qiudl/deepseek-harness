import { composeEntries, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import { isMap, isSeq, parseDocument, type Document } from 'yaml'

type Layers = readonly Pick<ProfileLayer, 'packageName' | 'patches'>[]
/** A Profile patch and the runtime observations required to confirm its activation policy. */
export interface PluginTogglePlan {
  patch: string
  previousExpected: { entryId: string; moduleName: string }[]
  previousDisabled: { entryId: string; moduleName: string }[]
  expected: { entryId: string; moduleName: string }[]
  disabled: { entryId: string; moduleName: string }[]
}
/**
 * Plan activation for independently inserted root entries using the worker's patch composition.
 * @param layers Installed bundle layers in runtime order.
 * @param patch Original Profile patch, retaining comments and tagged values.
 * @param overrides Later home overrides; a conflicting override must reject the plan.
 * @param packageName Exact installed bundle name.
 * @param enabled Requested activation state.
 * @returns A bounded patch and exact active/disabled runtime expectations.
 */
export function planPluginToggle(
  layers: Layers, patch: string, overrides: ProfileLayer['patches'], packageName: string, enabled: boolean,
): PluginTogglePlan {
  if (layers.filter(layer => layer.packageName === packageName).length !== 1) throw Error('plugin_bundle_missing')
  const doc: Document = parseDocument(patch)
  if (doc.errors.length || doc.contents !== null && !isSeq(doc.contents)) throw Error('invalid_patch')
  const local = (doc.toJSON() ?? []) as ProfileLayer['patches']
  const baseline = layers.filter(layer => layer.packageName !== packageName).map(layer => layer.patches)
  const before = composeEntries([...baseline, local, overrides])
  const after = composeEntries([...layers.map(layer => layer.patches), local, overrides])
  const original = new Map(before.map(row => [row.id, JSON.stringify(row)]))
  const changed = after.filter(row => original.get(row.id) !== JSON.stringify(row))
  if (!changed.length || before.some(row => !after.some(candidate => candidate.id === row.id))) throw Error('plugin_toggle_unsupported')
  const ids = new Set<string>()
  for (const row of after) {
    if (!row.id || ids.has(row.id)) throw Error('plugin_entry_ambiguous')
    ids.add(row.id)
  }
  for (const row of changed) {
    if (original.has(row.id) || !row.name || row.group || row.disabled !== undefined && typeof row.disabled !== 'boolean') {
      throw Error('plugin_toggle_unsupported')
    }
  }
  if (doc.contents === null) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) throw Error('invalid_patch')
  for (const row of changed) {
    if ((row.disabled !== true) === enabled) continue
    const last = doc.contents.items.at(-1)
    if (isMap(last) && last.items.length === 2 && last.get('id') === row.id && typeof last.get('disabled') === 'boolean') {
      last.set('disabled', !enabled)
    } else doc.contents.add(doc.createNode({ id: row.id, disabled: !enabled }))
  }
  const next = composeEntries([...layers.map(layer => layer.patches), doc.toJSON() as ProfileLayer['patches'], overrides])
  const controlled = new Set(changed.map(row => row.id))
  if (next.length !== after.length || next.some((row) => {
    const old = after.find(candidate => candidate.id === row.id)
    return !old || (controlled.has(row.id)
      ? (row.disabled !== true) !== enabled
        || JSON.stringify({ ...row, disabled: undefined }) !== JSON.stringify({ ...old, disabled: undefined })
      : JSON.stringify(row) !== JSON.stringify(old))
  })) throw Error('plugin_toggle_shadowed')
  const result = doc.toString()
  if (Buffer.byteLength(result) > 1_048_576) throw Error('invalid_patch')
  const entries = changed.map(row => ({ entryId: `include:${row.id}`, moduleName: row.name }))
  const previousExpected = entries.filter((_entry, index) => changed[index]?.disabled !== true)
  const previousDisabled = entries.filter((_entry, index) => changed[index]?.disabled === true)
  return { patch: result, previousExpected, previousDisabled, expected: enabled ? entries : [], disabled: enabled ? [] : entries }
}

/**
 * Remove standalone activation overrides for an independently removed bundle.
 * @param patch Original Profile patch.
 * @param entryIds Exact unprefixed contribution IDs derived by the Host planner.
 * @returns Patch retaining other configuration, comments and tagged values.
 */
export function removePluginToggleOverrides(patch: string, entryIds: readonly string[]): string {
  const doc: Document = parseDocument(patch)
  if (doc.errors.length || doc.contents !== null && !isSeq(doc.contents)) throw Error('invalid_patch')
  if (!isSeq(doc.contents)) return patch
  const previous = doc.contents.items.length
  doc.contents.items = doc.contents.items.filter(row => !(isMap(row) && row.items.length === 2
    && typeof row.get('id') === 'string' && entryIds.includes(row.get('id') as string) && typeof row.get('disabled') === 'boolean'))
  return previous === doc.contents.items.length ? patch : doc.toString()
}
