import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Embedding-owned plugin archives the Host may install without network access. */
export interface BundledPlugin {
  readonly name: string
  readonly version: string
  readonly file: string
  readonly sha256: string
  /** Root entry IDs the bundle patch inserts; an existing row with the same ID is a conflict. */
  readonly entryIds: readonly string[]
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const version = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const bundledSpec = new RegExp('^bundled:((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@'
  + '((?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*))$', 'u')
const archiveName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tgz$/u
const sha256 = /^[0-9a-f]{64}$/u
const entryId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_CATALOG_BYTES = 65_536
const MAX_ARCHIVE_BYTES = 33_554_432
/** Profile-owned, content-addressed archive directory relative to `profiles/web`. */
export const BUNDLED_ARCHIVE_DIRECTORY = '.bundled-plugins'

/** @param sha256 Archive digest. @returns Profile-relative dependency pnpm records for a materialized archive. */
export function bundledDependencySpec(sha256: string): string {
  return `file:${BUNDLED_ARCHIVE_DIRECTORY}/${sha256}.tgz`
}

/** @param spec Package source. @returns Exact bundled identity, or undefined for every other source. */
export function parseBundledPluginSpec(spec: string): { name: string; version: string } | undefined {
  const [, name, exactVersion] = (spec.length <= 256 ? bundledSpec.exec(spec) : null) ?? []
  return name && exactVersion ? { name, version: exactVersion } : undefined
}

function trustedEmbeddingPath(path: string, directory: boolean, uid: number): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0) throw Error('unsafe_bundled_plugins')
}

function parse(value: unknown): BundledPlugin[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_bundled_plugins')
  const catalog = value as Record<string, unknown>
  if (Object.keys(catalog).sort().join(',') !== 'plugins,schemaVersion' || catalog.schemaVersion !== 1
    || !Array.isArray(catalog.plugins) || !catalog.plugins.length || catalog.plugins.length > 16) throw Error('invalid_bundled_plugins')
  const names = new Set<string>(); const files = new Set<string>()
  return catalog.plugins.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_bundled_plugins')
    const row = raw as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'entryIds,file,name,repository,sha256,sourceSha,version'
      || typeof row.name !== 'string' || row.name.length > 214 || !packageName.test(row.name) || names.has(row.name)
      || typeof row.version !== 'string' || !version.test(row.version)
      || typeof row.file !== 'string' || !archiveName.test(row.file) || files.has(row.file)
      || typeof row.sha256 !== 'string' || !sha256.test(row.sha256)
      || typeof row.repository !== 'string' || !row.repository.startsWith('https://')
      || typeof row.sourceSha !== 'string' || !/^[0-9a-f]{40}$/u.test(row.sourceSha)
      || !Array.isArray(row.entryIds) || row.entryIds.length > 32
      || row.entryIds.some(id => typeof id !== 'string' || !entryId.test(id))) throw Error('invalid_bundled_plugins')
    names.add(row.name); files.add(row.file)
    return { name: row.name, version: row.version, file: row.file, sha256: row.sha256, entryIds: [...row.entryIds as string[]] }
  })
}

/** Read-only catalog of embedding archives; every archive is re-hashed before it is copied. */
export class BundledPluginCatalog {
  private constructor(private readonly root: string, private readonly uid: number, private readonly plugins: readonly BundledPlugin[]) {}

  /**
   * @param root Absolute embedding directory holding `catalog.v1.json` and archives.
   * @param uid Host owner; embedding files may be owned by it or by root, but never group/world writable.
   * @returns Validated catalog; archives are verified lazily at materialization.
   */
  static load(root: string, uid: number): BundledPluginCatalog {
    if (!isAbsolute(root)) throw Error('unsafe_bundled_plugins')
    trustedEmbeddingPath(root, true, uid)
    const path = join(root, 'catalog.v1.json')
    trustedEmbeddingPath(path, false, uid)
    const bytes = readFileSync(path)
    if (!bytes.length || bytes.length > MAX_CATALOG_BYTES) throw Error('invalid_bundled_plugins')
    return new BundledPluginCatalog(root, uid, parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))
  }

  /**
   * @param root Configured embedding directory, if any. @param uid Host owner.
   * @returns Catalog, or undefined when absent or damaged: a bad embedding disables `bundled:` sources but never the Host.
   */
  static tryLoad(root: string | undefined, uid: number): BundledPluginCatalog | undefined {
    if (root === undefined) return undefined
    try { return BundledPluginCatalog.load(root, uid) } catch { return undefined }
  }

  /** @returns Exact catalog row for an identity, or undefined. */
  get(name: string, exactVersion: string): BundledPlugin | undefined {
    return this.plugins.find(plugin => plugin.name === name && plugin.version === exactVersion)
  }

  /**
   * Copy one verified archive into `<webRoot>/.bundled-plugins/<sha256>.tgz` without replacing existing content.
   * @param plugin Catalog row. @param webRoot Selected `profiles/web` directory owned by the Host user.
   * @returns Absolute Profile-owned archive path whose content equals the catalog digest.
   */
  materialize(plugin: BundledPlugin, webRoot: string): string {
    return this.copy(plugin, webRoot)
  }

  /**
   * @param spec Confirmed package source. @param webRoot Selected `profiles/web` directory.
   * @returns Materialized archive for a `bundled:` source, or undefined for every other source.
   */
  archiveFor(spec: string, webRoot: string): string | undefined {
    const bundled = parseBundledPluginSpec(spec)
    if (!bundled) return undefined
    const plugin = this.get(bundled.name, bundled.version)
    if (!plugin) throw Error('bundled_plugin_unavailable')
    return this.copy(plugin, webRoot)
  }

  private copy(plugin: BundledPlugin, webRoot: string): string {
    if (this.get(plugin.name, plugin.version) !== plugin || !isAbsolute(webRoot)) throw Error('invalid_bundled_plugins')
    const source = join(this.root, plugin.file)
    trustedEmbeddingPath(source, false, this.uid)
    const bytes = readFileSync(source)
    if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES
      || createHash('sha256').update(bytes).digest('hex') !== plugin.sha256) throw Error('bundled_plugin_digest_mismatch')
    const directory = join(webRoot, BUNDLED_ARCHIVE_DIRECTORY)
    try { mkdirSync(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o022) !== 0) throw Error('unsafe_bundled_plugins')
    const target = join(directory, `${plugin.sha256}.tgz`)
    try {
      const existing = lstatSync(target)
      if (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== this.uid
        || createHash('sha256').update(readFileSync(target)).digest('hex') !== plugin.sha256) throw Error('bundled_plugin_conflict')
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${randomUUID()}.partial`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let published = false
    try {
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target); published = true
      const handle = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(handle) } finally { closeSync(handle) }
    } finally { if (!published) unlinkSync(temporary) }
    return target
  }
}
