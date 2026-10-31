import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Parser } from 'tar'
import type { BundledPlugin, BundledPluginCatalog } from './bundled-plugins.ts'
import { bundledDependencySpec, parseBundledPluginSpec } from './bundled-plugins.ts'
import { HostAuthorityError } from './types.ts'

const MAX_ENTRIES = 8192
const MAX_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function checkedBytes(path: string, uid: number, maximum: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || (before.mode & 0o022) !== 0
      || before.size > maximum) throw new HostAuthorityError('runtime_incompatible')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new HostAuthorityError('recovery_preflight_stale')
      offset += read.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(path)
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.dev !== after.dev
      || current.ino !== after.ino || current.mode !== after.mode) throw new HostAuthorityError('recovery_preflight_stale')
    return bytes
  } finally { await handle.close() }
}

async function archiveInventory(bytes: Buffer, captureMetadata = false):
Promise<{ files: Map<string, { size: number; digest: string }>; metadata: Map<string, Buffer> }> {
  const files = new Map<string, { size: number; digest: string }>()
  const metadata = new Map<string, Buffer>()
  const paths = new Set<string>()
  let expanded = 0
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 65536,
      maxDecompressionRatio: Math.min(1000, MAX_BYTES / bytes.length), onReadEntry(entry) {
        const path = entry.path.replace(/\/$/u, '')
        const parts = path.split('/')
        if (parts[0] !== 'package' || parts.length > 64 || path.length > 4096
        || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))
        || paths.has(path) || paths.size >= MAX_ENTRIES
        || !['File', 'Directory'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0
        || (entry.type === 'Directory' && entry.size !== 0) || (entry.type === 'File' && parts.length < 2)) {
          parser.abort(new HostAuthorityError('runtime_incompatible'))
          return
        }
        paths.add(path)
        expanded += entry.size
        if (expanded > MAX_BYTES) { parser.abort(new HostAuthorityError('runtime_incompatible')); return }
        const hash = createHash('sha256')
        let received = 0
        const name = parts.slice(1).join('/')
        const capture = captureMetadata && entry.type === 'File' && (name === 'package.json' || name === 'cordis.patch.yml')
        if (capture && entry.size > 1_048_576) { parser.abort(new HostAuthorityError('runtime_incompatible')); return }
        const chunks: Buffer[] = []
        entry.on('data', (chunk: Buffer) => { received += chunk.length; hash.update(chunk); if (capture) chunks.push(chunk) })
        entry.on('end', () => {
          if (received !== entry.size) { parser.abort(new HostAuthorityError('runtime_incompatible')); return }
          if (entry.type === 'File') files.set(name, { size: received, digest: hash.digest('hex') })
          if (capture) metadata.set(name, Buffer.concat(chunks, received))
        })
        entry.on('error', reject)
        entry.resume()
      } })
    parser.once('error', reject)
    parser.on('ignoredEntry', () => { parser.abort(new HostAuthorityError('runtime_incompatible')) })
    parser.once('end', resolve)
    parser.end(bytes)
  })
  if (!files.has('package.json')) throw new HostAuthorityError('runtime_incompatible')
  return { files, metadata }
}

/** Read the exact catalog archive's patch without extracting or executing the package.
 * @param catalog Trusted embedding catalog. @param plugin Catalog-owned package identity.
 * @returns UTF-8 patch from the verified archive.
 */
export async function readBundledPluginPatch(catalog: BundledPluginCatalog, plugin: BundledPlugin): Promise<string> {
  try {
    const { metadata } = await archiveInventory(catalog.readArchive(plugin), true)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const manifest = metadata.get('package.json'); const patch = metadata.get('cordis.patch.yml')
    if (!manifest || !patch) throw new HostAuthorityError('runtime_incompatible')
    const identity: unknown = JSON.parse(decoder.decode(manifest))
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || (identity as Record<string, unknown>).name !== plugin.name
      || (identity as Record<string, unknown>).version !== plugin.version) throw new HostAuthorityError('runtime_incompatible')
    const dsh = (identity as Record<string, unknown>).dsh
    if (!dsh || typeof dsh !== 'object' || Array.isArray(dsh)) throw new HostAuthorityError('runtime_incompatible')
    const bundle = (dsh as Record<string, unknown>).bundle
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new HostAuthorityError('runtime_incompatible')
    const declared = (bundle as Record<string, unknown>).patch
    if (declared !== 'cordis.patch.yml' && declared !== './cordis.patch.yml') throw new HostAuthorityError('runtime_incompatible')
    return decoder.decode(patch)
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('runtime_incompatible')
  }
}

/** Verify a Profile-owned historical archive before considering it for rollback.
 * @param webRoot Authorized Profile web root. @param dependency Exact recorded file dependency.
 * @param packageName Installed bundle identity. @param uid Profile owner.
 * @param verifyInstalled Require the installed tree to match the archive before an upgrade.
 * @param installedRoot Host-selected retained tree, when recovering interrupted publication.
 * @returns Exact historical bundled identity and archive digest.
 */
