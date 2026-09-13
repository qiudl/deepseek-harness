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
