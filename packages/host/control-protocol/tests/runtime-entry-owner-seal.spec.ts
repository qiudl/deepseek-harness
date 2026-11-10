/** Owner-seal metadata is closed and bounded independently from historical runtime-entry signature encoders. */
import { expect, it } from 'vitest'
import { parseHostRuntimeEntryOwnerManifest } from '../src/runtime-entry-owner-seal.ts'
import { parseHostRuntimeEntryOriginsConfiguration } from '../src/runtime-entry-bootstrap.ts'
const digest = 'a'.repeat(64)
function fixture() {
  return { schemaVersion: 3, implementationDigest: digest, compositionDigest: digest,
    runtime: { sourceSha: '1'.repeat(40), archiveSha256: digest },
    plugin: { packageName: 'ds-bot', packageVersion: '0.2.24', sourceSha: '2'.repeat(40), archiveSha256: digest },
    owners: [{ ownerId: 'o0001', packageName: 'ds-bot', packageVersion: '0.2.24', manifestSha256: digest,
      selector: { kind: 'profile_plugin', packageName: 'ds-bot' }, treeSha256: digest, fileCount: 70, totalBytes: 5000 },
    { ownerId: 'o0002', packageName: 'ws', packageVersion: '8.18.3', manifestSha256: digest,
      selector: { kind: 'profile_dependency', fromOwnerId: 'o0001', fromPath: 'index.js', specifier: 'ws', mode: 'import' },
      treeSha256: digest, fileCount: 1, totalBytes: 1 }],
    edges: [{ fromOwnerId: 'o0001', fromPath: 'index.js', specifier: 'ws', mode: 'import',
      conditions: ['node', 'import', 'module-sync', 'node-addons'], toOwnerId: 'o0002', toPath: 'wrapper.mjs' }],
    nativeBindings: [] }
}
it('keeps one immutable physical owner identity per selection, including importer-specific conditions', () => {
  const value = fixture(), parsed = parseHostRuntimeEntryOwnerManifest(value)
  expect(parsed).toEqual(value)
  expect(Object.isFrozen(parsed.owners[1]?.selector)).toBe(true)
  expect(Object.isFrozen(parsed.edges[0]?.conditions)).toBe(true)
  value.owners[0]!.totalBytes = 99
  expect(parsed.owners[0]?.totalBytes).toBe(5000)
})
it.each([
  (v: ReturnType<typeof fixture>) => ({ ...v, unexpected: true }),
  (v: ReturnType<typeof fixture>) => ({ ...v, schemaVersion: 4 }),
  (v: ReturnType<typeof fixture>) => ({ ...v, plugin: { ...v.plugin, packageVersion: '1.0.0-..' } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, plugin: { ...v.plugin, packageVersion: '1.0.0-01' } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, runtime: { ...v.runtime, sourceSha: digest } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, plugin: { ...v.plugin, archiveSha256: 'g'.repeat(64) } }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: [...v.owners, v.owners[0]] }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: Array.from({ length: 257 }, () => v.owners[0]) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: [] }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: v.owners.map(o => ({ ...o, totalBytes: 512 * 1024 * 1024 })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: v.owners.map(o => ({ ...o, fileCount: 16384 })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: v.owners.map(o => ({ ...o, selector: { kind: 'runtime', relativeRoot: '../escape' } })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, owners: v.owners.map(o => ({ ...o, selector: { kind: 'profile_dependency',
    fromOwnerId: o.ownerId === 'o0001' ? 'o0002' : 'o0001', fromPath: 'index.js', specifier: 'ws', mode: 'import' } })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: [...v.edges, ...v.edges] }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: v.edges.map(e => ({ ...e, toPath: 'node_modules/ws/index.js' })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: v.edges.map(e => ({ ...e, fromPath: '.git/entry.js' })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: v.edges.map(e => ({ ...e, toOwnerId: 'o0099' })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: v.edges.map(e => ({ ...e, fromPath: 'lib/../index.js' })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, edges: v.edges.map(e => ({ ...e, mode: 'require' })) }),
  (v: ReturnType<typeof fixture>) => ({ ...v, nativeBindings: [{ ownerId: 'o0001', platform: 'linux', arch: 'arm64',
    backend: 'napi', abi: 'napi-v9', path: 'native.node', sha256: digest }] }),
])('rejects malformed or ambiguous expected inventory %#', (change) => {
  expect(() => parseHostRuntimeEntryOwnerManifest(change(fixture()))).toThrow()
})
it('accepts only the closed trusted resource reference at startup', () => {
  const c = { schemaVersion: 3, implementationDigest: digest, compositionDigest: digest,
    manifest: { path: '/fixed/native-origins/owners-v3.json', sha256: digest } }
  expect(parseHostRuntimeEntryOriginsConfiguration(c)).toEqual(c)
  for (const change of [{ ...c, artifactPins: [] }, { ...c, manifest: { ...c.manifest, path: '/elsewhere/file.json' } },
    { ...c, manifest: { ...c.manifest, path: '/fixed/../native-origins/owners-v3.json' } },
    { ...c, manifest: { ...c.manifest, extra: true } }]) expect(() => parseHostRuntimeEntryOriginsConfiguration(change)).toThrow()
})
