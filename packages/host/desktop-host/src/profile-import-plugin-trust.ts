/** REQ-20261022-0022: read-only archive evidence for selected legacy Profile plugins. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { BUNDLED_ARCHIVE_DIRECTORY, type BundledPluginCatalog } from './bundled-plugins.ts'
import { verifyCopiedBundledPlugin } from './bundled-plugin-recovery.ts'
import { readExtensionStateFile } from './posix-extension-files.ts'
import { parseDocument } from 'yaml'
import { inspectProfileImportInventory } from './profile-import-preview.ts'
import type { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'

const MAX_ARCHIVE_BYTES = 33_554_432

function sourceArchiveDigest(path: string, uid: number): string {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch { throw Error('profile_import_plugin_archive_unsafe') }
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o022) !== 0
      || before.size < 1 || before.size > MAX_ARCHIVE_BYTES) throw Error('profile_import_plugin_archive_unsafe')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < before.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset)
      if (!count) throw Error('profile_import_plugin_archive_changed')
      hash.update(chunk.subarray(0, count))
      offset += count
    }
    const after = fstatSync(fd)
    const current = lstatSync(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
      || current.mode !== after.mode) throw Error('profile_import_plugin_archive_changed')
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

function checkedDirectory(path: string, uid: number): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw Error('profile_import_plugin_archive_unsafe')
  }
}

export type ProfileImportPluginArchiveEvidence = Readonly<{
  name: string
  status: 'installed_verified' | 'archive_verified' | 'source_unverified'
  archiveDigest?: string
  lockfileResolutionVerified?: boolean
}>

export function lockfileResolutionMatches(lockfile: string | null, name: string, spec: string,
  version: string, archive: Buffer): boolean {
  if (lockfile === null) return false
  try {
    const document = parseDocument(lockfile)
    if (document.errors.length || !['9.0', 9].includes(document.get('lockfileVersion') as string | number)) return false
    const key = `${name}@${spec}`
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    return document.getIn(['importers', '.', 'dependencies', name, 'specifier']) === spec
      && document.getIn(['importers', '.', 'dependencies', name, 'version']) === spec
      && document.getIn(['packages', key, 'resolution', 'tarball']) === spec
      && document.getIn(['packages', key, 'resolution', 'integrity']) === integrity
      && document.getIn(['packages', key, 'version']) === version
      && document.hasIn(['snapshots', key])
  } catch { return false }
}

/**
 * Verify only source archive bytes against an embedding catalog. This does not prove installed
 * package contents, lockfile resolution, runtime compatibility, or authorize an install.
 */
