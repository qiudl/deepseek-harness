/** Full content checks and nanosecond OS snapshots retain one original code selection, never a refreshed qualification. */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { captureRuntimeOwnerPaths, captureRuntimeOwnerTree } from '../src/runtime-entry-owner-tree.ts'
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-owner-snapshot-'))), root = join(parent, 'owner')
  mkdirSync(root); mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data/code.js'), '{}')
  onTestFinished(() =>{ rmSync(parent, { recursive: true, force: true }) })
  const path = join(root, 'data/code.js')
  utimesSync(path, 1700000000, 1700000000)
  return { root, path, parent, capture: () => captureRuntimeOwnerTree(root, { entries: 0, files: 0, bytes: 0 }) }
}
it('retains a complete original content hash and repeated cheap identity checks without opening replacement content', () => {
  const f = fixture(), snapshot = f.capture(), before = readFileSync(f.path)
  for (let i = 0; i < 20; i++) expect(() =>{  snapshot.assertCurrent() }).not.toThrow()
  expect(snapshot.tree.fileCount).toBe(1); expect(snapshot.tree.totalBytes).toBe(2)
  expect(readFileSync(f.path)).toEqual(before)
})
it.each(['add-file', 'add-empty-dir', 'delete', 'replace', 'mode', 'same-size-restored-mtime'])(
  'permanently rejects %s at an await boundary and cannot accept restored bytes', async (change) => {
    const f = fixture(), original = readFileSync(f.path), before = lstatSync(f.path, { bigint: true }), snapshot = f.capture()
    await Promise.resolve()
    if (change === 'add-file') writeFileSync(join(f.root, 'extra'), 'extra')
    else if (change === 'add-empty-dir') mkdirSync(join(f.root, 'empty'))
    else if (change === 'delete') unlinkSync(f.path)
    else if (change === 'replace') { renameSync(f.path, join(f.parent, 'original')); writeFileSync(f.path, original) }
    else if (change === 'mode') chmodSync(f.path, 0o600)
    else {
      writeFileSync(f.path, '[]'); utimesSync(f.path, 1700000000, 1700000000)
      const after = lstatSync(f.path, { bigint: true })
      expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs)
    }
    expect(() =>{  snapshot.assertCurrent() }).toThrow('runtime_owner_tree_unavailable')
    if (change === 'add-file') unlinkSync(join(f.root, 'extra'))
    else if (change === 'add-empty-dir') rmSync(join(f.root, 'empty'), { recursive: true })
    else if (change === 'mode') chmodSync(f.path, Number(before.mode & 0o777n))
    else writeFileSync(f.path, original)
    utimesSync(f.path, 1700000000, 1700000000)
    expect(() =>{  snapshot.assertCurrent() }).toThrow('runtime_owner_tree_unavailable')
  },
)
it('rejects a symlink root substitution without reading a replacement owner', () => {
  const f = fixture(), snapshot = f.capture(), saved = join(f.parent, 'saved')
  renameSync(f.root, saved); symlinkSync(saved, f.root)
  expect(() =>{  snapshot.assertCurrent() }).toThrow()
  unlinkSync(f.root); renameSync(saved, f.root)
  expect(() =>{  snapshot.assertCurrent() }).toThrow()
})
it('binds ignored dependency-directory and symlink identities as selections without hashing their separate content', () => {
  const f = fixture(), first = join(f.parent, 'first'), second = join(f.parent, 'second')
  mkdirSync(first); mkdirSync(second); symlinkSync(first, join(f.root, 'node_modules'))
  const snapshot = f.capture(); expect(snapshot.tree.fileCount).toBe(1)
  unlinkSync(join(f.root, 'node_modules')); symlinkSync(second, join(f.root, 'node_modules'))
  expect(() =>{  snapshot.assertCurrent() }).toThrow()
})
it('binds absent selection files and permanently rejects their later insertion and removal', () => {
  const f = fixture(), absent = join(f.root, 'absent'), snapshot = captureRuntimeOwnerPaths([f.root, absent, f.root])
  snapshot.assertCurrent(); writeFileSync(absent, 'new'); expect(() =>{  snapshot.assertCurrent() }).toThrow()
  unlinkSync(absent); expect(() =>{  snapshot.assertCurrent() }).toThrow()
})
it('rejects an excessive original selector set before retaining an unbounded snapshot', () => {
  expect(() => captureRuntimeOwnerPaths(Array.from({ length: 32769 }, (_, i) => '/unselected/' + String(i)))).toThrow()
})
