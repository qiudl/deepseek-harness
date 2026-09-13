import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadPinnedWindowsVaultNativeModule } from '../src/windows-pinned-vault-native.ts'

describe('release-pinned Windows vault native module', () => {
  it('rejects malformed pins, missing files and directories before native loading', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      const sha256 = createHash('sha256').update('native-fixture').digest('hex')
      const load = vi.fn()
      for (const pin of [
        { path: 'koffi.node', sha256 },
        { path: join(root, 'index.js'), sha256 },
        { path, sha256: sha256.toUpperCase() },
        { path, sha256: sha256.slice(1) },
        { path, sha256: 'g'.repeat(64) },
        { path, sha256 },
      ]) {
        expect(() => loadPinnedWindowsVaultNativeModule(pin, load)).toThrow()
      }
      mkdirSync(path)
      expect(() => loadPinnedWindowsVaultNativeModule({ path, sha256 }, load))
        .toThrow('canonical singly linked file')
      expect(load).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads exactly the pinned native file once without package resolution', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      const bytes = Buffer.from('native-fixture')
      writeFileSync(path, bytes)
      const native = {
        pointer: vi.fn(), struct: vi.fn(), alloc: vi.fn(), encode: vi.fn(), decode: vi.fn(),
        address: vi.fn(), load: vi.fn(),
      }
      const load = vi.fn(() => native)
      expect(loadPinnedWindowsVaultNativeModule({
        path, sha256: createHash('sha256').update(bytes).digest('hex'),
      }, load)).toBe(native)
      expect(load).toHaveBeenCalledExactlyOnceWith(path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects missing authority, digest drift and links before native execution', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      writeFileSync(path, 'native-fixture')
      const load = vi.fn()
      expect(() => loadPinnedWindowsVaultNativeModule(undefined, load)).toThrow()
      expect(() => loadPinnedWindowsVaultNativeModule({ path, sha256: '0'.repeat(64) }, load)).toThrow()
      const linked = join(root, 'linked', 'koffi.node')
      symlinkSync(root, join(root, 'linked'), 'junction')
      expect(() => loadPinnedWindowsVaultNativeModule({
        path: linked, sha256: createHash('sha256').update('native-fixture').digest('hex'),
      }, load)).toThrow()
      expect(load).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not try another candidate after native loading fails', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      writeFileSync(path, 'native-fixture')
      const load = vi.fn(() => { throw new Error('native loader failure') })
      expect(() => loadPinnedWindowsVaultNativeModule({
        path, sha256: createHash('sha256').update('native-fixture').digest('hex'),
      }, load)).toThrow('native loader failure')
      expect(load).toHaveBeenCalledExactlyOnceWith(path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects empty, oversized and multiply linked files before executing them', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      writeFileSync(path, '')
      const load = vi.fn()
      for (const size of [0, 64 * 1024 * 1024 + 1]) {
        truncateSync(path, size)
        expect(() => loadPinnedWindowsVaultNativeModule({ path, sha256: '0'.repeat(64) }, load)).toThrow()
      }
      writeFileSync(path, 'native-fixture')
      linkSync(path, join(root, 'alias.node'))
      expect(() => loadPinnedWindowsVaultNativeModule({
        path, sha256: createHash('sha256').update('native-fixture').digest('hex'),
      }, load)).toThrow()
      expect(load).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a pinned addon that does not provide the required native functions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      writeFileSync(path, 'native-fixture')
      const native = {
        pointer: vi.fn(), struct: vi.fn(), alloc: vi.fn(), encode: vi.fn(), decode: vi.fn(),
        address: vi.fn(), load: vi.fn(),
      }
      const incomplete = Object.keys(native).map(key => ({ ...native, [key]: undefined }))
      for (const value of [null, {}, { pointer: true }, ...incomplete]) {
        const load = vi.fn(() => value)
        expect(() => loadPinnedWindowsVaultNativeModule({
          path, sha256: createHash('sha256').update('native-fixture').digest('hex'),
        }, load)).toThrow('native module functions are unavailable')
        expect(load).toHaveBeenCalledExactlyOnceWith(path)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not reuse a previously accepted digest when the addon bytes change', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-pinned-native-')))
    try {
      const path = join(root, 'koffi.node')
      const bytes = Buffer.from('native-fixture')
      writeFileSync(path, bytes)
      const pin = { path, sha256: createHash('sha256').update(bytes).digest('hex') }
      const native = {
        pointer: vi.fn(), struct: vi.fn(), alloc: vi.fn(), encode: vi.fn(), decode: vi.fn(),
        address: vi.fn(), load: vi.fn(),
      }
      const load = vi.fn(() => native)
      expect(loadPinnedWindowsVaultNativeModule(pin, load)).toBe(native)
      writeFileSync(path, Buffer.alloc(bytes.length, 0x5a))
      expect(() => loadPinnedWindowsVaultNativeModule(pin, load)).toThrow('digest mismatch')
      expect(load).toHaveBeenCalledExactlyOnceWith(path)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
