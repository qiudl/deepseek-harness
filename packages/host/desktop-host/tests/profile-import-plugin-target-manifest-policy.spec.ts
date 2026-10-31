import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { BundledPluginCatalog } from '../src/bundled-plugins.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'

const planSelected = vi.hoisted(() => vi.fn())
const manifestReads = vi.hoisted(() => ({ changeSecondRead: false, count: 0 }))
vi.mock('../src/profile-import-plugin-plan.ts', () => ({
  planSelectedProfileImportPlugins: planSelected,
}))
vi.mock('../src/posix-extension-files.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/posix-extension-files.ts')>()
  return { ...actual, readExtensionStateFile: (...args: Parameters<typeof actual.readExtensionStateFile>) => {
    const value = actual.readExtensionStateFile(...args)
    if (manifestReads.changeSecondRead && ++manifestReads.count === 2) return `${value} `
    return value
  } }
})

import { planProfileImportPluginTargetManifest } from '../src/profile-import-plugin-target-manifest.ts'

const uid = process.getuid?.() ?? 0

async function fixture() {
  manifestReads.changeSecondRead = false
  manifestReads.count = 0
  const root = await mkdtemp(join(tmpdir(), 'dsh-target-manifest-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'source')
  const targetRoot = join(root, 'target')
  const webRoot = join(targetRoot, 'profiles', 'web')
  const catalogRoot = join(root, 'catalog')
  await mkdir(sourceRoot, { mode: 0o700 })
  await mkdir(webRoot, { recursive: true, mode: 0o700 })
  await mkdir(catalogRoot, { mode: 0o700 })
  await writeFile(join(catalogRoot, 'catalog.v1.json'),
    JSON.stringify({ schemaVersion: 1, plugins: [{ name: 'new-plugin', version: '1.0.0',
      file: 'new-plugin.tgz', sha256: 'f'.repeat(64), repository: 'https://example.com/new-plugin',
      sourceSha: 'a'.repeat(40), entryIds: ['new-entry'] }] }), { mode: 0o600 })
  const manifestPath = join(webRoot, 'package.json')
  const writeManifest = (value: unknown) => writeFile(manifestPath, JSON.stringify(value), { mode: 0o600 })
  const baseline = { dependencies: {}, dsh: { profile: { bundles: [] } } }
  await writeManifest(baseline)
  const plan = { previewDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64),
    targetSnapshotDigest: 'c'.repeat(64), targetPluginStateDigest: 'd'.repeat(64),
    composedEntryDigest: 'e'.repeat(64), plugins: [{ name: 'new-plugin', version: '1.0.0',
      archiveDigest: 'f'.repeat(64), entryIds: ['new-entry'] }] }
  planSelected.mockReset().mockResolvedValue(plan)
  const input = { source: { profileId: randomUUID(), profileRoot: sourceRoot,
    target: new FileOwnerJsonlMigrationGenerationTarget(join(sourceRoot, 'persistence'), uid, 1) },
  target: { profileId: randomUUID(), profileRoot: targetRoot,
    target: new FileOwnerJsonlMigrationGenerationTarget(join(targetRoot, 'persistence'), uid, 1) },
  uid, operationId: randomUUID(),
  fence: new ProfileImportWorkerFence({ read: () => undefined, replace: () => {} }),
  catalog: BundledPluginCatalog.load(catalogRoot, uid), plan,
  composedEntryIds: () => new Set<string>(), assertQuiescent: async () => {} }
  return { input, baseline, manifestPath, plan, writeManifest }
}

it.skipIf(process.platform === 'win32')('rejects a missing manifest and a changed preflight plan', async () => {
  const value = await fixture()
  await rm(value.manifestPath)
  await expect(planProfileImportPluginTargetManifest(value.input))
    .rejects.toThrow('profile_import_plugin_target_manifest_invalid')
  await value.writeManifest(value.baseline)
  planSelected.mockResolvedValueOnce({ ...value.plan, previewDigest: '0'.repeat(64) })
  await expect(planProfileImportPluginTargetManifest(value.input))
    .rejects.toThrow('profile_import_plugin_target_plan_changed')
})

it.skipIf(process.platform === 'win32')('rejects a plan changed while target inventory is read', async () => {
  const value = await fixture()
  planSelected.mockResolvedValueOnce(value.plan)
    .mockResolvedValueOnce({ ...value.plan, previewDigest: '0'.repeat(64) })
  await expect(planProfileImportPluginTargetManifest({ ...value.input,
    signal: new AbortController().signal })).rejects.toThrow('profile_import_inventory_changed')
})

it.skipIf(process.platform === 'win32')('rejects manifest bytes changed while target inventory is read', async () => {
  const value = await fixture()
  manifestReads.changeSecondRead = true
  await expect(planProfileImportPluginTargetManifest(value.input))
    .rejects.toThrow('profile_import_inventory_changed')
})

it.skipIf(process.platform === 'win32')('rejects malformed and policy-bearing target manifests before planning a write', async () => {
  const value = await fixture()
  const invalid: Array<[unknown, string]> = [
    [null, 'profile_import_plugin_target_manifest_invalid'],
    [[], 'profile_import_plugin_target_manifest_invalid'],
    [{ ...value.baseline, dependencies: null }, 'profile_import_plugin_target_manifest_invalid'],
    [{ ...value.baseline, dsh: { profile: { bundles: 'new-plugin' } } },
      'profile_import_plugin_target_manifest_invalid'],
    [{ ...value.baseline, dsh: { profile: { bundles: [42] } } },
      'profile_import_plugin_target_manifest_invalid'],
    [{ ...value.baseline, dsh: { profile: { bundles: ['old', 'old'] } } },
      'profile_import_plugin_target_manifest_invalid'],
    [{ ...value.baseline, devDependencies: { old: '1.0.0' } },
      'profile_import_plugin_target_policy_unsupported'],
    [{ ...value.baseline, overrides: {} }, 'profile_import_plugin_target_policy_unsupported'],
    [{ ...value.baseline, dependencies: { 'new-plugin': '1.0.0' } },
      'profile_import_plugin_target_conflict'],
    [{ ...value.baseline, dsh: { profile: { bundles: ['new-plugin'] } } },
      'profile_import_plugin_target_conflict'],
  ]
  for (const [manifest, reason] of invalid) {
    await value.writeManifest(manifest)
    await expect(planProfileImportPluginTargetManifest(value.input)).rejects.toThrow(reason)
  }
  await writeFile(value.manifestPath, '{', { mode: 0o600 })
  await expect(planProfileImportPluginTargetManifest(value.input))
    .rejects.toThrow('profile_import_plugin_target_manifest_invalid')
})
