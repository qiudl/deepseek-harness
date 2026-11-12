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
import { readOwnerPrivateFile, syncOwnerPrivateDirectory, writeOwnerPrivateFile } from './private-file-io.ts'

type Profile = Readonly<{ profileId: string; profileRoot: string; target: FileOwnerJsonlMigrationGenerationTarget }>
const WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
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
  const expected = Object.entries(dependencies).map(([name, spec]) => `${name}@${spec as string}`).sort()
  return JSON.stringify(Object.keys(old.packages).sort()) === JSON.stringify(expected)
    && JSON.stringify(Object.keys(old.snapshots).sort()) === JSON.stringify(expected)
}

const RESOLUTION_INVALID = 'profile_import_plugin_target_resolution_invalid'

type TargetManifestInput = Parameters<typeof planProfileImportPluginTargetManifest>[0]

/** Re-derive the manifest plan and the isolated install every later stage must still observe. */
async function targetPlanEvidence(input: Evidence): Promise<{
  manifestInput: TargetManifestInput
  isolated: Readonly<{ sandboxRoot: string; lockfileDigest: string }>
}> {
  const manifestInput: TargetManifestInput = { source: input.source, target: input.target, uid: input.uid,
    operationId: input.operationId, fence: input.fence, catalog: input.catalog, plan: input.plan,
    composedEntryIds: input.composedEntryIds, assertQuiescent: input.assertQuiescent,
    ...(input.signal ? { signal: input.signal } : {}) }
  if (JSON.stringify(await planProfileImportPluginTargetManifest(manifestInput))
    !== JSON.stringify(input.manifestPlan)) throw Error('profile_import_plugin_target_plan_changed')
  const isolated = await inspectIsolatedProfileImportPluginInstall({ target: input.target,
    sourceProfileId: input.source.profileId, uid: input.uid, operationId: input.operationId,
    fence: input.fence, journal: input.journal, catalog: input.catalog, plan: input.plan })
  if (!isolated) throw Error('profile_import_plugin_isolated_incomplete')
  return { manifestInput, isolated }
}

/** Read the supported live target web: its manifest policy, lockfile, and catalog-backed dependencies. */
function readTargetWeb(input: Evidence): Readonly<{
  targetWeb: string
  targetManifest: string
  originalLockfile: string | null
  dependencies: Record<string, unknown>
  old: ReturnType<typeof lockSections>
}> {
  const { target, uid } = input
  const targetWeb = join(target.profileRoot, 'profiles', 'web')
  const targetManifest = readExtensionStateFile(join(targetWeb, 'package.json'), uid, 1_048_576, RESOLUTION_INVALID)
  const originalLockfile = readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216, RESOLUTION_INVALID)
  if (targetManifest === null
    || readExtensionStateFile(join(targetWeb, 'pnpm-workspace.yaml'), uid, 1_048_576, RESOLUTION_INVALID) !== WORKSPACE
    || readExtensionStateFile(join(targetWeb, '.npmrc'), uid, 1_048_576, RESOLUTION_INVALID) !== null
    || ['package.json', 'pnpm-workspace.yaml', '.npmrc'].some(file => readExtensionStateFile(
      join(target.profileRoot, file), uid, 1_048_576, RESOLUTION_INVALID) !== null)) {
    throw Error('profile_import_plugin_target_policy_unsupported')
  }
  const dependencies = record(record(JSON.parse(targetManifest)).dependencies)
  const old = lockSections(originalLockfile)
  if (JSON.stringify(Object.keys(dependencies).sort()) !== JSON.stringify(Object.keys(old.importer).sort())
    || !exactOldArchiveKeys(dependencies, old)) {
    throw Error(RESOLUTION_INVALID)
  }
  return { targetWeb, targetManifest, originalLockfile, dependencies, old }
}

/** Verify one target web archive survived the copy into the resolution root byte for byte. */
function copiedTargetArchive(targetWeb: string, archiveDirectory: string, uid: number, sha256: string): Buffer {
  const original = readOwnerPrivateFile(join(targetWeb, '.bundled-plugins', `${sha256}.tgz`), uid,
    33_554_432, () => Error('profile_import_plugin_target_archive_changed'))
  const copied = readOwnerPrivateFile(join(archiveDirectory, `${sha256}.tgz`), uid,
    33_554_432, () => Error('profile_import_plugin_target_archive_changed'))
  if (!original || !copied || !original.equals(copied)
    || createHash('sha256').update(original).digest('hex') !== sha256) {
    throw Error('profile_import_plugin_target_archive_changed')
  }
  return original
}

