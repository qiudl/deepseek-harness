/** Read-only installed package lookup uses the existing router without changing Node or worker state. */
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getEnvironmentData } from 'node:worker_threads'
import { expect, it, onTestFinished } from 'vitest'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { createRuntimeResolutionLookup, installRuntimeInterception } from '../src/profile-resolution/resolver.ts'
import type { RuntimeResolution } from '../src/profile.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-readonly-resolution-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const file = (name: string, body: string) => { mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, body) }
  const pkg = (dir: string, name: string, marker: string, peer = false) => {
    file(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
      exports: { import: './import.js', require: './require.cjs' },
      ...(peer ? { peerDependencies: { conditional: '*' } } : {}) }))
    file(join(dir, 'import.js'), `throw Error('${marker} must never execute')`)
    file(join(dir, 'require.cjs'), `throw Error('${marker} must never execute')`)
    return dir
  }
  const profile = join(root, 'profiles', 'web'), plugin = pkg(join(profile, 'node_modules', 'ds-bot'), 'ds-bot', 'plugin', true)
  const global = pkg(join(root, 'installation', 'node_modules', 'conditional'), 'conditional', 'global')
  const nested = pkg(join(plugin, 'node_modules', 'conditional'), 'conditional', 'nested')
  file(join(profile, 'package.json'), '{}')
  const resolution: RuntimeResolution = { profilesDir: dirname(profile), profileDir: profile,
    linkedRoots: [], localPackageNames: ['ds-bot'], entries: [{ name: 'conditional', version: '1.0.0',
      packageDir: global, declarer: join(root, 'installation', 'package.json'), scope: 'installation' }] }
  file(join(root, 'installation', 'package.json'), '{"dependencies":{"conditional":"1.0.0"}}')
  return { root, profile, plugin, global, nested, resolution, lookup: createRuntimeResolutionLookup(resolution) }
}
it('preserves physical nested copies and Node import versus require conditions', () => {
  const f = fixture(), parent = pathToFileURL(join(f.plugin, 'import.js')).href
  expect(f.lookup.packageDir('conditional', parent)).toBe(f.nested)
  expect(f.lookup.resolve(parent, 'conditional', 'import').url).toBe(pathToFileURL(join(f.nested, 'import.js')).href)
  expect(f.lookup.resolve(parent, 'conditional', 'require').url).toBe(pathToFileURL(join(f.nested, 'require.cjs')).href)
  expect(f.lookup.resolve(parent, 'conditional', 'import').conditions).toContain('import')
  expect(f.lookup.resolve(parent, 'conditional', 'require').conditions).toContain('require')
})
it('uses the installation fallback only when the actual importer has no nested package', () => {
  const f = fixture(), parent = pathToFileURL(join(f.plugin, 'import.js')).href
  rmSync(f.nested, { recursive: true })
  expect(f.lookup.packageDir('conditional', parent)).toBe(f.global)
  expect(f.lookup.resolve(parent, 'conditional', 'import').url).toBe(pathToFileURL(join(f.global, 'import.js')).href)
  expect(f.lookup.resolve(parent, 'conditional', 'require').url).toBe(pathToFileURL(join(f.global, 'require.cjs')).href)
})
it('does not install hooks, import code or publish worker resolution', () => {
  const loader = ModuleLoader.fromInternal(), method = loader?.resolveSync
  const require = createRequire(import.meta.url), module = require('node:module') as { _resolveFilename: unknown }
  const native = module._resolveFilename, key = '@deepseek-ai/dsh-app-boot/profile-resolution', before = getEnvironmentData(key)
  const f = fixture(), parent = pathToFileURL(join(f.plugin, 'import.js')).href
  f.lookup.resolve(parent, 'conditional', 'import'); f.lookup.resolve(parent, 'conditional', 'require')
  expect(loader?.resolveSync).toBe(method); expect(module._resolveFilename).toBe(native)
  expect(getEnvironmentData(key)).toBe(before)
  expect(() => require.resolve('conditional')).toThrow()
})
it('keeps ordinary native relative and built-in requests available without a scoped package', () => {
  const f = fixture(), parent = pathToFileURL(join(f.plugin, 'import.js')).href
  expect(f.lookup.resolve(parent, './require.cjs', 'import').url).toBe(pathToFileURL(join(f.plugin, 'require.cjs')).href)
  expect(f.lookup.resolve(parent, './require.cjs', 'require').url).toBe(pathToFileURL(join(f.plugin, 'require.cjs')).href)
  expect(f.lookup.resolve(parent, 'node:fs', 'import').url).toBe('node:fs')
  expect(f.lookup.packageDir('node:fs', parent)).toBeUndefined()
})

it('agrees with an already active worker interception without installing another one', () => {
  const f = fixture(), interception = installRuntimeInterception(f.resolution)
  onTestFinished(() => { interception.dispose() })
  const lookup = createRuntimeResolutionLookup(f.resolution), parent = pathToFileURL(join(f.plugin, 'import.js')).href
  const selected = createRequire(parent).resolve('conditional')
  expect(lookup.resolve(parent, 'conditional', 'require').url).toBe(pathToFileURL(selected).href)
  expect(lookup.resolve(parent, 'conditional', 'import').url).toBe(pathToFileURL(join(f.nested, 'import.js')).href)
})
