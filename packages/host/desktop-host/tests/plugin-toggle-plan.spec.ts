import { join } from 'node:path'
import { expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { parseDocument } from 'yaml'
import { planPluginToggle } from '../src/plugin-toggle-plan.ts'
const base = { packageName: 'base', patches: [{ insert: [{ id: 'core', name: 'core-service' }] }] }
const bundle = { packageName: 'fixture', patches: [{ insert: [{ id: 'tool', name: 'fixture-tool', config: { value: 1 } }] }] }
it('plans reversible toggles for independent bundle entries without changing configuration or other entries', () => {
  const patch = '# keep comment\n- id: core\n  config:\n    value: !!js process.platform\n'
  const disabled = planPluginToggle([base, bundle], patch, [], 'fixture', false)
  expect(disabled.patch).toContain('# keep comment')
  expect(disabled.patch).toContain('!!js process.platform')
  expect(disabled.disabled).toEqual([{ entryId: 'include:tool', moduleName: 'fixture-tool' }])
  expect(disabled.expected).toEqual([])
  const enabled = planPluginToggle([base, bundle], disabled.patch, [], 'fixture', true)
  expect(enabled.expected).toEqual([{ entryId: 'include:tool', moduleName: 'fixture-tool' }])
  expect(enabled.disabled).toEqual([])
  const rows = composeEntries([base.patches, bundle.patches, parseDocument(enabled.patch).toJSON()])
  expect(rows.find(row => row.id === 'tool')).toMatchObject({ name: 'fixture-tool', disabled: false, config: { value: 1 } })
  expect(planPluginToggle([base, bundle], enabled.patch, [], 'fixture', true).patch).toBe(enabled.patch)
})
it('rejects bundles modifying shared entries, grouped contributions, ineffective overrides and malformed patches', () => {
  const shared = { packageName: 'fixture', patches: [{ id: 'core', config: { changed: true } }] }
  expect(() => planPluginToggle([base, shared], '', [], 'fixture', false)).toThrow()
  expect(() => planPluginToggle([base, bundle], '', [{ id: 'tool', disabled: false }], 'fixture', false)).toThrow()
  expect(() => planPluginToggle([base, bundle], '', [], 'missing', false)).toThrow()
  expect(() => planPluginToggle([base, bundle], 'not: a-list', [], 'fixture', false)).toThrow()
  const grouped = { packageName: 'fixture', patches: [{ insert: [{ id: 'group', group: true, name: 'group', config: [] }] }] }
  expect(() => planPluginToggle([base, grouped], '', [], 'fixture', false)).toThrow()
})
it('disposes and restores the actual plugin through the real Cordis loader while keeping another service active', async () => {
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { pathToFileURL } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'plugin-toggle-loader-'))
  let loaded: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const plugin = join(root, 'plugin.mjs')
    writeFileSync(plugin, "import {writeFileSync,unlinkSync} from 'node:fs'; export default (ctx, config) => { ctx.effect(() => { writeFileSync(config.marker, 'active'); return () => unlinkSync(config.marker) }); };")
    const coreMarker = join(root, 'core.active'); const toolMarker = join(root, 'tool.active')
    const core = { packageName: 'base', patches: [{ insert: [{ id: 'core', name: pathToFileURL(plugin).href, config: { marker: coreMarker } }] }] }
    const tool = { packageName: 'fixture', patches: [{ insert: [{ id: 'tool', name: pathToFileURL(plugin).href, config: { marker: toolMarker } }] }] }
    let patch = ''
    for (const enabled of [true, false, true]) {
      await loaded?.fiber.dispose(); loaded = undefined
      const plan = planPluginToggle([core, tool], patch, [], 'fixture', enabled); patch = plan.patch
      const config = join(root, 'cordis.json')
      writeFileSync(config, JSON.stringify(composeEntries([core.patches, tool.patches, parseDocument(patch).toJSON()])))
      loaded = await boot('plugin-toggle-test', config)
      expect(existsSync(coreMarker)).toBe(true)
      expect(existsSync(toolMarker)).toBe(enabled)
    }
  } finally { await loaded?.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
})
