import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const MAX_ENTRIES = 8192
const MAX_CONTENT_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024
type SnapshotEntry = { path: string; mode: number; kind: 'directory' } | { path: string; mode: number; kind: 'file'; content: string }
interface Snapshot { version: 1; rootMode: number; entries: SnapshotEntry[] }

function safeName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && name.length <= 255 && !/[\\/\x00-\x1f\x7f]/u.test(name)
}

/** Capture a stable, bounded plugin tree without following links or executing it.
 * @param root Absolute installed plugin directory. @param uid Required owner.
 * @returns Private snapshot bytes and their SHA-256 digest.
 */
export function capturePluginTree(root: string, uid: number): { bytes: Buffer; digest: string } {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw Error('unsafe_plugin_tree')
  const entries: SnapshotEntry[] = []
  let total = 0
  const inspectDirectory = (directory: string, path: string): number => {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7022) !== 0) throw Error('unsafe_plugin_tree')
    for (const name of readdirSync(directory).sort()) {
      if (!safeName(name) || entries.length >= MAX_ENTRIES) throw Error('unsafe_plugin_tree')
      const relative = path ? `${path}/${name}` : name
      if (relative.length > 4096 || relative.split('/').length > 64) throw Error('unsafe_plugin_tree')
      const child = join(directory, name); const childStat = lstatSync(child)
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        const index = entries.length
        entries.push({ path: relative, kind: 'directory', mode: 0 })
        entries[index] = { path: relative, kind: 'directory', mode: inspectDirectory(child, relative) }
      } else {
        const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const before = fstatSync(fd)
          if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o7022) !== 0
            || before.size > MAX_CONTENT_BYTES - total) throw Error('unsafe_plugin_tree')
          const bytes = readFileSync(fd); const after = fstatSync(fd); const current = lstatSync(child)
          if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || current.dev !== after.dev || current.ino !== after.ino || current.mode !== after.mode) throw Error('plugin_state_changed')
          total += bytes.length
          entries.push({ path: relative, kind: 'file', mode: before.mode & 0o777, content: bytes.toString('base64') })
        } finally { closeSync(fd) }
      }
    }
    const current = lstatSync(directory)
    if (stat.dev !== current.dev || stat.ino !== current.ino || stat.mtimeMs !== current.mtimeMs || stat.ctimeMs !== current.ctimeMs) {
      throw Error('plugin_state_changed')
    }
    return stat.mode & 0o777
  }
  const snapshot: Snapshot = { version: 1, rootMode: inspectDirectory(root, ''), entries }
  const bytes = Buffer.from(JSON.stringify(snapshot))
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw Error('unsafe_plugin_tree')
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
}

function decodeSnapshot(bytes: Buffer, digest: string): Snapshot {
  if (bytes.length > MAX_SNAPSHOT_BYTES || !/^[0-9a-f]{64}$/u.test(digest)
    || createHash('sha256').update(bytes).digest('hex') !== digest) throw Error('invalid_backup')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_backup')
  const row = value as Record<string, unknown>
  const mode = (input: unknown): input is number => Number.isInteger(input) && typeof input === 'number'
    && input >= 0 && input <= 0o777 && (input & 0o022) === 0
  if (Object.keys(row).sort().join(',') !== 'entries,rootMode,version' || row.version !== 1 || !mode(row.rootMode)
    || !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES) throw Error('invalid_backup')
  const entries: SnapshotEntry[] = []; const directories = new Set(['']); const paths = new Set<string>(); let total = 0
  for (const input of row.entries) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('invalid_backup')
    const item = input as Record<string, unknown>
    if (typeof item.path !== 'string' || item.path.length > 4096 || item.path.split('/').length > 64
      || !item.path.split('/').every(safeName) || paths.has(item.path) || !mode(item.mode)) throw Error('invalid_backup')
    const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
    if (!directories.has(parent)) throw Error('invalid_backup')
    paths.add(item.path)
    if (item.kind === 'directory' && Object.keys(item).sort().join(',') === 'kind,mode,path') {
      directories.add(item.path); entries.push({ path: item.path, mode: item.mode, kind: 'directory' })
    } else if (item.kind === 'file' && Object.keys(item).sort().join(',') === 'content,kind,mode,path' && typeof item.content === 'string') {
      const content = Buffer.from(item.content, 'base64')
      if (content.toString('base64') !== item.content || (total += content.length) > MAX_CONTENT_BYTES) throw Error('invalid_backup')
      entries.push({ path: item.path, mode: item.mode, kind: 'file', content: item.content })
    } else throw Error('invalid_backup')
  }
  return { version: 1, rootMode: row.rootMode, entries }
}

