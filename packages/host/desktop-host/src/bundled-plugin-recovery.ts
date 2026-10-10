import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Parser, type ReadEntry } from 'tar'
import { parse } from 'yaml'
import type { BundledPlugin } from './bundled-plugins.ts'

const LIMIT = 128 * 1024 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

/**
 * Verify an already installed, self-contained embedding plugin without extracting or executing it.
 * @param webRoot - checked Profile web composition directory.
 * @param plugin - identity from the trusted embedding catalog.
 * @param archive - embedding archive already checked against the catalog digest.
 * @param uid - Profile owner.
 * @returns digest binding the archive, lockfile, and exact installed file contents.
 */
export async function inspectBundledPluginInstallation(
  webRoot: string, plugin: BundledPlugin, archive: Buffer, uid: number,
): Promise<string> {
  const fail = () => new Error('bundled_plugin_recovery_mismatch')
  const expected = new Map<string, string>()
  const tar = gunzipSync(archive, { maxOutputLength: LIMIT })
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true })
    parser.on('error', reject)
    parser.on('end', resolve)
    parser.on('entry', (entry: ReadEntry) => {
      const path = entry.path.slice('package/'.length)
      if (entry.type !== 'File' || !entry.path.startsWith('package/') || !path
        || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
        || expected.has(path) || expected.size >= 100_000) {
        parser.abort(fail()); return
      }
      expected.set(path, '')
      const hash = createHash('sha256')
      entry.on('data', (chunk: Buffer) => hash.update(chunk))
      entry.on('end', () => expected.set(path, hash.digest('hex')))
      entry.resume()
    })
    parser.end(tar)
  })
  if (!expected.has('package.json')) throw fail()
  const checked = async (path: string, directory: boolean) => {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || stat.uid !== uid || (stat.mode & 0o022) !== 0 || (!directory && stat.size > LIMIT)) throw fail()
    return stat
  }
  const spec = `file:.bundled-plugins/${plugin.sha256}.tgz`
  await checked(join(webRoot, '.bundled-plugins'), true)
  const source = join(webRoot, '.bundled-plugins', `${plugin.sha256}.tgz`)
  await checked(source, false)
  if (digest(await readFile(source)) !== plugin.sha256) throw fail()
  const lockPath = join(webRoot, 'pnpm-lock.yaml')
  await checked(lockPath, false)
  const lockBytes = await readFile(lockPath)
  const lock: unknown = parse(lockBytes.toString('utf8'))
  const importer = field(field(field(field(lock, 'importers'), '.'), 'dependencies'), plugin.name)
  const locked = field(field(lock, 'packages'), `${plugin.name}@${spec}`)
  const resolution = field(locked, 'resolution')
  if (field(importer, 'specifier') !== spec || field(importer, 'version') !== spec || field(locked, 'version') !== plugin.version
    || field(resolution, 'tarball') !== spec
    || field(resolution, 'integrity') !== `sha512-${createHash('sha512').update(archive).digest('base64')}`) throw fail()
  let root = join(webRoot, 'node_modules')
  await checked(root, true)
  for (const segment of plugin.name.split('/')) { root = join(root, segment); await checked(root, true) }
  const manifestPath = join(root, 'package.json')
  await checked(manifestPath, false)
  const manifest: unknown = JSON.parse((await readFile(manifestPath)).toString('utf8'))
  if (field(manifest, 'name') !== plugin.name || field(manifest, 'version') !== plugin.version) throw fail()
  const observed = new Set<string>()
  let bytes = 0
  let entries = 0
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // The owning Profile inspector enforces the same entry ceiling before this check.
      /* v8 ignore next -- creating 100,001 inodes for the denial-of-service ceiling is excluded from unit fixtures. */
      if (++entries > 100_000) throw fail()
      const relative = prefix + entry.name
      const path = join(directory, entry.name)
      const stat = await checked(path, entry.isDirectory())
      if (entry.isDirectory()) await visit(path, relative + '/')
      else {
        bytes += stat.size
        if (bytes > LIMIT || !expected.has(relative) || digest(await readFile(path)) !== expected.get(relative)) throw fail()
        observed.add(relative)
      }
    }
  }
  await visit(root, '')
  if (observed.size !== expected.size) throw fail()
  return digest(Buffer.from(JSON.stringify([plugin.sha256, digest(lockBytes), [...expected].sort()])))
}
