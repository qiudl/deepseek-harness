/** Independent read-only verification of installation-selected distribution owners. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseHostRuntimeEntryOwnerManifest, type HostRuntimeEntryOwnerManifest } from './runtime-entry-owner-seal.ts'
import type { HostRuntimeEntrySealedOriginsConfiguration } from './runtime-entry-bootstrap.ts'
import { readRuntimeOwnerTree } from './runtime-entry-owner-tree.ts'

/** Actual default Node lookup supplied by the installation/Profile resolver, without importing a target. */
export interface RuntimeEntryOwnerLookup {
  /** @param specifier - Original bare request. @param parentURL - Actual importer URL.
   * @returns Its physical owner directory, or undefined. */
  packageDir(specifier: string, parentURL: string): string | undefined
  /** @param parentURL - Original importer URL. @param specifier - Original module request.
   * @param mode - Actual Node operation.
   * @returns Its selected URL and actual default Node conditions. */
  resolve(parentURL: string, specifier: string, mode: 'import' | 'require'): Readonly<{ url: string; conditions: readonly string[] }>
}
const fail = (): never => { throw Error('runtime_entry_owner_unavailable') }
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
function within(root: string, path: string): string {
  const actual = realpathSync(path), name = relative(root, actual)
  if (!name || name === '..' || name.startsWith('..' + sep) || realpathSync(root) !== root) return fail()
  return actual
}
/** Read exactly the trusted installation resource; a plugin or worker cannot supply its path or expected hash.
 * @param configuration - Startup-owned file reference after signed resource verification.
 * @returns Strict raw-hash-matched expected owner metadata.
 */
export function readHostRuntimeEntryOwnerManifest(
  configuration: HostRuntimeEntrySealedOriginsConfiguration,
): HostRuntimeEntryOwnerManifest {
  const path = configuration.manifest.path, before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024 || realpathSync(path) !== path) return fail()
  const bytes = readFileSync(path), after = lstatSync(path)
  if (hash(bytes) !== configuration.manifest.sha256 || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return fail()
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const m = parseHostRuntimeEntryOwnerManifest(value)
  if (m.implementationDigest !== configuration.implementationDigest
    || m.compositionDigest !== configuration.compositionDigest) return fail()
  return m
}
/** Resolve every expected owner from independent roots and check all members and importer-specific edges.
 * @param manifest - Strict expected resource whose raw SHA was verified by its trusted reader.
 * @param runtimeRoot - Canonical signed installation root, independently derived by this process.
 * @param profileDir - Canonical parent-selected profiles/web directory.
 * @param lookup - Actual fixed RuntimeResolution lookup, without global interception in Main.
 * @returns Selected immutable file hashes for existing historical artifact readers; not execution authority.
 */
