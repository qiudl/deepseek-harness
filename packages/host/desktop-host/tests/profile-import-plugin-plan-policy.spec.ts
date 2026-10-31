import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: 0, finalChanged: false, candidateState: 'new', statFailure: false }))
vi.mock('../src/profile-import-preview.ts', () => ({
  inspectProfileImportInventory: async () => {
    state.calls += 1
    return { snapshotDigest: state.finalChanged && state.calls > 2 ? 'x' : 's' }
  },
  compareProfileImportInventory: () => ({ previewDigest: 'p',
    plugins: [{ source: { name: 'fixture-plugin' }, state: state.candidateState }] }),
}))
vi.mock('../src/profile-import-plugin-trust.ts', () => ({
  inspectProfileImportPluginArchives: async () => [{ name: 'fixture-plugin', status: 'installed_verified',
    lockfileResolutionVerified: true, archiveDigest: 'a'.repeat(64) }],
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (state.statFailure && String(args[0]).endsWith('/node_modules/fixture-plugin')) {
      throw Object.assign(Error('injected inaccessible installation'), { code: 'EACCES' })
    }
    return actual.lstat(...args)
  } }
})

import { planSelectedProfileImportPlugins } from '../src/profile-import-plugin-plan.ts'
import { BundledPluginCatalog, bundledDependencySpec } from '../src/bundled-plugins.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
type Input = Parameters<typeof planSelectedProfileImportPlugins>[0]

async function fixture() {
  state.calls = 0
  state.finalChanged = false
  state.candidateState = 'new'
  state.statFailure = false
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-plan-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source')
  const targetRoot = join(root, 'target')
  const sourceWeb = join(sourceRoot, 'profiles', 'web')
  const targetWeb = join(targetRoot, 'profiles', 'web')
  await mkdir(sourceWeb, { recursive: true, mode: 0o700 })
  await mkdir(targetWeb, { recursive: true, mode: 0o700 })
  const sourceManifest = join(sourceWeb, 'package.json')
  const targetManifest = join(targetWeb, 'package.json')
  await writeFile(sourceManifest, JSON.stringify({ dependencies: { 'fixture-plugin': bundledDependencySpec('a'.repeat(64)) } }),
    { mode: 0o600 })
  await writeFile(targetManifest, JSON.stringify({ dependencies: {} }), { mode: 0o600 })
  const uid = process.getuid?.() ?? 0
  const catalogRoot = join(root, 'catalog')
  await mkdir(catalogRoot, { mode: 0o700 })
  await writeFile(join(catalogRoot, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1,
    plugins: [{ name: 'fixture-plugin', version: '1.0.0', file: 'fixture-plugin.tgz',
      sha256: 'a'.repeat(64), repository: 'https://example.com/fixture-plugin',
      sourceSha: 'b'.repeat(40), entryIds: ['fixture-entry'] }] }), { mode: 0o600 })
  const fence = new ProfileImportWorkerFence({ read: () => undefined, replace: () => {} })
  vi.spyOn(fence, 'assertOwnedPair').mockImplementation(() => {})
  const input: Input = { source: { profileId: randomUUID(), profileRoot: sourceRoot,
    target: new FileOwnerJsonlMigrationGenerationTarget(sourceRoot, uid) },
  target: { profileId: randomUUID(), profileRoot: targetRoot,
    target: new FileOwnerJsonlMigrationGenerationTarget(targetRoot, uid) },
  uid, operationId: randomUUID(), fence,
  catalog: BundledPluginCatalog.load(catalogRoot, uid),
  expectedPreviewDigest: 'p', selectedPluginNames: ['fixture-plugin'],
  composedEntryIds: () => new Set<string>(), assertQuiescent: async () => {} }
  return { input, sourceManifest, targetManifest }
}

it.skipIf(process.platform === 'win32')('rejects missing, malformed, and policy-bearing plugin manifests', async () => {
  const value = await fixture()
  for (const content of ['{', 'null', '{}', JSON.stringify({ dependencies: null })]) {
    await writeFile(value.sourceManifest, content, { mode: 0o600 })
    await expect(planSelectedProfileImportPlugins(value.input))
      .rejects.toThrow('profile_import_manifest_invalid')
  }
  await rm(value.sourceManifest)
  await expect(planSelectedProfileImportPlugins(value.input))
    .rejects.toThrow('profile_import_manifest_invalid')
})

it.skipIf(process.platform === 'win32')('rejects inaccessible installations and stale preview states', async () => {
  const value = await fixture()
  state.candidateState = 'changed'
  await expect(planSelectedProfileImportPlugins(value.input))
    .rejects.toThrow('profile_import_plugin_selection_invalid')
  state.candidateState = 'new'
  state.statFailure = true
  await expect(planSelectedProfileImportPlugins(value.input))
    .rejects.toThrow('injected inaccessible installation')
})

it.skipIf(process.platform === 'win32')('rejects invalid composed IDs and an inventory changed during planning', async () => {
  const value = await fixture()
  await expect(planSelectedProfileImportPlugins({ ...value.input,
    composedEntryIds: () => new Set<string>([42 as never]) }))
    .rejects.toThrow('profile_import_plugin_target_conflict')
  state.finalChanged = true
  state.calls = 0
  await expect(planSelectedProfileImportPlugins({ ...value.input,
    signal: new AbortController().signal }))
    .rejects.toThrow('profile_import_inventory_changed')
})
