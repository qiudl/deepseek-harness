/** REQ-20261022-0022: validate a complete plugin layer under the import fence without publishing it. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyCopiedBundledPlugin } from './bundled-plugin-recovery.ts'
import { runPnpm } from './profile-import-plugin-isolated-install.ts'
import { inspectResolvedProfileImportTargetPluginsInIsolation,
  type ProfileImportTargetResolutionEvidence } from './profile-import-plugin-target-resolution.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'

type Evidence = ProfileImportTargetResolutionEvidence

function receiptBytes(input: Evidence, lockfileDigest: string): Buffer {
  return Buffer.from(`${JSON.stringify({ version: 1, operationId: input.operationId,
    planDigest: createHash('sha256').update(JSON.stringify(input.plan)).digest('hex'),
    nextManifestDigest: input.manifestPlan.nextManifestDigest, lockfileDigest,
    names: input.plan.plugins.map(plugin => plugin.name) })}\n`)
}

async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function verifyLayer(input: Evidence, root: string): Promise<void> {
  const targetWeb = join(input.target.profileRoot, 'profiles', 'web')
  const manifest = readExtensionStateFile(join(targetWeb, 'package.json'), input.uid, 1_048_576,
    'profile_import_plugin_target_install_invalid')
  if (manifest === null) throw Error('profile_import_plugin_target_install_invalid')
  const dependencies: unknown = (JSON.parse(manifest) as { dependencies?: unknown }).dependencies
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw Error('profile_import_plugin_target_install_invalid')
  }
  for (const [name, spec] of Object.entries(dependencies)) {
    const entry = input.catalog.getForDependency(name, spec)
    if (!entry) throw Error('profile_import_plugin_target_source_unsupported')
    await verifyCopiedBundledPlugin(input.catalog, entry, root, input.uid, 'copied')
  }
  for (const plugin of input.plan.plugins) {
    const entry = input.catalog.get(plugin.name, plugin.version)
    if (!entry || entry.sha256 !== plugin.archiveDigest) {
      throw Error('profile_import_plugin_target_install_invalid')
    }
    await verifyCopiedBundledPlugin(input.catalog, entry, root, input.uid, 'copied')
  }
}

async function prepareBaseline(input: Evidence, root: string): Promise<void> {
  const targetWeb = join(input.target.profileRoot, 'profiles', 'web')
  const baselineRoot = join(root, 'baseline-composition')
  await mkdir(baselineRoot, { mode: 0o700 })
  const manifest = readExtensionStateFile(join(targetWeb, 'package.json'), input.uid, 1_048_576,
    'profile_import_plugin_target_install_invalid')
  if (manifest === null) throw Error('profile_import_plugin_target_install_invalid')
  await writePrivate(join(baselineRoot, 'package.json'), Buffer.from(manifest))
  for (const name of ['cordis.patch.yml', 'compatibility.json']) {
    const content = readExtensionStateFile(join(targetWeb, name), input.uid, 1_048_576,
      'profile_import_plugin_target_install_invalid')
    if (content !== null) await writePrivate(join(baselineRoot, name), Buffer.from(content))
  }
  await symlink(join(root, 'node_modules'), join(baselineRoot, 'node_modules'))
  await syncDirectory(baselineRoot)
}

async function verifyBaseline(input: Evidence, root: string): Promise<void> {
  const targetWeb = join(input.target.profileRoot, 'profiles', 'web')
  const baselineRoot = join(root, 'baseline-composition')
  const stat = await lstat(baselineRoot)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== input.uid
    || (stat.mode & 0o077) !== 0) throw Error('profile_import_plugin_target_install_unsafe')
  const modules = join(baselineRoot, 'node_modules')
  if (!(await lstat(modules)).isSymbolicLink()
    || await readlink(modules) !== join(root, 'node_modules')) {
    throw Error('profile_import_plugin_target_install_unsafe')
  }
  for (const name of ['package.json', 'cordis.patch.yml', 'compatibility.json']) {
    if (readExtensionStateFile(join(baselineRoot, name), input.uid, 1_048_576,
      'profile_import_plugin_target_install_invalid') !== readExtensionStateFile(
      join(targetWeb, name), input.uid, 1_048_576,
      'profile_import_plugin_target_install_invalid')) {
      throw Error('profile_import_plugin_target_install_changed')
    }
  }
}

/** Install against the already resolved frozen lockfile; a failed attempt stays isolated. */
export async function installResolvedProfileImportTargetPlugins(input: Evidence & Readonly<{
  nodeExecutablePath: string
  pnpmEntrypointPath: string
}>): Promise<{ installationRoot: string; lockfileDigest: string }> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const resolved = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!resolved) throw Error('profile_import_plugin_target_resolution_incomplete')
  const installationRoot = resolved.resolutionRoot
  try {
    await lstat(join(installationRoot, 'node_modules'))
    throw Error('profile_import_plugin_target_install_incomplete')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await runPnpm({ nodeExecutablePath: input.nodeExecutablePath,
    pnpmEntrypointPath: input.pnpmEntrypointPath, sandboxRoot: installationRoot,
    frozen: true, ...(input.signal ? { signal: input.signal } : {}) })
  const after = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!after || after.lockfileDigest !== resolved.lockfileDigest) {
    throw Error('profile_import_plugin_target_resolution_changed')
  }
  await verifyLayer(input, installationRoot)
  await prepareBaseline(input, installationRoot)
  await writePrivate(join(installationRoot, 'layer-receipt.json'), receiptBytes(input, resolved.lockfileDigest))
  await syncDirectory(installationRoot)
  const completed = await inspectResolvedProfileImportTargetPluginLayer(input)
  if (!completed) throw Error('profile_import_plugin_target_install_incomplete')
  return completed
}

/** Recheck the private, fully installed layer after a crash; it never changes live Profile files. */
export async function inspectResolvedProfileImportTargetPluginLayer(input: Evidence): Promise<{
  installationRoot: string
  lockfileDigest: string
} | null> {
  if (process.platform === 'win32') throw Error('profile_import_plugin_isolated_platform_unsupported')
  const resolved = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!resolved) throw Error('profile_import_plugin_target_resolution_incomplete')
  const installationRoot = resolved.resolutionRoot
  try {
    const stat = await lstat(join(installationRoot, 'node_modules'))
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== input.uid
      || (stat.mode & 0o022) !== 0) throw Error('profile_import_plugin_target_install_unsafe')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const receipt = readOwnerPrivateFile(join(installationRoot, 'layer-receipt.json'), input.uid,
    65_536, () => Error('profile_import_plugin_target_install_incomplete'))
  if (!receipt?.equals(receiptBytes(input, resolved.lockfileDigest))) {
    throw Error('profile_import_plugin_target_install_incomplete')
  }
  await verifyBaseline(input, installationRoot)
  await verifyLayer(input, installationRoot)
  const after = await inspectResolvedProfileImportTargetPluginsInIsolation(input)
  if (!after || after.lockfileDigest !== resolved.lockfileDigest
    || !readOwnerPrivateFile(join(installationRoot, 'layer-receipt.json'), input.uid,
      65_536, () => Error('profile_import_plugin_target_install_incomplete'))?.equals(receipt)) {
    throw Error('profile_import_plugin_target_install_incomplete')
  }
  await verifyLayer(input, installationRoot)
  await verifyBaseline(input, installationRoot)
  return { installationRoot, lockfileDigest: resolved.lockfileDigest }
}
