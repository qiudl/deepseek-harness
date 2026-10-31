import { composeEntries, type ProfileLayer } from '@deepseek-ai/dsh-app-boot'
import { isSeq, parseDocument, type Document } from 'yaml'
import { readBundledPluginPatch } from './bundled-plugin-recovery.ts'
import type { BundledPlugin, BundledPluginCatalog } from './bundled-plugins.ts'

type Layers = readonly Pick<ProfileLayer, 'packageName' | 'patches'>[]

/** Refuse values JSON would silently alter while copying a shared configuration. */
function isPlainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && value.every(item => isPlainJson(item, ancestors))
    : Object.values(value).every(item => isPlainJson(item, ancestors))
  ancestors.delete(value)
  return valid
}

/** Parse a bundled insertion-only patch without evaluating expressions or resolving filesystem paths.
 * @param text Patch read from the validated bundle archive.
 * @returns Insertion patches suitable for planning, or throws for unsupported syntax.
 */
export function parseBundledUpgradePatch(text: string): ProfileLayer['patches'] {
  if (Buffer.byteLength(text) > 1_048_576) throw Error('invalid_patch')
  const doc = parseDocument(text)
  if (doc.errors.length || doc.warnings.length || !isSeq(doc.contents)) throw Error('invalid_patch')
  const parsed: unknown = doc.toJSON()
  if (!Array.isArray(parsed) || !isPlainJson(parsed) || parsed.length > 128) throw Error('invalid_patch')
  for (const patch of parsed as unknown[]) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('invalid_patch')
    const record = patch as Record<string, unknown>
    if (Object.keys(record).join(',') !== 'insert' || !Array.isArray(record.insert) || record.insert.length > 128) throw Error('invalid_patch')
    for (const entry of record.insert as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('invalid_patch')
      const row = entry as Record<string, unknown>
      if (Object.keys(row).some(key => !['id', 'name', 'config'].includes(key))
        || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string'
        || !row.name || row.name.startsWith('.') || row.name.startsWith('/') || row.name.includes('\\')) throw Error('invalid_patch')
    }
  }
  return parsed as ProfileLayer['patches']
}

/** Prepare a preservation patch using only the catalog-verified target archive.
 * @param catalog Trusted embedding catalog. @param plugin Exact catalog-owned target.
 * @param oldLayers Installed layers in application order. @param patch Current Profile patch.
 * @param overrides Later Profile overrides. @returns Configuration preservation plan.
 */
export async function prepareBundledPluginUpgrade(catalog: BundledPluginCatalog, plugin: BundledPlugin,
  oldLayers: Layers, patch: string, overrides: ProfileLayer['patches']): Promise<{ patch: string; patches: ProfileLayer['patches'] }> {
  const patches = parseBundledUpgradePatch(await readBundledPluginPatch(catalog, plugin))
  const newLayers = oldLayers.map(layer => layer.packageName === plugin.name ? { ...layer, patches } : layer)
  return { ...planPluginUpgrade(oldLayers, newLayers, patch, overrides, plugin.name), patches }
}

/** Plan a config-only preservation patch. Callers must persist it under a recoverable transaction. */
export function planPluginUpgrade(oldLayers: Layers, newLayers: Layers, patch: string,
  overrides: ProfileLayer['patches'], packageName: string): { patch: string } {
  if (oldLayers.filter(layer => layer.packageName === packageName).length !== 1 ||
      newLayers.filter(layer => layer.packageName === packageName).length !== 1 ||
      JSON.stringify(oldLayers.filter(layer => layer.packageName !== packageName)) !==
        JSON.stringify(newLayers.filter(layer => layer.packageName !== packageName))) throw Error('plugin_upgrade_scope_changed')
  const doc: Document = parseDocument(patch)
  if (doc.errors.length || doc.warnings.length) throw Error('invalid_patch')
  if (doc.contents === null) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) throw Error('invalid_patch')
  const local = doc.toJSON() as ProfileLayer['patches']
  const base = composeEntries(oldLayers.filter(layer => layer.packageName !== packageName).map(layer => layer.patches))
  if (base.some(row => !row.id) || new Set(base.map(row => row.id)).size !== base.length) throw Error('plugin_upgrade_shared_entry_changed')
  const before = composeEntries([...oldLayers.map(layer => layer.patches), local])
  const after = composeEntries([...newLayers.map(layer => layer.patches), local])
  let changed = false
  for (const shared of base) {
    const old = before.find(row => row.id === shared.id)
    const next = after.find(row => row.id === shared.id)
    if (!old || !next || !shared.id) throw Error('plugin_upgrade_shared_entry_changed')
    if (JSON.stringify(old) === JSON.stringify(next)) continue
    if (JSON.stringify({ ...old, config: undefined }) !== JSON.stringify({ ...next, config: undefined }) ||
        !isPlainJson(old.config)) throw Error('plugin_upgrade_shared_entry_changed')
    const config: unknown = JSON.parse(JSON.stringify(old.config))
    doc.contents.add(doc.createNode({ id: shared.id, config }))
    changed = true
  }
  const output = changed ? doc.toString() : patch
  if (Buffer.byteLength(output) > 1_048_576) throw Error('invalid_patch')
  const beforeWithPatch = composeEntries([...oldLayers.map(layer => layer.patches), doc.toJSON() as ProfileLayer['patches'], overrides])
  const preserved = composeEntries([...newLayers.map(layer => layer.patches), doc.toJSON() as ProfileLayer['patches'], overrides])
  const expected = composeEntries([...oldLayers.map(layer => layer.patches), local, overrides])
  if (JSON.stringify(beforeWithPatch) !== JSON.stringify(expected)) throw Error('plugin_upgrade_shared_entry_changed')
  for (const shared of base) {
    if (JSON.stringify(expected.find(row => row.id === shared.id)) !== JSON.stringify(preserved.find(row => row.id === shared.id))) {
      throw Error('plugin_upgrade_shared_entry_changed')
    }
  }
  return { patch: output }
}