export async function verifyProfileRollbackArchive(webRoot: string, dependency: string, packageName: string, uid: number,
  verifyInstalled = false, installedRoot?: string): Promise<{ spec: string; digest: string }> {
  try {
    const match = /^file:\.bundled-plugins\/([0-9a-f]{64})\.tgz$/u.exec(dependency)
    if (!match?.[1]) throw new HostAuthorityError('runtime_incompatible')
    const directory = join(webRoot, '.bundled-plugins')
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0
      || await realpath(directory) !== directory) throw new HostAuthorityError('runtime_incompatible')
    const bytes = await checkedBytes(join(directory, `${match[1]}.tgz`), uid, MAX_ARCHIVE_BYTES)
    if (digest(bytes) !== match[1]) throw new HostAuthorityError('runtime_incompatible')
    const { files, metadata } = await archiveInventory(bytes, true)
    // archiveInventory requires package.json and capture mode records every such file.
    const manifest = metadata.get('package.json') as Buffer
    const identity: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest))
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new HostAuthorityError('runtime_incompatible')
    const row = identity as Record<string, unknown>
    if (row.name !== packageName || typeof row.version !== 'string') throw new HostAuthorityError('runtime_incompatible')
    const spec = `bundled:${packageName}@${row.version}`
    if (!parseBundledPluginSpec(spec)) throw new HostAuthorityError('runtime_incompatible')
    if (verifyInstalled) await verifyInstalledFiles(installedRoot ?? join(webRoot, 'node_modules', packageName), uid, files)
    return { spec, digest: match[1] }
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('runtime_incompatible')
  }
}

async function verifyInstalledFiles(root: string, uid: number, expected: Map<string, { size: number; digest: string }>): Promise<void> {
  const directories = new Set<string>()
  for (const path of expected.keys()) {
    const parts = path.split('/')
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'))
  }
  let entries = 0; let bytes = 0
  const seen = new Set<string>()
  const visit = async (directory: string): Promise<void> => {
    const stat = await lstat(directory)
    const path = relative(root, directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0
      || (await realpath(directory)) !== directory || path.split(sep).length > 64) throw new HostAuthorityError('runtime_incompatible')
    if (path && !directories.has(path.split(sep).join('/'))) throw new HostAuthorityError('runtime_incompatible')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > MAX_ENTRIES) throw new HostAuthorityError('runtime_incompatible')
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) { await visit(absolute); continue }
      const name = relative(root, absolute).split(sep).join('/')
      const file = expected.get(name)
      if (!entry.isFile() || !file) throw new HostAuthorityError('runtime_incompatible')
      const content = await checkedBytes(absolute, uid, file.size)
      bytes += content.length
      if (bytes > MAX_BYTES || content.length !== file.size || digest(content) !== file.digest) throw new HostAuthorityError('runtime_incompatible')
      seen.add(name)
    }
  }
  await visit(root)
  if (seen.size !== expected.size) throw new HostAuthorityError('runtime_incompatible')
}

/**
 * Verify a copied plugin's entire tree against its embedding archive, including bundled dependencies.
 * Inspection performs no writes, installation, or plugin execution; unknown files and links reject recovery.
 * @param catalog Trusted embedding catalog. @param plugin Exact declared catalog row.
 * @param webRoot Existing Profile web composition. @param uid Profile owner.
 * @returns Archive digest binding the verified installed bytes to the recovery preflight.
 */
export async function verifyCopiedBundledPlugin(
  catalog: BundledPluginCatalog, plugin: BundledPlugin, webRoot: string, uid: number,
): Promise<string> {
  try {
    const archive = catalog.readArchive(plugin)
    const archiveDirectory = join(webRoot, '.bundled-plugins')
    const metadata = await lstat(archiveDirectory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
      throw new HostAuthorityError('runtime_incompatible')
    }
    const profileArchive = await checkedBytes(join(webRoot, bundledDependencySpec(plugin.sha256).slice(5)), uid, MAX_ARCHIVE_BYTES)
    if (digest(profileArchive) !== plugin.sha256) throw new HostAuthorityError('runtime_incompatible')
    const { files: expected } = await archiveInventory(archive)
    const root = join(webRoot, 'node_modules', plugin.name)
    await verifyInstalledFiles(root, uid, expected)
    const identity: unknown = JSON.parse((await checkedBytes(join(root, 'package.json'), uid, MAX_ARCHIVE_BYTES)).toString('utf8'))
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || (identity as Record<string, unknown>).name !== plugin.name
      || (identity as Record<string, unknown>).version !== plugin.version) throw new HostAuthorityError('runtime_incompatible')
    return plugin.sha256
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('runtime_incompatible')
  }
}
