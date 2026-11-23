import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { checkedBytes, verifyProfileRollbackArchive } from './bundled-plugin-recovery.ts'
import { HostAuthorityError } from './types.ts'

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const PINNED_ALIAS = new RegExp(`^npm:(?<name>${PACKAGE_NAME.source.slice(1, -1)})@(?<version>${EXACT_VERSION.source.slice(1, -1)})$`, 'u')

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export interface ExistingPluginRecoveryOptions {
  readonly webRoot: string
  readonly expectedUid: number
  readonly dependencies: Readonly<Record<string, unknown>>
  readonly names: readonly string[]
  readonly runtimeRoots: readonly string[]
  readonly digestTree: (root: string, runtimeOwned: boolean) => Promise<{
    readonly digest: string
    readonly bytes: number
    readonly entries: number
  }>
}

/** Inspect already installed, explicitly declared plugin bytes without executing or changing them.
 * @param options Profile-owned declarations, packaged fallback roots, and bounded tree verifier.
 * @returns Digest of the real dependency closure, or undefined for an unsupported declaration.
 */
export async function inspectExistingPluginClosure(options: ExistingPluginRecoveryOptions): Promise<string | undefined> {
  const { webRoot, expectedUid, dependencies, runtimeRoots } = options
  const external = new Set<string>()
  const runtimeOwned = (path: string) => runtimeRoots.some(root => contained(root, path))
  const allowed = (path: string) => contained(webRoot, path) || runtimeOwned(path) || [...external].some(root => contained(root, path))
  const readBytes = async (path: string): Promise<Buffer> => {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7022) !== 0
      || before.uid !== expectedUid && !(runtimeOwned(path) && before.uid === 0)
      || before.size < 1 || before.size > 16 * 1024 * 1024) throw new HostAuthorityError('runtime_incompatible')
    return await checkedBytes(path, before.uid, 16 * 1024 * 1024)
  }
  const json = async (path: string): Promise<Record<string, unknown>> => {
    const value = record(JSON.parse((await readBytes(path)).toString('utf8')))
    if (!value) throw new HostAuthorityError('runtime_incompatible')
    return value
  }
  try {
    const manifest = await json(join(webRoot, 'package.json'))
    const lockBytes = await readBytes(join(webRoot, 'pnpm-lock.yaml'))
    const lock = record(parse(lockBytes.toString('utf8'), { maxAliasCount: 100 }))
    if (!lock || !['9', '9.0'].includes(String(lock.lockfileVersion))) return undefined
    const importer = record(record(lock.importers)?.['.'])
    const locked = record(importer?.dependencies)
    if (!locked) return undefined
    const roots = new Map<string, string>()
    for (const name of options.names) {
      if (!PACKAGE_NAME.test(name)) throw new HostAuthorityError('runtime_incompatible')
      const spec = dependencies[name]
      if (typeof spec !== 'string' || record(locked[name])?.specifier !== spec
        || record(manifest.dependencies)?.[name] !== spec) return undefined
      const installed = join(webRoot, 'node_modules', name)
      let root: string
      try { root = await realpath(installed) } catch { return undefined }
      if (spec.startsWith('link:')) {
        if (root !== await realpath(resolve(webRoot, spec.slice(5)))) throw new HostAuthorityError('runtime_incompatible')
        if (!allowed(root)) external.add(root)
      } else if (!allowed(root)) {
        throw new HostAuthorityError('runtime_incompatible')
      } else if (spec.startsWith('file:')) {
        const archive = relative(webRoot, resolve(webRoot, spec.slice(5))).split(sep).join('/')
        await verifyProfileRollbackArchive(webRoot, `file:${archive}`, name, expectedUid, true)
      } else if (!EXACT_VERSION.test(spec)) {
        return undefined
      }
      const identity = await json(join(root, 'package.json'))
      if (identity.name !== name || typeof identity.version !== 'string' || !EXACT_VERSION.test(identity.version)
        || EXACT_VERSION.test(spec) && identity.version !== spec) throw new HostAuthorityError('runtime_incompatible')
      roots.set(name, root)
    }
    const seen = new Set<string>()
    const facts: Array<readonly [string, string]> = []
    let entries = 0; let bytes = 0
    const visit = async (name: string, root: string, spec?: string): Promise<void> => {
      const alias = spec?.startsWith('npm:') ? PINNED_ALIAS.exec(spec) : undefined
      if (spec?.startsWith('npm:') && !alias) {
        throw new HostAuthorityError('runtime_incompatible')
      }
      const { name: aliasName, version: aliasVersion } = alias?.groups ?? {}
      const identityName = aliasName ?? name
      if (!allowed(root)) throw new HostAuthorityError('runtime_incompatible')
      const identity = await json(join(root, 'package.json'))
      if (identity.name !== identityName || typeof identity.version !== 'string' || !EXACT_VERSION.test(identity.version)
        || alias && identity.version !== aliasVersion) {
        throw new HostAuthorityError('runtime_incompatible')
      }
      if (seen.has(root)) return
      seen.add(root)
      const tree = await options.digestTree(root, runtimeOwned(root))
      entries += tree.entries; bytes += tree.bytes
      if (entries > 100_000 || bytes > 2 * 1024 * 1024 * 1024) throw new HostAuthorityError('runtime_incompatible')
      facts.push([root, tree.digest])
      const required = record(identity.dependencies)
      const optional = record(identity.optionalDependencies)
      const peers = record(identity.peerDependencies)
      if (identity.dependencies !== undefined && !required || identity.optionalDependencies !== undefined && !optional
        || identity.peerDependencies !== undefined && !peers) throw new HostAuthorityError('runtime_incompatible')
      const peerMetadata = record(identity.peerDependenciesMeta)
      for (const [dependency, spec] of Object.entries({ ...required, ...peers, ...optional }).sort()) {
        if (!PACKAGE_NAME.test(dependency) || typeof spec !== 'string' || spec.length === 0) throw new HostAuthorityError('runtime_incompatible')
        let found: string | undefined
        for (let directory = root; ; directory = dirname(directory)) {
          const candidate = join(directory, 'node_modules', dependency)
          if (allowed(candidate) || contained(root, candidate)) {
            try { found = await realpath(candidate); break } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
            }
          }
          if (dirname(directory) === directory) break
        }
        if (!found) {
          for (const runtime of runtimeRoots) {
            try { found = await realpath(join(runtime, 'node_modules', dependency)); break } catch (error) {
              if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
            }
          }
        }
        if (!found) {
          if (optional?.[dependency] !== undefined || record(peerMetadata?.[dependency])?.optional === true) continue
          throw new HostAuthorityError('runtime_incompatible')
        }
        await visit(dependency, found, spec)
      }
    }
    for (const [name, root] of [...roots].sort(([left], [right]) => left.localeCompare(right))) await visit(name, root)
    // Bind the declarations/lock as well as all installed and transitive bytes. No paths leave this digest.
    return createHash('sha256').update(JSON.stringify({ manifest, lock: createHash('sha256').update(lockBytes).digest('hex'),
      roots: [...roots].sort(), facts: facts.sort(([left], [right]) => left.localeCompare(right)) })).digest('hex')
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('runtime_incompatible')
  }
}
