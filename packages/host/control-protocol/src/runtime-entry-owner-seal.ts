/** Bounded installation owner seals; these bytes identify code and never grant task or source permission. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { array, digest, record } from './twin-binding-validation.ts'

const invalid = (): never => { throw Error('invalid_runtime_entry_owner_seal') }
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > max
    || /[\x00-\x1f\x7f]/u.test(value)) return invalid()
  return value
}
const path = (value: unknown): string => {
  const p = text(value, 1536)
  if (p.includes('\\') || p.includes(':') || p.split('/').some(part => !part || part === '.' || part === '..')) return invalid()
  return p
}
const memberPath = (value: unknown): string => {
  const p = path(value)
  if (p.split('/').some(part => part === 'node_modules' || part === '.git')) return invalid()
  return p
}
/** Physical package identity local to one installation owner resource. */
export type HostRuntimeEntryOwnerId = Branded<'HostRuntimeEntryOwnerId'>
const id = (value: unknown): HostRuntimeEntryOwnerId => {
  const s = text(value, 64)
  return /^o[0-9]{4,6}$/u.test(s) ? brandString<HostRuntimeEntryOwnerId>(s) : invalid()
}
const mode = (value: unknown): 'import' | 'require' => value === 'import' || value === 'require' ? value : invalid()
const source = (value: unknown): string => { const s = text(value, 40); return /^[a-f0-9]{40}$/u.test(s) ? s : invalid() }
const integer = (value: unknown, max: number, min = 0): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid()
const packageName = (value: unknown): string => {
  const s = text(value, 214)
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(s) ? s : invalid()
}
const numeric = '(?:0|[1-9][0-9]*)'
const suffix = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*'
const versionExpression = new RegExp('^' + numeric + '\\.' + numeric + '\\.' + numeric
  + '(?:-(' + suffix + '))?(?:\\+' + suffix + ')?$', 'u')
