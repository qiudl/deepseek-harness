/** Read-only bounded distribution-tree hashes for installation-selected package owners. */
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readdirSync, readlinkSync,
  type BigIntStats } from 'node:fs'
import { join } from 'node:path'

/** Shared walk budget across all independently selected owners in one installation check. */
export interface RuntimeOwnerTreeBudget { entries: number; files: number; bytes: number }
/** Full regular-member tree summary; it never installs or imports the package. */
export interface RuntimeOwnerTree { readonly treeSha256: string; readonly fileCount: number; readonly totalBytes: number }
/** An original bounded OS identity set. Drift permanently rejects this instance; it cannot capture replacement bytes. */
export interface RuntimeOwnerIdentitySnapshot {
  /** Compare original nanosecond file/directory/link identities without rereading content.
   * @returns Nothing; missing, replaced or changed paths permanently reject this snapshot. */
  assertCurrent(this: void): void
}
/** Complete content verification and the OS identities read during that same hash operation. */
export interface RuntimeOwnerTreeSnapshot extends RuntimeOwnerIdentitySnapshot { readonly tree: RuntimeOwnerTree }
const fail = (): never => { throw Error('runtime_owner_tree_unavailable') }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
interface Identity { readonly path: string; readonly stat: BigIntStats | undefined; readonly link: string | undefined }
function identity(path: string): Identity {
  let stat: BigIntStats
  try { stat = lstatSync(path, { bigint: true }) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return Object.freeze({ path, stat: undefined, link: undefined })
    throw error
  }
  return Object.freeze({ path, stat: Object.freeze(stat), link: stat.isSymbolicLink() ? readlinkSync(path) : undefined })
}
function snapshot(records: readonly Identity[], roots: readonly string[]): RuntimeOwnerIdentitySnapshot {
  let stale = false
  return Object.freeze({ assertCurrent() {
    if (stale) fail()
    try {
      for (const root of roots) if (realpathSync(root) !== root) fail()
      for (const before of records) {
        let after: BigIntStats | undefined
        try { after = lstatSync(before.path, { bigint: true }) } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        }
        if (before.stat === undefined ? after !== undefined : after === undefined || !same(before.stat, after)
          || before.link !== undefined && before.link !== readlinkSync(before.path)) fail()
      }
    } catch { stale = true; fail() }
  } })
}
/** Capture independently selected root/ancestor/link paths, including absent lookup paths.
 * @param paths - Bounded paths derived by the actual installation/Profile selector, never an SDK inventory.
 * @returns One permanently invalidated OS selection snapshot, without content or execution authority.
 */
export function captureRuntimeOwnerPaths(paths: readonly string[]): RuntimeOwnerIdentitySnapshot {
  const unique = [...new Set(paths)]
  if (unique.length > 32768) fail()
  const result = snapshot(unique.map(identity), [])
  result.assertCurrent()
  return result
}
/** Hash every distribution member, excluding only separately owned node_modules and .git trees.
 * @param root - Independently selected canonical physical package directory.
 * @param budget - Per-check global counters; traversal rejects before exceeding installation limits.
 * @returns Exact UTF8-sorted tree digest, member count and total bytes; links or file changes reject the check.
 */
export function readRuntimeOwnerTree(root: string, budget: RuntimeOwnerTreeBudget): RuntimeOwnerTree {
  return captureRuntimeOwnerTree(root, budget).tree
}
/** Bind complete content hashes and original OS identities in one bounded read, without a later recapture window.
 * @param root - Canonical independently selected distribution owner.
 * @param budget - Shared complete installation walk budget.
 * @returns Original tree digest and nanosecond identity checks owned by this capture only.
 */
export function captureRuntimeOwnerTree(root: string, budget: RuntimeOwnerTreeBudget): RuntimeOwnerTreeSnapshot {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) return fail()
  const members: [string, 'file', number, string][] = [], records: Identity[] = [], buffer = Buffer.alloc(65536)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const visit = (directory: string, relative: string, depth: number): void => {
    if (depth > 32 || realpathSync(directory) !== directory) fail()
    const before = lstatSync(directory, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) fail()
    records.push(Object.freeze({ path: directory, stat: Object.freeze(before), link: undefined }))
    for (const encoded of readdirSync(directory, { encoding: 'buffer' })) {
      const name = decoder.decode(encoded)
      if (++budget.entries > 32768) fail()
      if (name === 'node_modules' || name === '.git') { records.push(identity(join(directory, name))); continue }
      const path = relative ? relative + '/' + name : name
      if (!path.isWellFormed() || Buffer.byteLength(path) > 1536 || /[\x00-\x1f\x7f\\]/u.test(path)) fail()
      const absolute = join(directory, name), stat = lstatSync(absolute, { bigint: true })
      if (stat.isSymbolicLink()) fail()
      if (stat.isDirectory()) { visit(absolute, path, depth + 1); continue }
      if (!stat.isFile() || ++budget.files > 16384 || BigInt(budget.bytes) + stat.size > 512n * 1024n * 1024n) fail()
      const sizeBefore = Number(stat.size)
      budget.bytes += sizeBefore
      const handle = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes = 0
      const hash = createHash('sha256')
      try {
        if (!same(stat, fstatSync(handle, { bigint: true }))) fail()
        let size: number
        while ((size = readSync(handle, buffer, 0, buffer.length, null)) !== 0) {
          bytes += size
          if (bytes > sizeBefore) fail()
          hash.update(buffer.subarray(0, size))
        }
        if (bytes !== sizeBefore || !same(stat, fstatSync(handle, { bigint: true }))
          || !same(stat, lstatSync(absolute, { bigint: true }))) fail()
      } finally { closeSync(handle) }
      records.push(Object.freeze({ path: absolute, stat: Object.freeze(stat), link: undefined }))
      members.push([path, 'file', bytes, hash.digest('hex')])
    }
    if (!same(before, lstatSync(directory, { bigint: true }))) fail()
  }
  visit(root, '', 0)
  members.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
  const treeSha256 = createHash('sha256').update('dsh.runtime-entry.owner-tree/v3\0').update(JSON.stringify(members)).digest('hex')
  const guard = snapshot(records, [root])
  guard.assertCurrent()
  return Object.freeze({ tree: Object.freeze({ treeSha256, fileCount: members.length,
    totalBytes: members.reduce((n, file) => n + file[2], 0) }), assertCurrent: guard.assertCurrent })
}