/** Require the merged resolution root to hold exactly the target files plus the selected plugin layer. */
function resolutionOutputMatches(input: Evidence, resolutionRoot: string, targetWeb: string,
  lockfile: string | null): lockfile is string {
  return lockfile !== null
    && readExtensionStateFile(join(resolutionRoot, 'package.json'), input.uid, 1_048_576,
      RESOLUTION_INVALID) === input.manifestPlan.nextManifest
    && readExtensionStateFile(join(resolutionRoot, 'pnpm-workspace.yaml'), input.uid, 1_048_576,
      RESOLUTION_INVALID) === WORKSPACE
    && readExtensionStateFile(join(resolutionRoot, '.npmrc'), input.uid, 1_048_576,
      RESOLUTION_INVALID) === 'ignore-scripts=true\nauto-install-peers=false\n'
    && ['cordis.patch.yml', 'compatibility.json'].every(name => readExtensionStateFile(
      join(resolutionRoot, name), input.uid, 1_048_576, RESOLUTION_INVALID)
      === readExtensionStateFile(join(targetWeb, name), input.uid, 1_048_576, RESOLUTION_INVALID))
}

/** Only catalog-matched existing target archives are currently supported; every live file remains untouched. */
export async function resolveProfileImportTargetPluginsInIsolation(input: Evidence & Readonly<{
  nodeExecutablePath: string
  pnpmEntrypointPath: string
}>): Promise<{ resolutionRoot: string; lockfileDigest: string }> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { uid, plan, signal } = input
  const { manifestInput, isolated } = await targetPlanEvidence(input)
  const { targetWeb, originalLockfile, dependencies, old } = readTargetWeb(input)
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
    await writeOwnerPrivateFile(join(archiveDirectory, `${entry.sha256}.tgz`), bytes)
  }
  for (const plugin of plan.plugins) {
    const bytes = readOwnerPrivateFile(join(isolated.sandboxRoot, '.bundled-plugins',
      `${plugin.archiveDigest}.tgz`), uid, 33_554_432,
    () => Error('profile_import_plugin_stage_archive_changed'))
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_stage_archive_changed')
    }
    await writeOwnerPrivateFile(join(archiveDirectory, `${plugin.archiveDigest}.tgz`), bytes)
  }
  await writeOwnerPrivateFile(join(resolutionRoot, 'package.json'), Buffer.from(input.manifestPlan.nextManifest))
  await writeOwnerPrivateFile(join(resolutionRoot, 'pnpm-workspace.yaml'), Buffer.from(WORKSPACE))
  await writeOwnerPrivateFile(join(resolutionRoot, '.npmrc'), Buffer.from('ignore-scripts=true\nauto-install-peers=false\n'))
  for (const name of ['cordis.patch.yml', 'compatibility.json']) {
    const content = readExtensionStateFile(join(targetWeb, name), uid, 1_048_576,
      'profile_import_plugin_target_resolution_invalid')
    if (content !== null) await writeOwnerPrivateFile(join(resolutionRoot, name), Buffer.from(content))
  }
  if (originalLockfile !== null) await writeOwnerPrivateFile(join(resolutionRoot, 'pnpm-lock.yaml'), Buffer.from(originalLockfile))
  await syncOwnerPrivateDirectory(archiveDirectory)
  await syncOwnerPrivateDirectory(resolutionRoot)
  await runPnpm({ nodeExecutablePath: input.nodeExecutablePath,
    pnpmEntrypointPath: input.pnpmEntrypointPath, sandboxRoot: resolutionRoot, lockfileOnly: true,
    ...(signal ? { signal } : {}) })
  const resolvedLockfile = readExtensionStateFile(join(resolutionRoot, 'pnpm-lock.yaml'), uid,
    16_777_216, RESOLUTION_INVALID)
  if (!resolutionOutputMatches(input, resolutionRoot, targetWeb, resolvedLockfile)) {
    throw Error(RESOLUTION_INVALID)
  }
  const resolved = lockSections(resolvedLockfile)
  const selectedKeys = plan.plugins.map(plugin => `${plugin.name}@${bundledDependencySpec(plugin.archiveDigest)}`)
  if (!matchingOldEntries(old.importer, resolved.importer)
    || !matchingOldEntries(old.packages, resolved.packages)
    || !matchingOldEntries(old.snapshots, resolved.snapshots)
    || JSON.stringify(Object.keys(resolved.importer).sort()) !== JSON.stringify([
      ...Object.keys(old.importer), ...plan.plugins.map(plugin => plugin.name)].sort())
    || JSON.stringify(Object.keys(resolved.packages).sort()) !== JSON.stringify([
      ...Object.keys(old.packages), ...selectedKeys].sort())
    || JSON.stringify(Object.keys(resolved.snapshots).sort()) !== JSON.stringify([
      ...Object.keys(old.snapshots), ...selectedKeys].sort())) {
    throw Error('profile_import_plugin_target_resolution_changed')
  }
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
    || readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216, RESOLUTION_INVALID) !== originalLockfile
    || !(await inspectIsolatedProfileImportPluginInstall({ target: input.target,
      sourceProfileId: input.source.profileId, uid, operationId: input.operationId, fence: input.fence,
      journal: input.journal, catalog: input.catalog, plan }))) {
    throw Error('profile_import_plugin_target_plan_changed')
  }
  const lockfileDigest = digest(resolvedLockfile)
  await writeOwnerPrivateFile(join(resolutionRoot, 'resolution-receipt.json'), receiptBytes(input, lockfileDigest))
  await syncOwnerPrivateDirectory(resolutionRoot)
  const completed = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!completed || completed.resolutionRoot !== resolutionRoot
    || completed.lockfileDigest !== lockfileDigest) throw Error(RESOLUTION_INVALID)
  return completed
}