const version = (value: unknown): string => {
  const s = text(value, 128)
  const match = versionExpression.exec(s)
  if (!match || match[1]?.split('.').some(part => /^[0-9]+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return invalid()
  return s
}
const specifier = (value: unknown): string => text(value, 256)
function selector(value: unknown) {
  if (value && typeof value === 'object' && Reflect.get(value, 'kind') === 'runtime') {
    const s = record(value, ['kind', 'relativeRoot']), root = path(s.relativeRoot)
    if (!root.startsWith('app/node_modules/')) return invalid()
    return Object.freeze({ kind: 'runtime' as const, relativeRoot: root })
  }
  if (value && typeof value === 'object' && Reflect.get(value, 'kind') === 'profile_plugin') {
    const s = record(value, ['kind', 'packageName'])
    if (s.packageName !== 'ds-bot') return invalid()
    return Object.freeze({ kind: 'profile_plugin' as const, packageName: 'ds-bot' as const })
  }
  const s = record(value, ['kind', 'fromOwnerId', 'fromPath', 'specifier', 'mode'])
  if (s.kind !== 'profile_dependency') return invalid()
  return Object.freeze({ kind: 'profile_dependency' as const, fromOwnerId: id(s.fromOwnerId), fromPath: memberPath(s.fromPath),
    specifier: specifier(s.specifier), mode: mode(s.mode) })
}
function owner(value: unknown) {
  const o = record(value, ['ownerId', 'packageName', 'packageVersion', 'manifestSha256', 'selector', 'treeSha256', 'fileCount',
    'totalBytes'])
  return Object.freeze({ ownerId: id(o.ownerId), packageName: packageName(o.packageName), packageVersion: version(o.packageVersion),
    manifestSha256: digest(o.manifestSha256), selector: selector(o.selector), treeSha256: digest(o.treeSha256),
    fileCount: integer(o.fileCount, 16384, 1), totalBytes: integer(o.totalBytes, 512 * 1024 * 1024, 1) })
}
function edge(value: unknown) {
  const e = record(value, ['fromOwnerId', 'fromPath', 'specifier', 'mode', 'conditions', 'toOwnerId', 'toPath'])
  const conditions = array(e.conditions, 16, value => text(value, 64)), m = mode(e.mode)
  if (!conditions.includes('node') || !conditions.includes(m) || conditions.includes(m === 'import' ? 'require' : 'import')
    || new Set(conditions).size !== conditions.length) return invalid()
  return Object.freeze({ fromOwnerId: id(e.fromOwnerId), fromPath: memberPath(e.fromPath), specifier: specifier(e.specifier), mode: m,
    conditions: Object.freeze(conditions), toOwnerId: id(e.toOwnerId), toPath: memberPath(e.toPath) })
}
function nativeBinding(value: unknown) {
  const n = record(value, ['ownerId', 'platform', 'arch', 'backend', 'abi', 'path', 'sha256'])
  if (n.platform !== 'darwin' || n.arch !== 'arm64' || n.backend !== 'napi' || n.abi !== 'napi-v9') return invalid()
  return Object.freeze({ ownerId: id(n.ownerId), platform: 'darwin' as const, arch: 'arm64' as const,
    backend: 'napi' as const, abi: 'napi-v9' as const, path: memberPath(n.path), sha256: digest(n.sha256) })
}
/** Expected complete distribution-owner inventory read from one signed installation resource. */
export interface HostRuntimeEntryOwnerManifest {
  readonly schemaVersion: 3
  readonly implementationDigest: string
  readonly compositionDigest: string
  readonly runtime: Readonly<{ sourceSha: string; archiveSha256: string }>
  readonly plugin: Readonly<{ packageName: 'ds-bot'; packageVersion: string; sourceSha: string; archiveSha256: string }>
  readonly owners: readonly ReturnType<typeof owner>[]
  readonly edges: readonly ReturnType<typeof edge>[]
  readonly nativeBindings: readonly ReturnType<typeof nativeBinding>[]
}
/** Parse the file-backed installation inventory without resolving or loading any code.
 * @param value - Untrusted parsed installation file, bounded by its raw-byte reader first.
 * @returns Detached immutable owner metadata; no runtime or business authorization is created.
 */
export function parseHostRuntimeEntryOwnerManifest(value: unknown): HostRuntimeEntryOwnerManifest {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return invalid()
  const m = record(value, ['schemaVersion', 'implementationDigest', 'compositionDigest', 'runtime', 'plugin', 'owners', 'edges',
    'nativeBindings'])
  if (m.schemaVersion !== 3) return invalid()
  const r = record(m.runtime, ['sourceSha', 'archiveSha256']), p = record(m.plugin, ['packageName', 'packageVersion', 'sourceSha',
    'archiveSha256'])
  if (p.packageName !== 'ds-bot') return invalid()
  const owners = array(m.owners, 256, owner), edges = array(m.edges, 8192, edge), nativeBindings = array(m.nativeBindings, 16,
    nativeBinding)
  const byId = new Map(owners.map(o => [o.ownerId, o])), roots = owners.map(o => JSON.stringify(o.selector))
  if (!owners.length || byId.size !== owners.length || new Set(roots).size !== roots.length
    || owners.filter(o => o.selector.kind === 'profile_plugin').length !== 1
    || owners.reduce((n, o) => n + o.fileCount, 0) > 16384 || owners.reduce((n, o) => n + o.totalBytes, 0) > 512 * 1024 * 1024
    || new Set(edges.map(e => JSON.stringify([e.fromOwnerId, e.fromPath, e.specifier, e.mode]))).size !== edges.length
    || new Set(nativeBindings.map(n => JSON.stringify([n.ownerId, n.path]))).size !== nativeBindings.length) return invalid()
  const plugin = owners.find(o => o.selector.kind === 'profile_plugin')
  if (plugin?.packageName !== 'ds-bot' || plugin.packageVersion !== p.packageVersion) return invalid()
  for (const o of owners) if (o.selector.kind === 'profile_dependency' && (!byId.has(o.selector.fromOwnerId)
    || o.selector.fromOwnerId === o.ownerId)) return invalid()
  for (const e of edges) if (!byId.has(e.fromOwnerId) || !byId.has(e.toOwnerId)) return invalid()
  for (const n of nativeBindings) if (!byId.has(n.ownerId)) return invalid()
  // Dependency roots must reach an installation or the one actual Profile plugin; cycles cannot select a root.
  for (const o of owners) {
    let current = o; const seen = new Set<string>()
    while (current.selector.kind === 'profile_dependency') {
      if (seen.has(current.ownerId)) return invalid()
      seen.add(current.ownerId)
      const parent = byId.get(current.selector.fromOwnerId)
      if (!parent) return invalid()
      current = parent
    }
  }
  return Object.freeze({ schemaVersion: 3, implementationDigest: digest(m.implementationDigest),
    compositionDigest: digest(m.compositionDigest),
    runtime: Object.freeze({ sourceSha: source(r.sourceSha), archiveSha256: digest(r.archiveSha256) }),
    plugin: Object.freeze({ packageName: 'ds-bot', packageVersion: version(p.packageVersion), sourceSha: source(p.sourceSha),
      archiveSha256: digest(p.archiveSha256) }),
    owners: Object.freeze(owners), edges: Object.freeze(edges), nativeBindings: Object.freeze(nativeBindings) })
}
