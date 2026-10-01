/** Existing Host generations remain the mutable source for settings and migration export. */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { configurationFixture } from './configuration-fixture.ts'

// The embedded settings file uses POSIX owner permissions; Windows retains its separately pinned runtime.
const nativeIt = it.skipIf(process.platform === 'win32')

nativeIt('refuses a relative owner settings path at activation', async () => {
  const { ctx } = await configurationFixture({ ownerSettings: {}, ownerSettingsConfigPath: 'relative.yaml', hmr: false })
  expect(ctx.get('configEditor')).toBeUndefined()
  expect(ctx.get('settings')).toBeUndefined()
  expect(ctx.logger.buffer.some(row => row.args.some(value => value instanceof Error && value.message.includes('must be absolute')))).toBe(true)
})

nativeIt('leaves another home settings document untouched when the Host selected an owner generation', async () => {
  const { ctx, home, start } = await configurationFixture({ ownerSettings: {
    'default-model': { provider: 'test', model: 'owner' },
  } })
  await ctx.fiber.dispose()
  const sourcePath = join(home, 'settings.yaml')
  const source = 'default-model:\n  model: unrelated-home\n'
  writeFileSync(sourcePath, source, { mode: 0o600 })
  const restored = await start()
  expect(restored.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'owner' })
  expect(readFileSync(sourcePath, 'utf8')).toBe(source)
})

nativeIt('loads released owner settings, edits the live consumer, and retains changes at restart without renaming the source', async () => {
  const { ctx, start, ownerSettingsPath, profile } = await configurationFixture({ ownerSettings: {
    'default-model': { provider: 'test', model: 'legacy' },
    first: { count: 4, token: 'fixture-private', list: [{ name: 'preset', token: 'preset-private' }] },
    'uninstalled-plugin': { retained: true },
  } })
  const patch = readFileSync(profile.patchPath, 'utf8')
  expect(ctx.settings.writable).toBe(true)
  expect(ctx.settings.documentPath).toBe(ownerSettingsPath)
  await expect(ctx.settings.prepareDocument()).resolves.toBe(ownerSettingsPath)
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'legacy' })
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.secrets)
    .toContainEqual({ path: ['token'], set: true })
  await ctx.settings.mutate('default-model', [{ op: 'set', path: ['model'], value: 'edited' }])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'edited' })
  await ctx.settings.mutate('first', [{ op: 'set', path: ['list', '0', 'name'], value: 'edited-preset' }])
  expect(parse(readFileSync(ownerSettingsPath, 'utf8'))).toMatchObject({
    'default-model': { model: 'edited' },
    first: { token: 'fixture-private', list: [{ name: 'edited-preset', token: 'preset-private' }] },
    'uninstalled-plugin': { retained: true },
  })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
  expect(statSync(ownerSettingsPath).mode & 0o777).toBe(0o600)
  await ctx.fiber.dispose()
  const restored = await start()
  expect(restored.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'edited' })
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 4, list: [{ name: 'edited-preset' }] })
})

nativeIt('rejects invalid owner edits without changing the source or live settings', async () => {
  const { ctx, ownerSettingsPath } = await configurationFixture({ ownerSettings: { first: { count: 5 } } })
  const before = readFileSync(ownerSettingsPath, 'utf8')
  await expect(ctx.settings.update('first', { count: 0 })).rejects.toThrow()
  expect(readFileSync(ownerSettingsPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})

nativeIt('refuses stale revisions after another owner-file edit', async () => {
  const { ctx } = await configurationFixture({ ownerSettings: { first: { count: 5 } } })
  const revision = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  const results = await Promise.allSettled([
    ctx.settings.update('first', { count: 6 }, revision),
    ctx.settings.update('first', { count: 7 }, revision),
  ])
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.revision).toBeGreaterThan(revision)
})

nativeIt('restores the owner document and live consumer if a plugin rejects the applied update', async () => {
  const { ctx, ownerSettingsPath } = await configurationFixture({ ownerSettings: { first: { count: 5 } },
    apply: (probe) => {
      probe.on('internal/update', (config, _noSave, next) => {
        if ((config as { count: { get(): number } }).count.get() === 6) throw new Error('fixture rejected update')
        next()
      })
    },
  })
  const before = readFileSync(ownerSettingsPath, 'utf8')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, count: 6 }))).rejects.toThrow('fixture rejected update')
  expect(readFileSync(ownerSettingsPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 5 })
})

nativeIt('retains ordinary stored fields without allowing them to redirect plugin configuration', async () => {
  const { ctx, ownerSettingsPath } = await configurationFixture({ ownerSettings: {
    first: { path: '/another-profile', count: 5, unavailable: 'retained' },
  }, schema: z.object({ path: z.string().default('/host-owned'), count: z.number().min(1).default(2).volatile() }) })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  expect((entry.fiber!.config as { path: string }).path).toBe('/host-owned')
  await ctx.settings.update('first', { count: 6 })
  expect(parse(readFileSync(ownerSettingsPath, 'utf8'))).toMatchObject({ first: { path: '/another-profile', count: 6, unavailable: 'retained' } })
  const before = readFileSync(ownerSettingsPath, 'utf8')
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, path: '/redirect' }))).rejects.toThrow('only volatile')
  expect(readFileSync(ownerSettingsPath, 'utf8')).toBe(before)
})

nativeIt('resets owner overrides without pinning inherited configuration expressions', async () => {
  const { ctx, start, profile, ownerSettingsPath } = await configurationFixture({ ownerSettings: { first: { count: 8 } } })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, '- id: first\n  config:\n    ordinary: !!js "\'inherited-expression\'"\n    count: 3\n')
  const restored = await start()
  await restored.settings.update('first', { count: 4 })
  expect(parse(readFileSync(ownerSettingsPath, 'utf8'))).toEqual({ first: { count: 4 } })
  await restored.settings.replace('first', {})
  expect(parse(readFileSync(ownerSettingsPath, 'utf8'))).toEqual({ first: {} })
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 3 })
  await restored.fiber.dispose()
  const restarted = await start()
  const first = restarted.configEditor.entries().find(row => row.options.id === 'first')!
  expect((first.fiber!.config as { ordinary: string }).ordinary).toBe('inherited-expression')
})

nativeIt('applies owner settings when a layer clears the inherited config', async () => {
  const { ctx, profile } = await configurationFixture({ ownerSettings: { first: { count: 5 } },
    schema: z.object({ count: z.number().min(1).default(2).volatile() }),
  })
  writeFileSync(profile.patchPath, '- id: first\n  config: null\n')
  await ctx.settings.update('first', { count: 6 })
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toEqual({ count: 6 })
})

nativeIt('refuses to write after the edit callback disposes its configuration owner', async () => {
  const { ctx, ownerSettingsPath } = await configurationFixture({ ownerSettings: { first: { count: 5 } } })
  const before = readFileSync(ownerSettingsPath, 'utf8')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  await expect(ctx.configEditor.edit(entry, (raw) => { void entry.fiber!.dispose(); return raw })).rejects.toThrow('no longer active')
  expect(readFileSync(ownerSettingsPath, 'utf8')).toBe(before)
})
