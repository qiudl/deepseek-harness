/** Full owner trees include non-JavaScript bytes and reject filesystem ambiguity without writing. */
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { readRuntimeOwnerTree } from '../src/runtime-entry-owner-tree.ts'
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-owner-tree-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'a.json'), '{}'); mkdirSync(join(root, 'native'))
  writeFileSync(join(root, 'native/data.bin'), Buffer.from([0, 1, 255]))
  return root
}
it('matches independent Python literal tree bytes and ignores separately owned dependency trees', () => {
  const root = fixture(), budget = { entries: 0, files: 0, bytes: 0 }
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules/extra.js'), 'separate owner')
  mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/object'), 'not distributed')
  expect(readRuntimeOwnerTree(root, budget)).toEqual({
    treeSha256: 'a3810d125b20d027287db00f8498bd85d40847517ee30be800c5b167334c03ba', fileCount: 2, totalBytes: 5 })
  expect(budget.files).toBe(2); expect(budget.bytes).toBe(5)
})
it('detects changed, extra and missing data members', () => {
  const root = fixture(), read = () => readRuntimeOwnerTree(root, { entries: 0, files: 0, bytes: 0 }).treeSha256
  const old = read(); writeFileSync(join(root, 'a.json'), '{"x":1}')
  expect(read()).not.toBe(old)
  writeFileSync(join(root, 'a.json'), '{}'); expect(read()).toBe(old)
  writeFileSync(join(root, 'extra.dat'), 'extra'); expect(read()).not.toBe(old)
  rmSync(join(root, 'extra.dat')); rmSync(join(root, 'native/data.bin')); expect(read()).not.toBe(old)
})
it('rejects an internal symlink while preserving every original byte and directory member', () => {
  const root = fixture(), before = readFileSync(join(root, 'a.json'))
  symlinkSync('a.json', join(root, 'alias'))
  expect(() => readRuntimeOwnerTree(root, { entries: 0, files: 0, bytes: 0 })).toThrow('runtime_owner_tree_unavailable')
  expect(readFileSync(join(root, 'a.json'))).toEqual(before)
})
it.each([{ entries: 32768, files: 0, bytes: 0 }, { entries: 0, files: 16384, bytes: 0 },
  { entries: 0, files: 0, bytes: 512 * 1024 * 1024 }])('rejects before crossing the global walk budget %j', (budget) => {
  expect(() => readRuntimeOwnerTree(fixture(), budget)).toThrow('runtime_owner_tree_unavailable')
})

it('rejects invalid UTF8 at the filesystem or tree reader without changing valid members', () => {
  const root = fixture()
  try { writeFileSync(Buffer.concat([Buffer.from(root + '/'), Buffer.from([255])]), 'unrepresentable member') }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EILSEQ') throw error
    expect(readFileSync(join(root, 'a.json'), 'utf8')).toBe('{}')
    return
  }
  expect(() => readRuntimeOwnerTree(root, { entries: 0, files: 0, bytes: 0 })).toThrow()
  expect(readFileSync(join(root, 'a.json'), 'utf8')).toBe('{}')
})