export function verifyHostRuntimeEntryOwners(manifest: HostRuntimeEntryOwnerManifest, runtimeRoot: string,
  profileDir: string, lookup: RuntimeEntryOwnerLookup): readonly Readonly<{ path: string; sha256: string }>[] {
  if (realpathSync(runtimeRoot) !== runtimeRoot || realpathSync(profileDir) !== profileDir) return fail()
  const roots = new Map<string, string>(), pending = [...manifest.owners], selected = new Set<string>()
  const budget = { entries: 0, files: 0, bytes: 0 }, pins: Readonly<{ path: string; sha256: string }>[] = []
  while (pending.length) {
    const before = pending.length
    for (let i = pending.length - 1; i >= 0; --i) {
      const o = pending[i]
      if (!o) return fail()
      const s = o.selector
      let root: string | undefined
      if (s.kind === 'runtime') root = within(runtimeRoot, join(runtimeRoot, s.relativeRoot))
      else if (s.kind === 'profile_plugin') {
        const actual = lookup.packageDir('ds-bot', pathToFileURL(profileDir + sep).href)
        if (!actual) return fail()
        root = within(join(profileDir, 'node_modules'), actual)
      } else {
        const from = roots.get(s.fromOwnerId)
        if (!from) continue
        const parent = within(from, join(from, s.fromPath)), actual = lookup.packageDir(s.specifier, pathToFileURL(parent).href)
        if (!actual) return fail()
        root = within(join(profileDir, 'node_modules'), actual)
        const resolved = lookup.resolve(pathToFileURL(parent).href, s.specifier, s.mode).url
        if (!resolved.startsWith('file:')) return fail()
        within(root, fileURLToPath(resolved))
      }
      if (selected.has(root)) return fail()
      selected.add(root); roots.set(o.ownerId, root); pending.splice(i, 1)
      const path = join(root, 'package.json'), stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return fail()
      const bytes = readFileSync(path), packageValue: unknown = JSON.parse(bytes.toString('utf8'))
      if (!packageValue || typeof packageValue !== 'object' || Reflect.get(packageValue, 'name') !== o.packageName
        || Reflect.get(packageValue, 'version') !== o.packageVersion || hash(bytes) !== o.manifestSha256) return fail()
      const tree = readRuntimeOwnerTree(root, budget)
      if (tree.treeSha256 !== o.treeSha256 || tree.fileCount !== o.fileCount || tree.totalBytes !== o.totalBytes) return fail()
      // Existing readers require only these two original DS journal source files; complete owners were checked above.
      if (s.kind === 'profile_plugin') for (const file of ['project-operation-native-entry.js', 'project-operation-journal.js']) {
        const member = within(root, join(root, 'src/host', file))
        pins.push(Object.freeze({ path: member, sha256: hash(readFileSync(member)) }))
      }
    }
    if (pending.length === before) return fail()
  }
  for (const e of manifest.edges) {
    const from = roots.get(e.fromOwnerId), to = roots.get(e.toOwnerId)
    if (!from || !to) return fail()
    const parent = within(from, join(from, e.fromPath)), expected = within(to, join(to, e.toPath))
    const actual = lookup.resolve(pathToFileURL(parent).href, e.specifier, e.mode)
    if (!actual.url.startsWith('file:') || realpathSync(fileURLToPath(actual.url)) !== expected
      || JSON.stringify(actual.conditions) !== JSON.stringify(e.conditions)) return fail()
  }
  for (const n of manifest.nativeBindings) {
    const root = roots.get(n.ownerId)
    if (!root || n.platform !== process.platform || n.arch !== process.arch) return fail()
    const member = within(root, join(root, n.path))
    if (hash(readFileSync(member)) !== n.sha256) return fail()
  }
  return Object.freeze(pins)
}
/** Derive the runtime root from the one fixed copied installation resource location.
 * @param configuration - Parent-owned native-origins/owners-v3.json reference.
 * @returns Canonical runtime payload root, never a caller-selected path.
 */
export function runtimeEntrySealedRuntimeRoot(configuration: HostRuntimeEntrySealedOriginsConfiguration): string {
  const root = dirname(dirname(configuration.manifest.path))
  if (configuration.manifest.path !== join(root, 'native-origins', 'owners-v3.json') || realpathSync(root) !== root) return fail()
  return root
}

/** Check the currently loaded resolver binding against its sealed original distribution bytes.
 * @param manifest - Expected fixed current-platform binding metadata from the trusted resource.
 * @returns Nothing; absent, changed or unrecognized selected resolver bindings reject Native support.
 */
export function assertRuntimeEntryLoadedNativeBinding(manifest: HostRuntimeEntryOwnerManifest): void {
  const cache = createRequire(import.meta.url).cache
  const expected = manifest.nativeBindings.filter(n => n.platform === process.platform && n.arch === process.arch)
  if (!expected.length) return fail()
  let found = false, totalBytes = 0
  for (const [path, module] of Object.entries(cache)) {
    if (!path.endsWith('.node') || !module) continue
    const exports: unknown = module.exports
    if (!exports || typeof exports !== 'object') continue
    const info: unknown = Reflect.get(exports, 'nativeBindingInfo')
    if (!info || typeof info !== 'object' || Reflect.get(info, 'product') !== 'require-builtin') continue
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || (totalBytes += before.size) > 64 * 1024 * 1024) return fail()
    const digest = hash(readFileSync(path)), after = lstatSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || Reflect.get(info, 'mode') !== 'napi' || Reflect.get(info, 'backend') !== 'napi'
      || Reflect.get(info, 'abi') !== 'napi-v9' || !expected.some(n => digest === n.sha256)) return fail()
    found = true
  }
  if (!found) return fail()
}
