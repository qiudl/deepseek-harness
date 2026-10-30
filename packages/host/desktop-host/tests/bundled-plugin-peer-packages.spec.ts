import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { linkBundledPluginPeerPackages } from '../src/windows-startup.ts'

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

it('links the DSH platform packages a bundled plugin needs into the Profile node_modules', () => {
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

it('skips platform packages the runtime does not ship and never throws on a second pass', () => {
  const entrypoint = runtime(['dsh-llm'])
  const webRoot = join(temp('peer-profile-'), 'profiles', 'web')
  mkdirSync(webRoot, { recursive: true })
  expect(() => linkBundledPluginPeerPackages(webRoot, entrypoint)).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))).toBe(true)
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-tools'))).toBe(false)
  expect(() => linkBundledPluginPeerPackages(webRoot, entrypoint)).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'))).toBe(true)
})

it('treats an unreachable runtime node_modules as a no-op instead of failing the install', () => {
  const webRoot = join(temp('peer-profile-'), 'profiles', 'web')
  mkdirSync(webRoot, { recursive: true })
  const missing = win32.join(temp('peer-missing-'), 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  expect(() => linkBundledPluginPeerPackages(webRoot, missing)).not.toThrow()
  expect(existsSync(join(webRoot, 'node_modules'))).toBe(false)
})
