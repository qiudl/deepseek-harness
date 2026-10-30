import { expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parseDocument } from 'yaml'
import { parseBundledUpgradePatch, planPluginUpgrade } from '../src/plugin-upgrade-plan.ts'

const base = { packageName: 'base', patches: [{ insert: [{ id: 'web', name: 'web-service', config: { searchProvider: 'official', fetchProvider: 'http' } }] }] }
const legacy = { packageName: 'ds-bot', patches: [{ insert: [{ id: 'bot', name: 'ds-bot' }] }, { id: 'web', config: { searchProvider: 'auto', fetchProvider: 'http' } }] }
const next = { packageName: 'ds-bot', patches: [{ insert: [{ id: 'bot', name: 'ds-bot' }] }] }

it('reads insertion-only bundle patches without executing them', () => {
  const source = '- insert:\n    - id: bot\n      name: ds-bot\n      config:\n        slarkExternalGroup: true\n    - id: web-search-auto\n      name: ds-bot/web-search\n'
  expect(parseBundledUpgradePatch(source)).toEqual([{ insert: [
    { id: 'bot', name: 'ds-bot', config: { slarkExternalGroup: true } },
    { id: 'web-search-auto', name: 'ds-bot/web-search' },
  ] }])
})

it.each([
  '- 1\n',
  '- insert: [1]\n',
  '- id: web\n  config: {}\n',
  '- insert:\n    - id: bot\n      name: ./local\n',
  '- insert:\n    - id: bot\n      name: ds-bot\n      config: !!js expression\n',
  '- insert:\n    - id: bot\n      name: ds-bot\n      group: true\n',
])('rejects unsupported or executable bundle patches', (patch) => {
  expect(() => parseBundledUpgradePatch(patch)).toThrow('invalid_patch')
})

it('preserves the old effective shared configuration without changing higher-priority overrides', () => {
  const patch = '# existing settings\n[]\n'
  const overrides = [{ id: 'web', config: { searchProvider: 'custom', fetchProvider: 'http' } }]
  const result = planPluginUpgrade([base, legacy], [base, next], patch, overrides, 'ds-bot')
  expect(result.patch).toContain('# existing settings')
  const old = composeEntries([base.patches, legacy.patches, parseDocument(patch).toJSON(), overrides])
  const current = composeEntries([base.patches, next.patches, parseDocument(result.patch).toJSON(), overrides])
  expect(current.find(row => row.id === 'web')).toEqual(old.find(row => row.id === 'web'))
  expect(composeEntries([base.patches, next.patches, parseDocument(result.patch).toJSON()]).find(row => row.id === 'web')?.config)
    .toEqual({ searchProvider: 'auto', fetchProvider: 'http' })
})

it('rejects changes to shared identities and other bundles', () => {
  const changed = { ...next, patches: [...next.patches, { id: 'web', disabled: true }] }
  expect(() => planPluginUpgrade([base, legacy], [base, changed], '', [], 'ds-bot')).toThrow()
  expect(() => planPluginUpgrade([base, legacy], [{ packageName: 'other', patches: base.patches }, next], '', [], 'ds-bot')).toThrow()
})

it('refuses to copy shared configuration that JSON would change', () => {
  const nonFinite = { ...legacy, patches: [...legacy.patches, { id: 'web', config: { timeout: Infinity } }] }
  expect(() => planPluginUpgrade([base, nonFinite], [base, next], '', [], 'ds-bot'))
    .toThrow('plugin_upgrade_shared_entry_changed')
})

it('refuses an unknown YAML tag rather than rewriting it', () => {
  const patch = '- id: web\n  config:\n    token: !private ENV_TOKEN\n'
  expect(() => planPluginUpgrade([base, legacy], [base, next], patch, [], 'ds-bot')).toThrow('invalid_patch')
})

it('retains comments mentioning the JavaScript tag and existing settings', () => {
  const patch = '# overrides and insert lists; `!!js` expressions allowed\n- id: bot\n  config:\n    enabled: true\n'
  const result = planPluginUpgrade([base, legacy], [base, next], patch, [], 'ds-bot')
  expect(result.patch).toContain('# overrides and insert lists; `!!js` expressions allowed')
  expect(parseDocument(result.patch).toJSON()).toContainEqual({ id: 'bot', config: { enabled: true } })
  expect(composeEntries([base.patches, next.patches, parseDocument(result.patch).toJSON()]).find(row => row.id === 'web')?.config)
    .toEqual({ searchProvider: 'auto', fetchProvider: 'http' })
})

it('leaves the patch byte-for-byte intact when no shared settings change', () => {
  const patch = '# keep formatting\n[ ]\n'
  expect(planPluginUpgrade([base, next], [base, next], patch, [], 'ds-bot').patch).toBe(patch)
})

it('bounds and validates target and local patch documents', () => {
  expect(() => parseBundledUpgradePatch(' '.repeat(1_048_577))).toThrow('invalid_patch')
  expect(() => parseBundledUpgradePatch('- insert: []\n'.repeat(129))).toThrow('invalid_patch')
  expect(() => parseBundledUpgradePatch('- insert:\n    - id: bot\n      name: ds-bot\n      config: .inf\n')).toThrow('invalid_patch')
  expect(() => planPluginUpgrade([base, legacy], [base, next], '{}\n', [], 'ds-bot')).toThrow('invalid_patch')
  expect(() => planPluginUpgrade([base, legacy], [base, next], `#${'a'.repeat(1_048_576)}\n[]\n`, [], 'ds-bot'))
    .toThrow('invalid_patch')
})

it('rejects a changed shared row that the target removes', () => {
  const removed = { ...next, patches: [...next.patches, { id: 'web', remove: true }] }
  expect(() => planPluginUpgrade([base, legacy], [base, removed], '', [], 'ds-bot'))
    .toThrow('plugin_upgrade_shared_entry_changed')
})

it('rejects shared configuration that cannot be copied without changing its values', () => {
  for (const value of [undefined, new Date('2020-01-01T00:00:00Z')]) {
    const old = { ...legacy, patches: [...legacy.patches, { id: 'web', config: { value } }] }
    const replacement = { ...next, patches: [...next.patches, { id: 'web', config: { value: 'different' } }] }
    expect(() => planPluginUpgrade([base, old], [base, replacement], '', [], 'ds-bot'))
      .toThrow('plugin_upgrade_shared_entry_changed')
  }
})