/** Read-only crash check for the merged lockfile; a missing receipt never authorizes publication. */
export async function inspectResolvedProfileImportTargetPluginsInIsolation(input: Evidence): Promise<{
  resolutionRoot: string
  lockfileDigest: string
} | null> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const { uid, plan } = input
  const { manifestInput, isolated } = await targetPlanEvidence(input)
  const resolutionRoot = join(isolated.sandboxRoot, 'target-merge')
  try { checkedDirectory(resolutionRoot, uid) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const archiveDirectory = join(resolutionRoot, '.bundled-plugins')
  checkedDirectory(archiveDirectory, uid)
  const { targetWeb, originalLockfile, dependencies, old } = readTargetWeb(input)
  const lockfile = readExtensionStateFile(join(resolutionRoot, 'pnpm-lock.yaml'), uid, 16_777_216, RESOLUTION_INVALID)
  if (!resolutionOutputMatches(input, resolutionRoot, targetWeb, lockfile)) {
    throw Error('profile_import_plugin_target_resolution_incomplete')
  }
  const lockfileDigest = digest(lockfile)
  const receipt = readOwnerPrivateFile(join(resolutionRoot, 'resolution-receipt.json'), uid, 65_536,
    () => Error('profile_import_plugin_target_resolution_incomplete'))
  if (!receipt?.equals(receiptBytes(input, lockfileDigest))) {
    throw Error('profile_import_plugin_target_resolution_incomplete')
  }
  const expectedArchives = new Set<string>()
  for (const [name, spec] of Object.entries(dependencies)) {
    const entry = input.catalog.getForDependency(name, spec)
    if (!entry) throw Error('profile_import_plugin_target_source_unsupported')
    expectedArchives.add(`${entry.sha256}.tgz`)
    const original = copiedTargetArchive(targetWeb, archiveDirectory, uid, entry.sha256)
    if (!lockfileResolutionMatches(originalLockfile, name, spec as string, entry.version, original)) {
      throw Error('profile_import_plugin_target_archive_changed')
    }
    const installed = lstatSync(join(targetWeb, 'node_modules', name))
    await verifyCopiedBundledPlugin(input.catalog, entry, targetWeb, uid,
      installed.isSymbolicLink() ? 'pnpm_link' : 'copied')
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
  if (JSON.stringify(await planProfileImportPluginTargetManifest(manifestInput))
    !== JSON.stringify(input.manifestPlan)
    || readExtensionStateFile(join(targetWeb, 'pnpm-lock.yaml'), uid, 16_777_216, RESOLUTION_INVALID) !== originalLockfile
    || readExtensionStateFile(join(resolutionRoot, 'pnpm-lock.yaml'), uid, 16_777_216, RESOLUTION_INVALID) !== lockfile
    || !readOwnerPrivateFile(join(resolutionRoot, 'resolution-receipt.json'), uid, 65_536,
      () => Error('profile_import_plugin_target_resolution_incomplete'))?.equals(receipt)
    || !(await inspectIsolatedProfileImportPluginInstall({ target: input.target,
      sourceProfileId: input.source.profileId, uid, operationId: input.operationId, fence: input.fence,
      journal: input.journal, catalog: input.catalog, plan }))) {
    throw Error('profile_import_plugin_target_plan_changed')
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    const entry = input.catalog.getForDependency(name, spec)
    if (!entry) throw Error('profile_import_plugin_target_archive_changed')
    copiedTargetArchive(targetWeb, archiveDirectory, uid, entry.sha256)
    const installed = lstatSync(join(targetWeb, 'node_modules', name))
    await verifyCopiedBundledPlugin(input.catalog, entry, targetWeb, uid,
      installed.isSymbolicLink() ? 'pnpm_link' : 'copied')
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
