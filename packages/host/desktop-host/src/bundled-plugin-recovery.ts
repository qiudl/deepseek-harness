import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Parser } from 'tar'
import type { BundledPlugin, BundledPluginCatalog } from './bundled-plugins.ts'
import { bundledDependencySpec } from './bundled-plugins.ts'
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

async function archiveInventory(bytes: Buffer): Promise<Map<string, { size: number; digest: string }>> {
  const files = new Map<string, { size: number; digest: string }>()
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
        entry.on('data', (chunk: Buffer) => { received += chunk.length; hash.update(chunk) })
        entry.on('end', () => {
          if (received !== entry.size) { parser.abort(new HostAuthorityError('runtime_incompatible')); return }
          if (entry.type === 'File') files.set(parts.slice(1).join('/'), { size: received, digest: hash.digest('hex') })
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
  return files
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
    const expected = await archiveInventory(archive)
    const directories = new Set<string>()
    for (const path of expected.keys()) {
      const parts = path.split('/')
      for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join('/'))
    }
    const root = join(webRoot, 'node_modules', plugin.name)
    let entries = 0
    let bytes = 0
    const seen = new Set<string>()
    const visit = async (directory: string): Promise<void> => {
      const stat = await lstat(directory)
      const path = relative(root, directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0
        || (await realpath(directory)) !== directory || path.split(sep).length > 64) {
        throw new HostAuthorityError('runtime_incompatible')
      }
      if (path && !directories.has(path.split(sep).join('/'))) {
        throw new HostAuthorityError('runtime_incompatible')
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) throw new HostAuthorityError('runtime_incompatible')
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) { await visit(absolute); continue }
        const name = relative(root, absolute).split(sep).join('/')
        const file = expected.get(name)
        if (!entry.isFile() || !file) throw new HostAuthorityError('runtime_incompatible')
        const content = await checkedBytes(absolute, uid, file.size)
        bytes += content.length
        if (bytes > MAX_BYTES || content.length !== file.size || digest(content) !== file.digest) {
          throw new HostAuthorityError('runtime_incompatible')
        }
        seen.add(name)
      }
    }
    await visit(root)
    if (seen.size !== expected.size) throw new HostAuthorityError('runtime_incompatible')
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
