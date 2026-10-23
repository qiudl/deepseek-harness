/** REQ-20261022-0022: isolated lockfile resolution for a nonempty target with catalog-backed plugins. */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { bundledDependencySpec, type BundledPluginCatalog } from './bundled-plugins.ts'
import { verifyCopiedBundledPlugin } from './bundled-plugin-recovery.ts'
import { inspectIsolatedProfileImportPluginInstall, runPnpm } from './profile-import-plugin-isolated-install.ts'
import { lockfileResolutionMatches } from './profile-import-plugin-trust.ts'
import { type ProfileImportPluginPlan } from './profile-import-plugin-plan.ts'
import { planProfileImportPluginTargetManifest, type ProfileImportPluginTargetManifestPlan } from './profile-import-plugin-target-manifest.ts'
import { FileProfileImportOperationJournal } from './profile-import-operation-journal.ts'
import { ProfileImportWorkerFence } from './profile-import-worker-fence.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'
import { writePrivate, syncDirectory } from './profile-import-plugin-private-dir.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
const WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const TARGET_NPMRC = 'ignore-scripts=true\nauto-install-peers=false\npackage-import-method=copy\n'
export type ProfileImportTargetResolutionEvidence = Readonly<{
  source: Profile
  target: Profile
  uid: number
  operationId: string
  fence: ProfileImportWorkerFence
  journal: FileProfileImportOperationJournal
  catalog: BundledPluginCatalog
  plan: ProfileImportPluginPlan
  manifestPlan: ProfileImportPluginTargetManifestPlan
  composedEntryIds(): ReadonlySet<string>
  assertQuiescent(): Promise<void>
  signal?: AbortSignal
}>
type Evidence = ProfileImportTargetResolutionEvidence

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error('profile_import_plugin_target_resolution_invalid')
  }
  return value as Record<string, unknown>
}

