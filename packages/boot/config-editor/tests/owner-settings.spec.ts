import { withOwnerSettingsFileFixture } from './owner-settings-file-fixture.ts'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import * as fs from 'node:fs'
import { vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import {
  mergeOwnerSettings, ownerSettingsOverride, ownerSettingsSection, ownerSettingsValues,
  readOwnerSettings, replaceOwnerSettingsSection, updateOwnerSettingsValues,
} from '../src/owner-settings.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-settings-'))
  const path = join(dir, 'settings.yaml')
  writeFileSync(path, 'first:\n  count: 4\n', { mode: 0o600 })
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return { dir, path }
}

// Windows has no POSIX UID/mode checks; this owner-file mode is used by the macOS embedding.
const nativeIt = it.skipIf(process.platform === 'win32')

it('validates owner metadata and document formats independently of host permission semantics', () => {
  const { dir, path } = fixture()
  const getter = Object.getOwnPropertyDescriptor(process, 'getuid')
  const read = (metadata?: { uid?: number; mode?: number }) =>
    withOwnerSettingsFileFixture(path, () => readOwnerSettings(path), metadata)
  expect(read().sections).toEqual({ first: { count: 4 } })
  expect(() => read({ uid: 1 })).toThrow('Unsafe')
  expect(() => read({ mode: 0o100644 })).toThrow('Unsafe')
  expect(() => read({ mode: 0o040600 })).toThrow('Unsafe')
  const alias = join(dir, 'shared')
  linkSync(path, alias)
  expect(() => read()).toThrow('Unsafe')
  rmSync(alias)
  truncateSync(path, 16 * 1024 * 1024 + 1)
  expect(() => read()).toThrow('Unsafe')
  for (const text of ['first: [', 'first: {}\nfirst: {}', '[]', 'first: 4']) {
    writeFileSync(path, text)
    expect(() => read()).toThrow()
  }
  writeFileSync(path, '')
  expect(read().sections).toEqual({})
  expect(Object.getOwnPropertyDescriptor(process, 'getuid')).toEqual(getter)
})

it('closes and restores fixture authority when the document changes during reading', async () => {
  const { path } = fixture()
  const getter = Object.getOwnPropertyDescriptor(process, 'getuid')
  const { readFileSync: read } = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.readFileSync).mockImplementationOnce((...args: Parameters<typeof read>) => {
    const text = Reflect.apply(read, fs, args)
    writeFileSync(path, 'first:\n  count: 123456\n')
    return text
  })
  expect(() => withOwnerSettingsFileFixture(path, () => readOwnerSettings(path))).toThrow('changed during reading')
  expect(Object.getOwnPropertyDescriptor(process, 'getuid')).toEqual(getter)
  expect(withOwnerSettingsFileFixture(path, () => readOwnerSettings(path)).sections).toEqual({ first: { count: 123456 } })
})

it('limits fixture metadata to one file and closes a leaked descriptor before reporting it', () => {
  const { dir, path } = fixture()
  const getter = Object.getOwnPropertyDescriptor(process, 'getuid')
  const unrelated = join(dir, 'unrelated')
  writeFileSync(unrelated, 'first: {}\n', { mode: 0o644 })
  expect(() => withOwnerSettingsFileFixture(path, () => readOwnerSettings(unrelated))).toThrow('Unsafe')
  let leaked = -1
  expect(() => { withOwnerSettingsFileFixture(path, () => { leaked = fs.openSync(path, 'r') }) })
    .toThrow('left a file descriptor open')
  expect(() => fs.fstatSync(leaked)).toThrow()
  expect(Object.getOwnPropertyDescriptor(process, 'getuid')).toEqual(getter)
  expect(withOwnerSettingsFileFixture(path, () => readOwnerSettings(path)).sections).toEqual({ first: { count: 4 } })
})

nativeIt('rejects a settings file modified between the descriptor reads', async () => {
  const { path } = fixture()
  const { readFileSync: read } = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.readFileSync).mockImplementationOnce((...args: Parameters<typeof read>) => {
    const text = Reflect.apply(read, fs, args)
    writeFileSync(path, 'first:\n  count: 123456\n')
    return text
  })
  expect(() => readOwnerSettings(path)).toThrow('changed during reading')
})

