import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { capturePluginTree, findInterruptedPluginTree, restorePluginTree, returnInterruptedPluginTree } from '../src/plugin-tree-snapshot.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-tree-')))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'nested'), { mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'local content', { mode: 0o600 })
  writeFileSync(join(root, 'nested', 'file'), Buffer.from([0, 255, 1]), { mode: 0o600 })
  return root
}

it('captures exact local content and modes in a deterministic private snapshot', () => {
  const root = fixture(); const uid = process.getuid!()
  const first = capturePluginTree(root, uid); const second = capturePluginTree(root, uid)
  expect(first.digest).toBe(second.digest)
  const snapshot = JSON.parse(first.bytes.toString())
  expect(snapshot.entries).toContainEqual({ path: 'client.js', mode: 0o600, kind: 'file', content: Buffer.from('local content').toString('base64') })
  expect(snapshot.entries).toContainEqual({ path: 'nested/file', mode: 0o600, kind: 'file', content: Buffer.from([0, 255, 1]).toString('base64') })
  writeFileSync(join(root, 'client.js'), 'changed')
  expect(capturePluginTree(root, uid).digest).not.toBe(first.digest)
})

it('refuses links and writable files without changing their targets', () => {
  const root = fixture(); const uid = process.getuid!(); const target = join(root, 'client.js')
  symlinkSync(target, join(root, 'link'))
  expect(() => capturePluginTree(root, uid)).toThrow()
  rmSync(join(root, 'link')); linkSync(target, join(root, 'hardlink'))
  expect(() => capturePluginTree(root, uid)).toThrow('unsafe_plugin_tree')
  rmSync(join(root, 'hardlink')); chmodSync(target, 0o666)
  expect(() => capturePluginTree(root, uid)).toThrow('unsafe_plugin_tree')
  expect(readFileSync(target, 'utf8')).toBe('local content')
})

it('restores modified plugin content while retaining the replaced tree', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const parent = join(base, 'node_modules'); const root = join(parent, 'ds-bot')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'original user change', { mode: 0o600 })
  mkdirSync(join(root, 'nested'), { mode: 0o700 })
  writeFileSync(join(root, 'nested', 'item'), 'nested data', { mode: 0o600 })
  const uid = process.getuid!(); const saved = capturePluginTree(root, uid)
  writeFileSync(join(root, 'client.js'), 'archive version', { mode: 0o600 })
  const current = capturePluginTree(root, uid); const id = randomUUID()
  restorePluginTree(root, id, saved.bytes, saved.digest, current.digest, uid, () => {})
  expect(readFileSync(join(root, 'client.js'), 'utf8')).toBe('original user change')
  expect(readFileSync(join(root, 'nested', 'item'), 'utf8')).toBe('nested data')
  expect(capturePluginTree(root, uid).digest).toBe(saved.digest)
  const previous = readdirSync(parent).find(name => name.startsWith(`.plugin-tree-replaced-${id}-`))!
  expect(readFileSync(join(parent, previous, 'tree', 'client.js'), 'utf8')).toBe('archive version')
})

it('refuses a changed current tree and a tampered backup', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'node_modules', 'ds-bot'); mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'old', { mode: 0o600 })
  const uid = process.getuid!(); const saved = capturePluginTree(root, uid)
  writeFileSync(join(root, 'client.js'), 'concurrent change')
  expect(() => restorePluginTree(root, randomUUID(), saved.bytes, saved.digest, saved.digest, uid, () => {})).toThrow('plugin_state_changed')
  expect(() => restorePluginTree(root, randomUUID(), Buffer.from('bad'), saved.digest, saved.digest, uid, () => {})).toThrow('invalid_backup')
  expect(readFileSync(join(root, 'client.js'), 'utf8')).toBe('concurrent change')
})

it('puts the replaced tree back if authorization is revoked during publication', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'node_modules', 'ds-bot'); mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'saved', { mode: 0o600 })
  const uid = process.getuid!(); const saved = capturePluginTree(root, uid)
  writeFileSync(join(root, 'client.js'), 'current')
  const current = capturePluginTree(root, uid)
  expect(() => restorePluginTree(root, randomUUID(), saved.bytes, saved.digest, current.digest, uid, () => {
    if (!existsSync(root)) throw Error('authorization revoked')
  })).toThrow('authorization revoked')
  expect(readFileSync(join(root, 'client.js'), 'utf8')).toBe('current')
})

it('returns a verified retained tree after an interrupted directory swap', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const parent = join(base, 'node_modules'); const root = join(parent, 'ds-bot'); mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'archive', { mode: 0o600 })
  const uid = process.getuid!(); const digest = capturePluginTree(root, uid).digest; const id = randomUUID()
  const retainedDir = join(parent, `.plugin-tree-replaced-${id}-${randomUUID()}`); mkdirSync(retainedDir, { mode: 0o700 })
  renameSync(root, join(retainedDir, 'tree'))
  expect(findInterruptedPluginTree(root, id, uid)).toBe(join(retainedDir, 'tree'))
  expect(() => returnInterruptedPluginTree(root, id, '0'.repeat(64), uid, () => {})).toThrow('plugin_state_changed')
  returnInterruptedPluginTree(root, id, digest, uid, () => {})
  expect(readFileSync(join(root, 'client.js'), 'utf8')).toBe('archive')
  expect(() => findInterruptedPluginTree(root, id, uid)).toThrow('plugin_state_changed')
})

