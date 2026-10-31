import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const state = vi.hoisted(() => ({ installationRoot: '', layerCalls: 0, missingLayer: 0,
  before: { skippedBundles: [] as string[], layers: [] as Array<{ packageName: string
    packageDir: string
    patches: string[] }>, patches: [] as string[], marker: 'before' },
  after: { skippedBundles: [] as string[], layers: [] as Array<{ packageName: string
    packageDir: string
    patches: string[] }>, patches: [] as string[], marker: 'after' },
  beforeRuntime: { entries: [] as Array<{ scope: string; name: string; version?: string }>,
    localPackageNames: [] as string[] },
  afterRuntime: { entries: [] as Array<{ scope: string; name: string; version?: string }>,
    localPackageNames: [] as string[] },
  beforeEntries: [] as Array<{ id: string; name: string }>,
  afterEntries: [] as Array<{ id: string; name: string }>,
  beforeWarning: false, afterWarning: false, dropLayerDuringRuntime: false, composeCalls: 0 }))
vi.mock('../src/profile-import-plugin-target-install.ts', () => ({
  inspectResolvedProfileImportTargetPluginLayer: async () => {
    state.layerCalls += 1
    return state.layerCalls === state.missingLayer ? undefined : { installationRoot: state.installationRoot }
  },
}))
vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  loadProfileDirectory: (_name: string, root: string) => root.endsWith('/baseline-composition')
    ? state.before : state.after,
  createRuntimeResolution: async ({ profile }: { profile: { marker: string } }) => {
    if (profile.marker === 'after' && state.dropLayerDuringRuntime) state.after.layers = []
    return profile.marker === 'before' ? state.beforeRuntime : state.afterRuntime
  },
  composeEntries: (_layers: unknown, warning: (message: string) => void) => {
    state.composeCalls += 1
    if (state.composeCalls === 1) {
      if (state.beforeWarning) warning('injected old layer warning')
      return state.beforeEntries
    }
    if (state.afterWarning) warning('injected candidate warning')
    return state.afterEntries
  },
}))

import { inspectProfileImportPluginComposition } from '../src/profile-import-plugin-composition.ts'
type Input = Parameters<typeof inspectProfileImportPluginComposition>[0]
const inspect = (input: Input) => {
  state.composeCalls = 0
  state.layerCalls = 0
  return inspectProfileImportPluginComposition(input)
}

async function fixture() {
  state.layerCalls = 0
  state.missingLayer = 0
  state.composeCalls = 0
  state.beforeWarning = false
  state.afterWarning = false
  state.dropLayerDuringRuntime = false
  state.before.skippedBundles = []
  state.before.layers = []
  state.after.skippedBundles = []
  state.before.patches = []
  state.after.patches = []
  state.beforeRuntime.entries = []
  state.afterRuntime.entries = []
  state.beforeRuntime.localPackageNames = []
  state.afterRuntime.localPackageNames = ['fixture-plugin']
  state.beforeEntries = []
  state.afterEntries = [{ id: 'fixture-entry', name: 'fixture-plugin' }]
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-composition-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const installationRoot = join(root, 'installation')
  state.installationRoot = installationRoot
  const baselineRoot = join(installationRoot, 'baseline-composition')
  const pluginRoot = join(installationRoot, 'node_modules', 'fixture-plugin')
  await mkdir(baselineRoot, { recursive: true, mode: 0o700 })
  await mkdir(pluginRoot, { recursive: true, mode: 0o700 })
  state.after.layers = [{ packageName: 'fixture-plugin', packageDir: pluginRoot, patches: [] }]
  const anchor = join(root, 'anchor.js')
  await writeFile(anchor, '', { mode: 0o600 })
  const nextManifest = JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } })
  await writeFile(join(baselineRoot, 'package.json'), JSON.stringify({ dependencies: {} }), { mode: 0o600 })
  await writeFile(join(installationRoot, 'package.json'), nextManifest, { mode: 0o600 })
  const input = { installAnchor: anchor, uid: process.getuid?.() ?? 0,
    target: { profileRoot: root }, manifestPlan: { nextManifest },
    plan: { plugins: [{ name: 'fixture-plugin', entryIds: ['fixture-entry'] }] },
    operationId: randomUUID() } as Input
  return { input, root, baselineRoot, installationRoot, pluginRoot }
}

it.skipIf(process.platform === 'win32')('accepts an isolated additive composition', async () => {
  const value = await fixture()
  expect(await inspect(value.input)).toMatchObject({
    addedEntryIds: ['fixture-entry'],
  })
})

it('rejects Windows before touching an installation', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
  try {
    await expect(inspect({ installAnchor: 'unused' } as Input))
      .rejects.toThrow('profile_import_plugin_isolated_platform_unsupported')
  } finally { Object.defineProperty(process, 'platform', original) }
})

it.skipIf(process.platform === 'win32')('rejects missing anchor, install, and manifest evidence', async () => {
  const value = await fixture()
  await expect(inspect({ ...value.input, installAnchor: 'relative' }))
    .rejects.toThrow('profile_import_plugin_install_anchor_invalid')
  state.missingLayer = 1
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_target_install_incomplete')
  state.layerCalls = 0
  state.missingLayer = 0
  await rm(join(value.baselineRoot, 'package.json'))
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_invalid')
})

it.skipIf(process.platform === 'win32')('rejects skipped, shadowed, and changed local package layers', async () => {
  const value = await fixture()
  state.after.skippedBundles = ['fixture-plugin']
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_skipped')
  state.after.skippedBundles = []
  state.after.layers[0]!.packageName = 'other'
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_shadowed')
  state.after.layers[0]!.packageName = 'fixture-plugin'
  state.afterRuntime.localPackageNames = ['other']
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_resolution_changed')
})

it.skipIf(process.platform === 'win32')('rejects changed runtime, entry, and final layer evidence', async () => {
  const value = await fixture()
  state.afterRuntime.entries = [{ scope: 'profile', name: 'unexpected', version: '1.0.0' }]
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_resolution_changed')
  state.afterRuntime.entries = []
  state.afterWarning = true
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_invalid')
  state.afterWarning = false
  state.afterEntries = [{ id: 'unexpected', name: 'fixture-plugin' }]
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_changed')
  state.afterEntries = [{ id: 'fixture-entry', name: 'fixture-plugin' }]
  state.layerCalls = 0
  state.missingLayer = 2
  await expect(inspect(value.input))
    .rejects.toThrow('profile_import_plugin_composition_changed')
})

it.skipIf(process.platform === 'win32')('rejects composition drift after runtime resolution and malformed old entries', async () => {
  const value = await fixture()
  state.beforeRuntime.entries = [{ scope: 'profile', name: 'baseline' }]
  state.afterRuntime.entries = [{ scope: 'profile', name: 'baseline' }]
  await expect(inspect(value.input)).resolves.toMatchObject({ addedEntryIds: ['fixture-entry'] })
  state.beforeWarning = true
  await expect(inspect(value.input)).rejects.toThrow('profile_import_plugin_composition_invalid')
  state.beforeWarning = false
  state.beforeEntries = [{ id: 'baseline', name: 'old' }, { id: 'baseline', name: 'old' }]
  await expect(inspect(value.input)).rejects.toThrow('profile_import_plugin_composition_changed')
  state.beforeEntries = []
  state.dropLayerDuringRuntime = true
  await expect(inspect(value.input)).rejects.toThrow('profile_import_plugin_composition_resolution_changed')
})