/** Restore a snapshot into a new sibling directory and retain the replaced tree for crash recovery.
 * @param root Existing installed plugin directory. @param operationId Original operation UUID.
 * @param bytes Private snapshot. @param digest Recorded snapshot SHA-256.
 * @param currentDigest Expected current tree digest. @param uid Required owner.
 * @param guard Rechecks live authorization before mutations.
 */
export function restorePluginTree(
  root: string, operationId: string, bytes: Buffer, digest: string, currentDigest: string, uid: number, guard: () => void,
): void {
  if (!isAbsolute(root) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_backup')
  const snapshot = decodeSnapshot(bytes, digest); const parent = dirname(root)
  if (basename(parent) !== 'node_modules' || !safeName(basename(root)) || realpathSync(parent) !== parent) throw Error('unsafe_plugin_tree')
  const parentStat = lstatSync(parent); const rootStat = lstatSync(root)
  if (!parentStat.isDirectory() || parentStat.uid !== uid || (parentStat.mode & 0o022) !== 0
    || !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== uid || (rootStat.mode & 0o022) !== 0) throw Error('unsafe_plugin_tree')
  const attempt = randomUUID()
  const staged = join(parent, `.plugin-tree-stage-${operationId}-${attempt}`); const previous = join(parent, `.plugin-tree-replaced-${operationId}-${attempt}`)
  guard(); mkdirSync(staged, { mode: 0o700 })
  for (const entry of snapshot.entries) {
    guard(); const path = join(staged, ...entry.path.split('/'))
    if (entry.kind === 'directory') mkdirSync(path, { mode: 0o700 })
    else {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode)
      try { writeFileSync(fd, Buffer.from(entry.content, 'base64')); fsyncSync(fd) } finally { closeSync(fd) }
      chmodSync(path, entry.mode)
    }
  }
  for (const entry of [...snapshot.entries].reverse()) if (entry.kind === 'directory') {
    const path = join(staged, ...entry.path.split('/')); chmodSync(path, entry.mode)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) }
  }
  chmodSync(staged, snapshot.rootMode)
  const stageFd = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(stageFd) } finally { closeSync(stageFd) }
  guard()
  if (capturePluginTree(root, uid).digest !== currentDigest) throw Error('plugin_state_changed')
  const current = lstatSync(root)
  if (current.dev !== rootStat.dev || current.ino !== rootStat.ino || current.mtimeMs !== rootStat.mtimeMs || current.ctimeMs !== rootStat.ctimeMs) throw Error('plugin_state_changed')
  mkdirSync(previous, { mode: 0o700 })
  const saved = join(previous, 'tree')
  renameSync(root, saved)
  try { guard(); renameSync(staged, root) } catch (error) { renameSync(saved, root); throw error }
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
}

/** Find the retained tree from an interrupted directory publication.
 * @param root Missing installed directory. @param operationId Original operation UUID. @param uid Required owner.
 * @returns One retained tree, or throws when evidence is unsafe or ambiguous.
 */
export function findInterruptedPluginTree(root: string, operationId: string, uid: number): string {
  if (!isAbsolute(root) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_backup')
  const parent = dirname(root); const metadata = lstatSync(parent)
  if (basename(parent) !== 'node_modules' || !safeName(basename(root)) || realpathSync(parent) !== parent
    || !metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) throw Error('unsafe_plugin_tree')
  try { lstatSync(root); throw Error('plugin_state_changed') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const prefix = `.plugin-tree-replaced-${operationId}-`
  const names = readdirSync(parent)
  if (names.length > MAX_ENTRIES) throw Error('unsafe_plugin_tree')
  const candidates = names.filter(name => name.startsWith(prefix)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name.slice(prefix.length)))
  if (candidates.length !== 1) throw Error('invalid_backup')
  const directory = join(parent, candidates[0] as string); const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw Error('unsafe_plugin_tree')
  return join(directory, 'tree')
}

/** Return a verified retained tree to its missing installed path without deleting other files.
 * @param root Missing installed directory. @param operationId Original operation UUID. @param expectedDigest Verified retained tree digest.
 * @param uid Required owner. @param guard Rechecks live authorization before mutation.
 */
export function returnInterruptedPluginTree(
  root: string, operationId: string, expectedDigest: string, uid: number, guard: () => void,
): void {
  const retained = findInterruptedPluginTree(root, operationId, uid)
  if (capturePluginTree(retained, uid).digest !== expectedDigest) throw Error('plugin_state_changed')
  guard()
  if (findInterruptedPluginTree(root, operationId, uid) !== retained) throw Error('plugin_state_changed')
  renameSync(retained, root)
  const fd = openSync(dirname(root), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
