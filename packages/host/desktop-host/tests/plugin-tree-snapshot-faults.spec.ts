import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ mode: '', root: '', count: 0 }))
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>()
  return { ...fs,
    fstatSync: (fd: number) => {
      const stat = fs.fstatSync(fd)
      if (fault.mode === 'file' && ++fault.count === 2) stat.mtimeMs += 1
      return stat
    },
    lstatSync: (path: import('node:fs').PathLike) => {
      const stat = fs.lstatSync(path)
      if ((fault.mode === 'directory' || fault.mode === 'publish') && String(path) === fault.root) {
        fault.count++
        if (fault.count === (fault.mode === 'directory' ? 2 : 4)) stat.mtimeMs += 1
      }
      return stat
    },
    readdirSync: (path: import('node:fs').PathLike) => {
      if (fault.mode === 'many' && String(path) === fault.root) return Array.from({ length: 8193 }, () => 'entry')
      return fs.readdirSync(path)
    },
  }
})
const { capturePluginTree, findInterruptedPluginTree, restorePluginTree } = await import('../src/plugin-tree-snapshot.ts')
const roots: string[] = []
afterEach(() => { fault.mode = ''; fault.count = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plugin-tree-fault-'))); roots.push(root)
  const tree = join(root, 'node_modules', 'fixture'); mkdirSync(tree, { recursive: true, mode: 0o700 })
  writeFileSync(join(tree, 'client.js'), 'file', { mode: 0o600 })
  return tree
}

it.each(['file', 'directory'])('rejects a %s changed during capture', (mode) => {
  const tree = fixture(); fault.mode = mode; fault.root = tree; fault.count = 0
  expect(() => capturePluginTree(tree, process.getuid!())).toThrow('plugin_state_changed')
})

it('rejects a directory replaced after the final tree verification', () => {
  const tree = fixture(); const uid = process.getuid!(); const snapshot = capturePluginTree(tree, uid)
  fault.mode = 'publish'; fault.root = tree; fault.count = 0
  expect(() => { restorePluginTree(tree, randomUUID(), snapshot.bytes, snapshot.digest, snapshot.digest, uid, () => {}) })
    .toThrow('plugin_state_changed')
})

it('bounds the number of retained-tree candidates it scans', () => {
  const tree = fixture(); rmSync(tree, { recursive: true }); fault.mode = 'many'; fault.root = join(tree, '..'); fault.count = 0
  expect(() => findInterruptedPluginTree(tree, randomUUID(), process.getuid!())).toThrow('unsafe_plugin_tree')
})