function lockSections(text: string | null): { importer: Record<string, unknown>
  packages: Record<string, unknown>
  snapshots: Record<string, unknown> } {
  if (text === null) return { importer: {}, packages: {}, snapshots: {} }
  const document = parseDocument(text)
  if (document.errors.length || document.get('lockfileVersion') !== '9.0') {
    throw Error('profile_import_plugin_target_resolution_invalid')
  }
  const decoded = record(document.toJS())
  const importers = record(decoded.importers)
  if (JSON.stringify(Object.keys(importers)) !== JSON.stringify(['.'])) {
    throw Error('profile_import_plugin_target_resolution_invalid')
  }
  return { importer: record(record(importers['.']).dependencies ?? {}),
    packages: record(decoded.packages ?? {}), snapshots: record(decoded.snapshots ?? {}) }
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function receiptBytes(input: Evidence, lockfileDigest: string): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, operationId: input.operationId,
    sourcePlanDigest: input.manifestPlan.sourcePlanDigest,
    nextManifestDigest: input.manifestPlan.nextManifestDigest, lockfileDigest })}\n`)
}

function checkedDirectory(path: string, uid: number): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw Error('profile_import_plugin_target_resolution_unsafe')
  }
}

function matchingOldEntries(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return Object.entries(before).every(([key, value]) => JSON.stringify(after[key]) === JSON.stringify(value))
}

function exactOldArchiveKeys(dependencies: Record<string, unknown>,
  old: ReturnType<typeof lockSections>): boolean {
  const expected = Object.entries(dependencies).map(([name, spec]) => `${name}@${String(spec)}`).sort()
  return JSON.stringify(Object.keys(old.packages).sort()) === JSON.stringify(expected)
    && JSON.stringify(Object.keys(old.snapshots).sort()) === JSON.stringify(expected)
}

async function verifiedInputs(input: Evidence) {
  const { source, target, uid, operationId, plan, signal } = input
  const manifestInput = { source, target, uid, operationId, fence: input.fence,
    catalog: input.catalog, plan, composedEntryIds: input.composedEntryIds,
    assertQuiescent: input.assertQuiescent, ...(signal ? { signal } : {}) }
  if (JSON.stringify(await planProfileImportPluginTargetManifest(manifestInput))
    !== JSON.stringify(input.manifestPlan)) throw Error('profile_import_plugin_target_plan_changed')
  const isolated = await inspectIsolatedProfileImportPluginInstall({ target,
    sourceProfileId: source.profileId, uid, operationId, fence: input.fence,
    journal: input.journal, catalog: input.catalog, plan })
  if (!isolated) throw Error('profile_import_plugin_isolated_incomplete')
  return { manifestInput, isolated }
}

function targetBaseline(input: Evidence) {
  const { target, uid } = input
  const targetWeb = join(target.profileRoot, 'profiles', 'web')
  const targetManifest = readExtensionStateFile(join(targetWeb, 'package.json'), uid, 1_048_576,
    'profile_import_plugin_target_resolution_invalid')
  const originalLockfile = readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216,
    'profile_import_plugin_target_resolution_invalid')
  if (targetManifest === null
    || readExtensionStateFile(join(targetWeb, 'pnpm-workspace.yaml'), uid, 1_048_576,
      'profile_import_plugin_target_resolution_invalid') !== WORKSPACE
    || readExtensionStateFile(join(targetWeb, '.npmrc'), uid, 1_048_576,
      'profile_import_plugin_target_resolution_invalid') !== null
    || ['package.json', 'pnpm-workspace.yaml', '.npmrc'].some(file => readExtensionStateFile(
      join(target.profileRoot, file), uid, 1_048_576,
      'profile_import_plugin_target_resolution_invalid') !== null)) {
    throw Error('profile_import_plugin_target_policy_unsupported')
  }
  const dependencies = record(record(JSON.parse(targetManifest)).dependencies)
  const old = lockSections(originalLockfile)
  if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify(Object.keys(old.importer).sort())
    || !exactOldArchiveKeys(dependencies, old)) {
    throw Error('profile_import_plugin_target_resolution_invalid')
  }
  return { targetWeb, originalLockfile, dependencies, old }
}

function verifiedResolutionFiles(input: Evidence, resolutionRoot: string,
  targetWeb: string, failure: string): string {
  const { uid } = input
  const lockfile = readExtensionStateFile(join(resolutionRoot, 'pnpm-lock.yaml'), uid,
    16_777_216, 'profile_import_plugin_target_resolution_invalid')
  if (lockfile === null || readExtensionStateFile(join(resolutionRoot, 'package.json'), uid,
    1_048_576, 'profile_import_plugin_target_resolution_invalid') !== input.manifestPlan.nextManifest
    || readExtensionStateFile(join(resolutionRoot, 'pnpm-workspace.yaml'), uid,
      1_048_576, 'profile_import_plugin_target_resolution_invalid') !== WORKSPACE
    || readExtensionStateFile(join(resolutionRoot, '.npmrc'), uid,
      1_048_576, 'profile_import_plugin_target_resolution_invalid') !== TARGET_NPMRC
    || ['cordis.patch.yml', 'compatibility.json'].some(name => readExtensionStateFile(
      join(resolutionRoot, name), uid, 1_048_576, 'profile_import_plugin_target_resolution_invalid')
      !== readExtensionStateFile(join(targetWeb, name), uid, 1_048_576,
        'profile_import_plugin_target_resolution_invalid'))) throw Error(failure)
  return lockfile
}

function assertMergedLockfile(old: ReturnType<typeof lockSections>, merged: ReturnType<typeof lockSections>,
  plan: ProfileImportPluginPlan): void {
  const selectedKeys = plan.plugins.map(plugin => `${plugin.name}@${bundledDependencySpec(plugin.archiveDigest)}`)
  if (!matchingOldEntries(old.importer, merged.importer)
    || !matchingOldEntries(old.packages, merged.packages)
    || !matchingOldEntries(old.snapshots, merged.snapshots)
    || JSON.stringify(Object.keys(merged.importer).sort()) !== JSON.stringify([
      ...Object.keys(old.importer), ...plan.plugins.map(plugin => plugin.name)].sort())
    || JSON.stringify(Object.keys(merged.packages).sort()) !== JSON.stringify([
      ...Object.keys(old.packages), ...selectedKeys].sort())
    || JSON.stringify(Object.keys(merged.snapshots).sort()) !== JSON.stringify([
      ...Object.keys(old.snapshots), ...selectedKeys].sort())) {
    throw Error('profile_import_plugin_target_resolution_changed')
  }
}

async function verifyCopiedBaselineArchive(input: Evidence, targetWeb: string, archiveDirectory: string,
  name: string, spec: unknown, originalLockfile: string | null, verifyLockfile: boolean,
  missingEntryError: string): Promise<string> {
  const entry = input.catalog.getForDependency(name, spec)
  if (!entry) throw Error(missingEntryError)
  const original = readOwnerPrivateFile(join(targetWeb, '.bundled-plugins', `${entry.sha256}.tgz`),
    input.uid, 33_554_432, () => Error('profile_import_plugin_target_archive_changed'))
  const copied = readOwnerPrivateFile(join(archiveDirectory, `${entry.sha256}.tgz`), input.uid,
    33_554_432, () => Error('profile_import_plugin_target_archive_changed'))
  if (!original || !copied || !original.equals(copied)
    || createHash('sha256').update(original).digest('hex') !== entry.sha256
    || (verifyLockfile && !lockfileResolutionMatches(originalLockfile, name, spec as string,
      entry.version, original))) throw Error('profile_import_plugin_target_archive_changed')
  const installed = lstatSync(join(targetWeb, 'node_modules', name))
  await verifyCopiedBundledPlugin(input.catalog, entry, targetWeb, input.uid,
    installed.isSymbolicLink() ? 'pnpm_link' : 'copied')
  return `${entry.sha256}.tgz`
}

/** Only catalog-matched existing target archives are currently supported; every live file remains untouched. */
export async function resolveProfileImportTargetPluginsInIsolation(input: Evidence & Readonly<{
  nodeExecutablePath: string
  pnpmEntrypointPath: string
}>): Promise<{ resolutionRoot: string; lockfileDigest: string }> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { source, target, uid, operationId, plan, signal } = input
  const { manifestInput, isolated } = await verifiedInputs(input)
  const { targetWeb, originalLockfile, dependencies, old } = targetBaseline(input)
  const targetArchives = new Map<string, Buffer>()
  for (const [name, spec] of Object.entries(dependencies)) {
    const entry = input.catalog.getForDependency(name, spec)
    if (!entry) throw Error('profile_import_plugin_target_source_unsupported')
    const bytes = readOwnerPrivateFile(join(targetWeb, '.bundled-plugins', `${entry.sha256}.tgz`),
      uid, 33_554_432, () => Error('profile_import_plugin_target_archive_changed'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256
      || !lockfileResolutionMatches(originalLockfile, name, spec as string, entry.version, bytes)) {
      throw Error('profile_import_plugin_target_archive_changed')
    }
    const installed = lstatSync(join(targetWeb, 'node_modules', name))
    await verifyCopiedBundledPlugin(input.catalog, entry, targetWeb, uid,
      installed.isSymbolicLink() ? 'pnpm_link' : 'copied')
    targetArchives.set(name, bytes)
  }
  signal?.throwIfAborted()
  const resolutionRoot = join(isolated.sandboxRoot, 'target-merge')
  await mkdir(resolutionRoot, { mode: 0o700 })
  const archiveDirectory = join(resolutionRoot, '.bundled-plugins')
  await mkdir(archiveDirectory, { mode: 0o700 })
  for (const [name, bytes] of targetArchives) {
    const entry = input.catalog.getForDependency(name, dependencies[name])
    if (!entry) throw Error('profile_import_plugin_target_archive_changed')
    await writePrivate(join(archiveDirectory, `${entry.sha256}.tgz`), bytes)
  }
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(isolated.sandboxRoot, '.bundled-plugins',
      `${plugin.archiveDigest}.tgz`), uid, 33_554_432,
    () => Error('profile_import_plugin_stage_archive_changed'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    await writePrivate(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), bytes)
  }
  await writePrivate(join(resolutionRoot, 'package.json'), Buffer.from(input.manifestPlan.nextManifest))
  await writePrivate(join(resolutionRoot, 'pnpm-workspace.yaml'), Buffer.from(WORKSPACE))
  await writePrivate(join(resolutionRoot, '.npmrc'), Buffer.from(TARGET_NPMRC))
  for (const name of ['cordis.patch.yml', 'compatibility.json']) {
    const content = readExtensionStateFile(join(targetWeb, name), uid, 1_048_576,
      'profile_import_plugin_target_resolution_invalid')
    if (content !== null) await writePrivate(join(resolutionRoot, name), Buffer.from(content))
  }
  if (originalLockfile !== null) await writePrivate(join(resolutionRoot, 'pnpm-lock.yaml'), Buffer.from(originalLockfile))
  await syncDirectory(archiveDirectory)
  await syncDirectory(resolutionRoot)
  await runPnpm({ nodeExecutablePath: input.nodeExecutablePath,
    pnpmEntrypointPath: input.pnpmEntrypointPath, sandboxRoot: resolutionRoot, lockfileOnly: true,
    ...(signal ? { signal } : {}) })
  const resolvedLockfile = verifiedResolutionFiles(input, resolutionRoot, targetWeb,
    'profile_import_plugin_target_resolution_invalid')
  const resolved = lockSections(resolvedLockfile)
  assertMergedLockfile(old, resolved, plan)
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), uid,
      33_554_432, () => Error('profile_import_plugin_target_resolution_invalid'))
    if (!bytes || !lockfileResolutionMatches(resolvedLockfile, plugin.name,
      bundledDependencySpec(plugin.archiveDigest), plugin.version, bytes)) {
      throw Error('profile_import_plugin_target_resolution_invalid')
    }
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    const entry = input.catalog.getForDependency(name, spec)
    if (!entry) throw Error('profile_import_plugin_target_resolution_invalid')
    const installed = lstatSync(join(targetWeb, 'node_modules', name))
    await verifyCopiedBundledPlugin(input.catalog, entry, targetWeb, uid,
      installed.isSymbolicLink() ? 'pnpm_link' : 'copied')
  }
  if (JSON.stringify(await planProfileImportPluginTargetManifest(manifestInput))
    !== JSON.stringify(input.manifestPlan)
    || readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216,
      'profile_import_plugin_target_resolution_invalid') !== originalLockfile
    || !(await inspectIsolatedProfileImportPluginInstall({ target,
      sourceProfileId: source.profileId, uid, operationId, fence: input.fence,
      journal: input.journal, catalog: input.catalog, plan }))) {
    throw Error('profile_import_plugin_target_plan_changed')
  }
  const lockfileDigest = digest(resolvedLockfile)
  await writePrivate(join(resolutionRoot, 'resolution-receipt.json'), receiptBytes(input, lockfileDigest))
  await syncDirectory(resolutionRoot)
  const completed = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!completed || completed.resolutionRoot !== resolutionRoot
    || completed.lockfileDigest !== lockfileDigest) throw Error('profile_import_plugin_target_resolution_invalid')
  return completed
}

/** Read-only crash check for the merged lockfile; a missing receipt never authorizes publication. */
export async function inspectResolvedProfileImportTargetPluginsInIsolation(input: Evidence): Promise<{
  resolutionRoot: string
  lockfileDigest: string
} | null> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { source, target, uid, operationId, plan } = input
  const { manifestInput, isolated } = await verifiedInputs(input)
  const resolutionRoot = join(isolated.sandboxRoot, 'target-merge')
  try { checkedDirectory(resolutionRoot, uid) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const archiveDirectory = join(resolutionRoot, '.bundled-plugins')
  checkedDirectory(archiveDirectory, uid)
  const { targetWeb, originalLockfile, dependencies, old } = targetBaseline(input)
  const lockfile = verifiedResolutionFiles(input, resolutionRoot, targetWeb,
    'profile_import_plugin_target_resolution_incomplete')
  const lockfileDigest = digest(lockfile)
  const receipt = readOwnerPrivateFile(join(resolutionRoot, 'resolution-receipt.json'), uid, 65_536,
    () => Error('profile_import_plugin_target_resolution_incomplete'))
  if (!receipt?.equals(receiptBytes(input, lockfileDigest))) {
    throw Error('profile_import_plugin_target_resolution_incomplete')
  }
  const expectedArchives = new Set<string>()
  for (const [name, spec] of Object.entries(dependencies)) {
    expectedArchives.add(await verifyCopiedBaselineArchive(input, targetWeb, archiveDirectory,
      name, spec, originalLockfile, true, 'profile_import_plugin_target_source_unsupported'))
  }
  for (const plugin of plan.plugins) {
    expectedArchives.add(`${plugin.archiveDigest}.tgz`)
    const bytes = readOwnerPrivateFile(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), uid,
      33_554_432, () => Error('profile_import_plugin_target_resolution_invalid'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest
      || !lockfileResolutionMatches(lockfile, plugin.name,
        bundledDependencySpec(plugin.archiveDigest), plugin.version, bytes)) {
      throw Error('profile_import_plugin_target_resolution_invalid')
    }
  }
  if (JSON.stringify((await readdir(archiveDirectory)).sort())
    !== JSON.stringify([...expectedArchives].sort())) {
    throw Error('profile_import_plugin_target_resolution_invalid')
  }
  const merged = lockSections(lockfile)
  assertMergedLockfile(old, merged, plan)
  if (JSON.stringify(await planProfileImportPluginTargetManifest(manifestInput))
    !== JSON.stringify(input.manifestPlan)
    || readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216,
      'profile_import_plugin_target_resolution_invalid') !== originalLockfile
    || readExtensionStateFile(join(resolutionRoot, 'pnpm-lock.yaml'), uid, 16_777_216,
      'profile_import_plugin_target_resolution_invalid') !== lockfile
    || !readOwnerPrivateFile(join(resolutionRoot, 'resolution-receipt.json'), uid, 65_536,
      () => Error('profile_import_plugin_target_resolution_incomplete'))?.equals(receipt)
    || !(await inspectIsolatedProfileImportPluginInstall({ target,
      sourceProfileId: source.profileId, uid, operationId, fence: input.fence,
      journal: input.journal, catalog: input.catalog, plan }))) {
    throw Error('profile_import_plugin_target_plan_changed')
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    await verifyCopiedBaselineArchive(input, targetWeb, archiveDirectory,
      name, spec, originalLockfile, false, 'profile_import_plugin_target_archive_changed')
  }
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), uid,
      33_554_432, () => Error('profile_import_plugin_target_resolution_invalid'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_target_resolution_invalid')
    }
  }
  return { resolutionRoot, lockfileDigest }
}