nativeIt('refuses links, shared files, oversized files, and unreadable or malformed documents', () => {
  const { dir, path } = fixture()
  expect(readOwnerSettings(path).sections).toEqual({ first: { count: 4 } })
  const alias = join(dir, 'alias')
  symlinkSync(path, alias)
  expect(() => readOwnerSettings(alias)).toThrow()
  rmSync(alias)
  linkSync(path, alias)
  expect(() => readOwnerSettings(path)).toThrow('Unsafe')
  rmSync(alias)
  chmodSync(path, 0o644)
  expect(() => readOwnerSettings(path)).toThrow('Unsafe')
  chmodSync(path, 0o600)
  truncateSync(path, 16 * 1024 * 1024 + 1)
  expect(() => readOwnerSettings(path)).toThrow('Unsafe')
  for (const text of ['first: [', 'first: {}\nfirst: {}', '[]', 'first: 4']) {
    writeFileSync(path, text)
    expect(() => readOwnerSettings(path)).toThrow()
  }
  writeFileSync(path, '')
  expect(readOwnerSettings(path).sections).toEqual({})
  const directory = join(dir, 'directory')
  mkdirSync(directory, { mode: 0o700 })
  expect(() => readOwnerSettings(directory)).toThrow('Unsafe')
  expect(() => readOwnerSettings(join(dir, 'missing'))).toThrow()
})

it('maps renamed settings and preserves unavailable sections without writing inherited defaults', () => {
  const sections = { 'ui-onboarding': { first: true, nested: { old: 1 } }, 'ui-settings-general': { first: false }, untouched: { keep: true } }
  expect(ownerSettingsSection(sections, 'ui-settings-general')).toEqual({ first: false, nested: { old: 1 } })
  expect(ownerSettingsSection(sections, 'absent')).toEqual({})
  expect(replaceOwnerSettingsSection(sections, 'ui-settings-general', { first: true }))
    .toEqual({ 'ui-settings-general': { first: true }, untouched: { keep: true } })
  expect(ownerSettingsOverride({ inherited: 1, nested: { unchanged: 1, edited: 2 } },
    { inherited: 1, nested: { unchanged: 1, edited: 3 }, added: ['value'] }))
    .toEqual({ nested: { edited: 3 }, added: ['value'] })
  expect(mergeOwnerSettings({ rows: ['base'], nested: { first: 1 } }, { rows: [], nested: { second: 2 } }))
    .toEqual({ rows: [], nested: { first: 1, second: 2 } })
  const plain = { retained: 1 }
  Object.setPrototypeOf(plain, null)
  expect(mergeOwnerSettings(plain, { added: 2 })).toEqual({ retained: 1, added: 2 })
  expect(mergeOwnerSettings(new Date(0), { added: 2 })).toEqual({ added: 2 })
})

it('projects live schema fields and retains unavailable values without applying storage redirects', () => {
  const schema = z.object({ path: z.string(), nested: z.object({ retained: z.string(), count: z.number().volatile() }),
    rows: z.array(z.object({ name: z.string() })).volatile(),
  })
  const stored = { path: '/redirect', nested: { retained: 'keep', count: 5, unavailable: true }, rows: [{ name: 'preset' }], extra: 'keep' }
  expect(ownerSettingsValues(schema, stored)).toEqual({ nested: { count: 5 }, rows: [{ name: 'preset' }] })
  expect(updateOwnerSettingsValues(schema, stored, { nested: { count: 6 }, rows: [] }))
    .toEqual({ path: '/redirect', nested: { retained: 'keep', count: 6, unavailable: true }, rows: [], extra: 'keep' })
  expect(updateOwnerSettingsValues(schema, stored, {}))
    .toEqual({ path: '/redirect', nested: { retained: 'keep', unavailable: true }, extra: 'keep' })
  expect(ownerSettingsValues(undefined, stored)).toEqual({})
  expect(ownerSettingsValues(z.object({ path: z.string() }), stored)).toEqual({})
  expect(ownerSettingsValues(z.object({ nested: z.object({ count: z.number().volatile() }) }), {})).toEqual({ nested: {} })
  expect(ownerSettingsValues(z.object({}).volatile(), { live: true })).toEqual({ live: true })
})