it('refuses missing, ambiguous or unsafe retained trees', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const parent = join(base, 'node_modules'); mkdirSync(parent, { mode: 0o700 })
  const root = join(parent, 'ds-bot'); const id = randomUUID(); const uid = process.getuid!()
  expect(() => findInterruptedPluginTree(root, 'bad', uid)).toThrow('invalid_backup')
  expect(() => findInterruptedPluginTree(root, id, uid + 1)).toThrow('unsafe_plugin_tree')
  expect(() => findInterruptedPluginTree(root, id, uid)).toThrow('invalid_backup')
  const first = join(parent, `.plugin-tree-replaced-${id}-${randomUUID()}`); mkdirSync(first, { mode: 0o700 })
  chmodSync(first, 0o755)
  expect(() => findInterruptedPluginTree(root, id, uid)).toThrow('unsafe_plugin_tree')
  chmodSync(first, 0o700)
  mkdirSync(join(parent, `.plugin-tree-replaced-${id}-${randomUUID()}`), { mode: 0o700 })
  expect(() => findInterruptedPluginTree(root, id, uid)).toThrow('invalid_backup')
})

it('rejects replacing retained evidence after validation', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const parent = join(base, 'node_modules'); mkdirSync(parent, { mode: 0o700 })
  const root = join(parent, 'ds-bot'); const id = randomUUID(); const uid = process.getuid!()
  const first = join(parent, `.plugin-tree-replaced-${id}-${randomUUID()}`); const second = join(parent, `.plugin-tree-replaced-${id}-${randomUUID()}`)
  mkdirSync(join(first, 'tree'), { recursive: true, mode: 0o700 })
  writeFileSync(join(first, 'tree/client.js'), 'archive', { mode: 0o600 })
  const digest = capturePluginTree(join(first, 'tree'), uid).digest
  expect(() => returnInterruptedPluginTree(root, id, digest, uid, () => renameSync(first, second))).toThrow('plugin_state_changed')
  expect(readFileSync(join(second, 'tree/client.js'), 'utf8')).toBe('archive')
})

it.each([
  null,
  [],
  { version: 2, rootMode: 0o700, entries: [] },
  { version: 1, rootMode: 0o700, entries: [null] },
  { version: 1, rootMode: 0o700, entries: [{ path: '../escape', mode: 0o600, kind: 'file', content: '' }] },
  { version: 1, rootMode: 0o700, entries: [{ path: 'x', mode: 0o666, kind: 'file', content: '' }] },
  { version: 1, rootMode: 0o700, entries: [{ path: 'x', mode: 0o600, kind: 'file', content: 'invalid!' }] },
  { version: 1, rootMode: 0o700, entries: [{ path: 'missing/child', mode: 0o600, kind: 'file', content: '' }] },
  { version: 1, rootMode: 0o700, entries: [{ path: 'x', mode: 0o600, kind: 'unknown' }] },
  { version: 1, rootMode: 0o700, entries: [{ path: 'x', mode: 0o700, kind: 'directory', extra: 1 }] },
])('refuses a malformed snapshot even when its digest matches', (data) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'node_modules', 'ds-bot'); mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'client.js'), 'current', { mode: 0o600 })
  const uid = process.getuid!(); const current = capturePluginTree(root, uid)
  const bytes = Buffer.from(JSON.stringify(data)); const digest = createHash('sha256').update(bytes).digest('hex')
  expect(() => restorePluginTree(root, randomUUID(), bytes, digest, current.digest, uid, () => {})).toThrow('invalid_backup')
  expect(readFileSync(join(root, 'client.js'), 'utf8')).toBe('current')
})

it('refuses unsafe roots, owners, filenames, depths and oversized files', () => {
  const root = fixture(); const uid = process.getuid!()
  expect(() => capturePluginTree('relative', uid)).toThrow('unsafe_plugin_tree')
  expect(() => capturePluginTree(root, uid + 1)).toThrow('unsafe_plugin_tree')
  const unsafe = join(root, 'bad\nname'); writeFileSync(unsafe, '')
  expect(() => capturePluginTree(root, uid)).toThrow('unsafe_plugin_tree')
  rmSync(unsafe)
  let deep = root
  for (let index = 0; index < 65; index++) { deep = join(deep, 'd'); mkdirSync(deep) }
  expect(() => capturePluginTree(root, uid)).toThrow('unsafe_plugin_tree')
  rmSync(join(root, 'd'), { recursive: true })
  writeFileSync(join(root, 'large'), Buffer.alloc(16 * 1024 * 1024 + 1))
  expect(() => capturePluginTree(root, uid)).toThrow('unsafe_plugin_tree')
})

it('bounds serialized snapshot size even when file data is within the limit', () => {
  const root = fixture(); let deep = root
  for (let index = 0; index < 4; index++) { deep = join(deep, 'x'.repeat(220)); mkdirSync(deep) }
  for (let index = 0; index < 3100; index++) writeFileSync(join(deep, `file-${index}`), '')
  writeFileSync(join(root, 'large'), Buffer.alloc(16 * 1024 * 1024 - 16))
  expect(() => capturePluginTree(root, process.getuid!())).toThrow('unsafe_plugin_tree')
})

it('rejects invalid restore destinations and ownership before changing files', () => {
  const root = fixture(); const uid = process.getuid!(); const saved = capturePluginTree(root, uid)
  expect(() => restorePluginTree(root, 'invalid', saved.bytes, saved.digest, saved.digest, uid, () => {})).toThrow('invalid_backup')
  expect(() => restorePluginTree(root, randomUUID(), saved.bytes, saved.digest, saved.digest, uid, () => {})).toThrow('unsafe_plugin_tree')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-restore-')))
  onTestFinished(() => rmSync(base, { recursive: true, force: true }))
  const target = join(base, 'node_modules', 'ds-bot'); mkdirSync(target, { recursive: true, mode: 0o700 })
  expect(() => restorePluginTree(target, randomUUID(), saved.bytes, saved.digest, saved.digest, uid + 1, () => {})).toThrow('unsafe_plugin_tree')
})
