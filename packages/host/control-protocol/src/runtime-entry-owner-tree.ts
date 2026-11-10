/** Read-only bounded distribution-tree hashes for installation-selected package owners. */
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readdirSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/** Shared walk budget across all independently selected owners in one installation check. */
export interface RuntimeOwnerTreeBudget { entries: number; files: number; bytes: number }
/** Full regular-member tree summary; it never installs or imports the package. */
export interface RuntimeOwnerTree { readonly treeSha256: string; readonly fileCount: number; readonly totalBytes: number }
const fail = (): never => { throw Error('runtime_owner_tree_unavailable') }
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
/** Hash every distribution member, excluding only separately owned node_modules and .git trees.
 * @param root - Independently selected canonical physical package directory.
 * @param budget - Per-check global counters; traversal rejects before exceeding installation limits.
 * @returns Exact UTF8-sorted tree digest, member count and total bytes; links or file changes reject the check.
 */
export function readRuntimeOwnerTree(root: string, budget: RuntimeOwnerTreeBudget): RuntimeOwnerTree {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) return fail()
  const members: [string, 'file', number, string][] = [], buffer = Buffer.alloc(65536)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const visit = (directory: string, relative: string, depth: number): void => {
    if (depth > 32 || realpathSync(directory) !== directory) fail()
    const before = lstatSync(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) fail()
    for (const encoded of readdirSync(directory, { encoding: 'buffer' })) {
      const name = decoder.decode(encoded)
      if (++budget.entries > 32768) fail()
      if (name === 'node_modules' || name === '.git') continue
      const path = relative ? relative + '/' + name : name
      if (!path.isWellFormed() || Buffer.byteLength(path) > 1536 || /[\x00-\x1f\x7f\\]/u.test(path)) fail()
      const absolute = join(directory, name), stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) fail()
      if (stat.isDirectory()) { visit(absolute, path, depth + 1); continue }
      if (!stat.isFile() || ++budget.files > 16384 || budget.bytes + stat.size > 512 * 1024 * 1024) fail()
      budget.bytes += stat.size
      const handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes = 0
      const hash = createHash('sha256')
      try {
        if (!same(stat, fstatSync(handle))) fail()
        let size: number
        while ((size = readSync(handle, buffer, 0, buffer.length, null)) !== 0) {
          bytes += size
          if (bytes > stat.size) fail()
          hash.update(buffer.subarray(0, size))
        }
        if (bytes !== stat.size || !same(stat, fstatSync(handle)) || !same(stat, lstatSync(absolute))) fail()
      } finally { closeSync(handle) }
      members.push([path, 'file', bytes, hash.digest('hex')])
    }
    if (!same(before, lstatSync(directory))) fail()
  }
  visit(root, '', 0)
  members.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
  const treeSha256 = createHash('sha256').update('dsh.runtime-entry.owner-tree/v3\0').update(JSON.stringify(members)).digest('hex')
  return Object.freeze({ treeSha256, fileCount: members.length, totalBytes: members.reduce((n, file) => n + file[2], 0) })
}