export async function inspectProfileImportPluginArchives(input: {
  profileRoot: string
  target: FileOwnerJsonlMigrationGenerationTarget
  uid: number
  expectedSnapshotDigest: string
  selectedPluginNames: readonly string[]
  catalog?: BundledPluginCatalog
  signal?: AbortSignal
}): Promise<readonly ProfileImportPluginArchiveEvidence[]> {
  const { profileRoot, target, uid, expectedSnapshotDigest, selectedPluginNames, catalog, signal } = input
  if (!isAbsolute(profileRoot) || !Number.isSafeInteger(uid) || uid < 0
    || !/^[a-f0-9]{64}$/u.test(expectedSnapshotDigest)
    || selectedPluginNames.length > 128 || new Set(selectedPluginNames).size !== selectedPluginNames.length) {
    throw Error('profile_import_plugin_selection_invalid')
  }
  signal?.throwIfAborted()
  const inventoryInput = { profileRoot, target, uid, ...(signal ? { signal } : {}) }
  const before = await inspectProfileImportInventory(inventoryInput)
  if (before.snapshotDigest !== expectedSnapshotDigest) throw Error('profile_import_inventory_changed')
  const webRoot = join(profileRoot, 'profiles', 'web')
  const manifest = readExtensionStateFile(join(webRoot, 'package.json'), uid, 1_048_576, 'profile_import_manifest_unsafe')
  if (manifest === null) throw Error('profile_import_manifest_invalid')
  const lockfile = readExtensionStateFile(join(webRoot, 'pnpm-lock.yaml'), uid, 16_777_216, 'profile_import_lockfile_unsafe')
  const dependencies = (JSON.parse(manifest) as { dependencies: Record<string, unknown> }).dependencies
  const available = new Set(before.plugins.map(plugin => plugin.name))
  const evidence: ProfileImportPluginArchiveEvidence[] = []
  const verifiedArchives: { path: string; digest: string }[] = []
  const verifiedInstallations: { plugin: NonNullable<ReturnType<BundledPluginCatalog['getForDependency']>>
    layout: 'copied' | 'pnpm_link' }[] = []
  for (const name of selectedPluginNames) {
    signal?.throwIfAborted()
    if (!available.has(name)) throw Error('profile_import_plugin_selection_invalid')
    const plugin = catalog?.getForDependency(name, dependencies[name])
    if (!plugin || !catalog) { evidence.push({ name, status: 'source_unverified' }); continue }
    const directory = join(webRoot, BUNDLED_ARCHIVE_DIRECTORY)
    try { checkedDirectory(directory, uid) } catch { throw Error('profile_import_plugin_archive_unsafe') }
    const archivePath = join(directory, `${plugin.sha256}.tgz`)
    const sourceDigest = sourceArchiveDigest(archivePath, uid)
    if (sourceDigest !== plugin.sha256) throw Error('profile_import_plugin_archive_mismatch')
    const catalogArchive = catalog.readArchive(plugin)
    verifiedArchives.push({ path: archivePath, digest: sourceDigest })
    const installedPath = join(webRoot, 'node_modules', name)
    let installed: ReturnType<typeof lstatSync> | undefined
    try { installed = lstatSync(installedPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('profile_import_plugin_install_unsafe', { cause: error })
    }
    if (installed && !installed.isSymbolicLink() && !installed.isDirectory()) {
      throw Error('profile_import_plugin_install_unsafe')
    }
    if (installed) {
      const layout = installed.isSymbolicLink() ? 'pnpm_link' as const : 'copied' as const
      try { await verifyCopiedBundledPlugin(catalog, plugin, webRoot, uid, layout) }
      catch (error) { throw Error('profile_import_plugin_install_unsafe', { cause: error }) }
      verifiedInstallations.push({ plugin, layout })
    }
    evidence.push({ name, status: installed ? 'installed_verified' : 'archive_verified',
      archiveDigest: sourceDigest,
      lockfileResolutionVerified: lockfileResolutionMatches(lockfile, name,
        dependencies[name] as string, plugin.version, catalogArchive) })
  }
  const after = await inspectProfileImportInventory(inventoryInput)
  const currentManifest = readExtensionStateFile(join(webRoot, 'package.json'), uid, 1_048_576, 'profile_import_manifest_unsafe')
  const currentLockfile = readExtensionStateFile(join(webRoot, 'pnpm-lock.yaml'), uid, 16_777_216,
    'profile_import_lockfile_unsafe')
  if (after.snapshotDigest !== expectedSnapshotDigest || currentManifest !== manifest || currentLockfile !== lockfile) {
    throw Error('profile_import_inventory_changed')
  }
  for (const archive of verifiedArchives) {
    signal?.throwIfAborted()
    if (sourceArchiveDigest(archive.path, uid) !== archive.digest) throw Error('profile_import_plugin_archive_changed')
  }
  for (const { plugin, layout } of verifiedInstallations) {
    signal?.throwIfAborted()
    if (!catalog) throw Error('profile_import_plugin_catalog_missing')
    try { await verifyCopiedBundledPlugin(catalog, plugin, webRoot, uid, layout) }
    catch (error) { throw Error('profile_import_plugin_install_unsafe', { cause: error }) }
  }
  return evidence
}
