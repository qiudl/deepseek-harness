/** Real temporary package directories validate whole trees and importer-specific selection; no Native receipt is minted. */
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { createRuntimeResolutionLookup, type RuntimeResolution } from '@deepseek-ai/dsh-app-boot'
import { readRuntimeOwnerTree } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostRuntimeEntryOwnerManifest } from '@deepseek-ai/dsh-host-control-protocol'
import { readHostRuntimeEntryOwnerManifest, verifyHostRuntimeEntryOwners } from '@deepseek-ai/dsh-host-control-protocol'
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sealed-owners-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const runtime = join(root, 'runtime'), profile = join(root, 'person/profiles/web')
  const file = (path: string, bytes: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
  const pkg = (path: string, name: string) => {
    file(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { import: './index.js', require: './index.cjs' } }))
    file(join(path, 'index.js'), 'throw Error("must not execute")'); file(join(path, 'index.cjs'), 'throw Error("must not execute")')
    return path
  }
  const cli = pkg(join(runtime, 'app/node_modules/cli'), '@deepseek-ai/dsh')
  const global = pkg(join(runtime, 'app/node_modules/ws'), 'ws'), ds = pkg(join(profile, 'node_modules/ds-bot'), 'ds-bot')
  const nested = pkg(join(ds, 'node_modules/ws'), 'ws')
  for (const name of ['project-operation-native-entry.js', 'project-operation-journal.js']) file(join(ds, 'src/host', name), '// fixed source')
  const resolution: RuntimeResolution = { profilesDir: dirname(profile), profileDir: profile, localPackageNames: ['ds-bot'], linkedRoots: [],
    entries: [{ name: 'ws', version: '1.0.0', packageDir: global, declarer: join(runtime, 'app/package.json'), scope: 'installation' }] }
  file(join(runtime, 'app/package.json'), '{"dependencies":{"ws":"1.0.0"}}')
  const lookup = createRuntimeResolutionLookup(resolution), budget = { entries: 0, files: 0, bytes: 0 }
  const owner = (ownerId: string, path: string, packageName: string, selector: object) => ({ ownerId, packageName, packageVersion: '1.0.0',
    manifestSha256: hash(readFileSync(join(path, 'package.json'))), selector, ...readRuntimeOwnerTree(path, budget) })
  const manifest = parseHostRuntimeEntryOwnerManifest({ schemaVersion: 3, implementationDigest: 'a'.repeat(64), compositionDigest: 'b'.repeat(64),
    runtime: { sourceSha: '1'.repeat(40), archiveSha256: 'c'.repeat(64) },
    plugin: { packageName: 'ds-bot', packageVersion: '1.0.0', sourceSha: '2'.repeat(40), archiveSha256: 'd'.repeat(64) },
    owners: [owner('o0001', cli, '@deepseek-ai/dsh', { kind: 'runtime', relativeRoot: 'app/node_modules/cli' }),
      owner('o0002', global, 'ws', { kind: 'runtime', relativeRoot: 'app/node_modules/ws' }),
      owner('o0003', ds, 'ds-bot', { kind: 'profile_plugin', packageName: 'ds-bot' }),
      owner('o0004', nested, 'ws', { kind: 'profile_dependency', fromOwnerId: 'o0003', fromPath: 'index.js', specifier: 'ws', mode: 'import' })],
    edges: [{ fromOwnerId: 'o0003', fromPath: 'index.js', specifier: 'ws', mode: 'import',
      conditions: lookup.resolve(pathToFileURL(join(ds, 'index.js')).href, 'ws', 'import').conditions,
      toOwnerId: 'o0004', toPath: 'index.js' }], nativeBindings: [] })
  const verify = () => verifyHostRuntimeEntryOwners(manifest, runtime, profile, lookup)
  return { root, runtime, profile, ds, nested, global, manifest, lookup, verify, file }
}
it('checks both same-name physical owners and returns only the already-checked original DS reader leaves', () => {
  const f = fixture(), pins = f.verify()
  expect(pins.map(p => p.path)).toEqual(['project-operation-native-entry.js', 'project-operation-journal.js'].map(n => join(f.ds, 'src/host', n)))
  expect(pins.every(p => p.sha256 === hash('// fixed source'))).toBe(true)
})
it.each(['extra', 'missing', 'wrong-bytes'])('rejects %s distribution data while leaving it unchanged', (change) => {
  const f = fixture(), file = join(f.nested, 'index.js')
  if (change === 'extra') writeFileSync(join(f.nested, 'extra.data'), 'extra')
  else if (change === 'missing') rmSync(file)
  else writeFileSync(file, 'replacement')
  const read = () => readRuntimeOwnerTree(f.nested, { entries: 0, files: 0, bytes: 0 })
  const before = read()
  expect(f.verify).toThrow(); expect(read()).toEqual(before)
})
it('rejects an edge redirected to the other same-name version even if each owner tree matches', () => {
  const f = fixture(), value = structuredClone(f.manifest)
  const e = value.edges[0]; if (!e) throw Error('fixture missing edge')
  const wrong = { ...value, edges: [{ ...e, toOwnerId: 'o0002' }] }
  expect(() => verifyHostRuntimeEntryOwners(parseHostRuntimeEntryOwnerManifest(wrong), f.runtime, f.profile, f.lookup)).toThrow()
})
it('reads only the exact raw-hash resource and rejects bad encoding or unknown fields without rewriting it', () => {
  const f = fixture(), path = join(f.runtime, 'native-origins/owners-v3.json')
  const read = (bytes: Buffer) => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
    const c = { schemaVersion: 3 as const, implementationDigest: f.manifest.implementationDigest,
      compositionDigest: f.manifest.compositionDigest, manifest: { path, sha256: hash(bytes) } }
    return { c, bytes }
  }
  const valid = read(Buffer.from(JSON.stringify(f.manifest)))
  expect(readHostRuntimeEntryOwnerManifest(valid.c)).toEqual(f.manifest)
  expect(() => readHostRuntimeEntryOwnerManifest({ ...valid.c, manifest: { path, sha256: '0'.repeat(64) } })).toThrow()
  for (const bytes of [Buffer.from('{"schemaVersion":4}'), Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ ...f.manifest, extra: true }))]) {
    const bad = read(bytes)
    expect(() => readHostRuntimeEntryOwnerManifest(bad.c)).toThrow()
    expect(readFileSync(path)).toEqual(bytes)
  }
})
