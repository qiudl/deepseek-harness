import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { linkBundledPluginPeerPackages } from '../src/windows-startup.ts'

vi.mock('node:fs', async load => ({ ...await load<typeof import('node:fs')>() }))

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

/** A fake embedding runtime whose node_modules holds a subset of the DSH platform packages. */
function runtime(packages: string[]): string {
  const root = join(temp('peer-runtime-'), 'app')
  const nodeModules = join(root, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  for (const name of packages) mkdirSync(join(nodeModules, '@deepseek-ai', name), { recursive: true })
  return join(nodeModules, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

it('links only directories that do not already have a destination', () => {
  const root = temp('peer-stat-')
  const file = join(root, 'file')
  writeFileSync(file, 'fixture')
  const directoryStat = lstatSync(root)
  const fileStat = lstatSync(file)
  const stat = vi.spyOn(fs, 'lstatSync').mockReturnValueOnce(fileStat).mockReturnValue(directoryStat)
  const exists = vi.spyOn(fs, 'existsSync').mockReturnValueOnce(true).mockReturnValue(false)
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined)
  const link = vi.spyOn(fs, 'symlinkSync').mockReturnValue(undefined)
  onTestFinished(() => { vi.restoreAllMocks() })
  linkBundledPluginPeerPackages(String.raw`C:\profile`, String.raw`C:\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js`)
  expect(stat).toHaveBeenCalledTimes(3)
  expect(exists).toHaveBeenCalledTimes(2)
  expect(mkdir).toHaveBeenCalledOnce()
  expect(link).toHaveBeenCalledOnce()
  expect(link).toHaveBeenCalledWith(String.raw`C:\runtime\node_modules\@deepseek-ai\dsh-web`,
    String.raw`C:\profile\node_modules\@deepseek-ai\dsh-web`, 'junction')
})

it.skipIf(process.platform !== 'win32')('links the DSH platform packages a bundled plugin needs into the Profile node_modules', () => {
  const entrypoint = runtime(['dsh-llm', 'dsh-tools', 'dsh-web'])
  const webRoot = join(temp('peer-profile-'), 'profiles', 'web')
  mkdirSync(webRoot, { recursive: true })
  linkBundledPluginPeerPackages(webRoot, entrypoint)
  for (const name of ['dsh-llm', 'dsh-tools', 'dsh-web'] as const) {
    const link = join(webRoot, 'node_modules', '@deepseek-ai', name)
    expect(existsSync(link), name).toBe(true)
    expect(lstatSync(link).isSymbolicLink() || lstatSync(link).isDirectory(), name).toBe(true)
  }
})

it.skipIf(process.platform !== 'win32')('skips platform packages the runtime does not ship and never throws on a second pass', () => {
  const entrypoint = runtime(['dsh-llm'])
  const webRoot = join(temp('peer-profile-'), 'profiles', 'web')
  mkdirSync(webRoot, { recursive: true })
  expect(() => { linkBundledPluginPeerPackages(webRoot, entrypoint) }).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))).toBe(true)
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-tools'))).toBe(false)
  expect(() => { linkBundledPluginPeerPackages(webRoot, entrypoint) }).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))).toBe(true)
})

it.skipIf(process.platform !== 'win32')('does not link a runtime package that is a file', () => {
  const entrypoint = runtime([])
  const source = win32.join(win32.dirname(win32.dirname(win32.dirname(win32.dirname(entrypoint)))), '@deepseek-ai', 'dsh-llm')
  mkdirSync(win32.dirname(source), { recursive: true })
  writeFileSync(source, 'not a directory')
  const webRoot = temp('peer-profile-')
  linkBundledPluginPeerPackages(webRoot, entrypoint)
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))).toBe(false)
})

it('treats an unreachable runtime node_modules as a no-op instead of failing the install', () => {
  const webRoot = join(temp('peer-profile-'), 'profiles', 'web')
  mkdirSync(webRoot, { recursive: true })
  const missing = win32.join(temp('peer-missing-'), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  expect(() => { linkBundledPluginPeerPackages(webRoot, missing) }).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules'))).toBe(false)
})
