import { expect, it } from 'vitest'
import { pluginBundleEntries } from '../src/plugin-bundle-entries.ts'
const base = { packageName: 'base', patches: [{ insert: [{ id: 'existing', name: 'existing', config: { value: 1 } }] }] }
it('uses effective composition to identify inserted and reconfigured plugin rows', () => {
  const bundle = { packageName: 'fixture', patches: [{ id: 'existing', config: { value: 2 } },
    { insert: [{ id: 'added', name: '@fixture/plugin' }] }] }
  expect(pluginBundleEntries([base, bundle], [], 'fixture')).toEqual([
    { entryId: 'include:existing', moduleName: 'existing' }, { entryId: 'include:added', moduleName: '@fixture/plugin' },
  ])
})
it('refuses an empty, fully shadowed or disabled contribution as runtime proof', () => {
  const bundle = { packageName: 'fixture', patches: [{ id: 'existing', config: { value: 2 } }] }
  expect(() => pluginBundleEntries([base, bundle], [{ id: 'existing', config: { value: 1 } }], 'fixture')).toThrow()
  expect(() => pluginBundleEntries([base, { packageName: 'fixture', patches: [] }], [], 'fixture')).toThrow()
  expect(() => pluginBundleEntries([base, bundle], [{ id: 'existing', disabled: true }], 'fixture')).toThrow()
})
it('requires exactly one installed bundle with the requested identity', () => {
  expect(() => pluginBundleEntries([base], [], 'fixture')).toThrow('plugin_bundle_missing')
  expect(() => pluginBundleEntries([base, base], [], 'base')).toThrow('plugin_bundle_missing')
})
it('rejects a bundle whose patch target does not exist even when another entry is added', () => {
  const bundle = { packageName: 'fixture', patches: [
    { id: 'missing', config: { value: 2 } }, { insert: [{ id: 'added', name: '@fixture/plugin' }] },
  ] }
  expect(() => pluginBundleEntries([base, bundle], [], 'fixture')).toThrow('plugin_patch_not_applied')
})
it('rejects duplicate entry identities instead of acknowledging an ambiguous runtime row', () => {
  const bundle = { packageName: 'fixture', patches: [{ insert: [
    { id: 'existing', name: '@fixture/plugin' },
  ] }] }
  expect(() => pluginBundleEntries([base, bundle], [], 'fixture')).toThrow('plugin_entry_ambiguous')
})
