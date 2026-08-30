/** Filesystem provider for a deployment-published immutable plugin catalog manifest. */

import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { PluginCatalog, buildCatalogSnapshot, type CatalogPackageMapping, type CatalogSnapshotV1 } from '@deepseek-ai/dsh-plugin-catalog'
import z from '@deepseek-ai/schemastery'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FILES = 20_000
interface ManifestV1 {
  schemaVersion: 1
  sourceCommit: string
  expectedRevision: string
  generatedAt: string
  files: string[]
  registry: string
}

export interface Config { manifestPath: string }
export const Config: z<Config> = z.object({ manifestPath: z.string().required() })

function parseManifest(content: string): ManifestV1 {
  if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) throw new Error('plugin catalog file: manifest is too large')
  const value: unknown = JSON.parse(content)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plugin catalog file: invalid manifest')
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.some(key => !['schemaVersion', 'sourceCommit', 'expectedRevision', 'generatedAt', 'files', 'registry'].includes(key))) {
    throw new Error('plugin catalog file: unknown manifest field')
  }
  if (row.schemaVersion !== 1 || typeof row.sourceCommit !== 'string' || typeof row.expectedRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.expectedRevision) || typeof row.generatedAt !== 'string'
    || !Array.isArray(row.files) || typeof row.registry !== 'string') {
    throw new Error('plugin catalog file: invalid manifest')
  }
  if (row.files.length === 0 || row.files.length > MAX_FILES || row.files.some(path => typeof path !== 'string')) throw new Error('plugin catalog file: invalid file list')
  if (!row.registry.endsWith('.json')) throw new Error('plugin catalog file: invalid registry path')
  return row as unknown as ManifestV1
}

function parsePackages(content: string): CatalogPackageMapping[] {
  if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new Error('plugin catalog file: registry is too large')
  const value: unknown = JSON.parse(content)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plugin catalog file: invalid registry')
  const plugins = (value as Record<string, unknown>).plugins
  if (!Array.isArray(plugins) || plugins.length > MAX_FILES) throw new Error('plugin catalog file: invalid registry plugins')
  const mappings: CatalogPackageMapping[] = []
  for (const item of plugins) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('plugin catalog file: invalid registry plugin')
    const row = item as Record<string, unknown>
    if (row.npm === null || row.npm === undefined) continue
    if (typeof row.url !== 'string' || typeof row.npm !== 'string') throw new Error('plugin catalog file: invalid registry package mapping')
    mappings.push({ repositoryUrl: row.url, packageName: row.npm })
  }
  return mappings
}

/** Cordis provider loading one immutable, deployment-owned snapshot at boot. */
export class FilePluginCatalog extends PluginCatalog {
  static Config = Config
  protected snapshot?: CatalogSnapshotV1

  constructor(ctx: Context, protected readonly config: Config) { super(ctx) }

  async [Service.init](): Promise<void> {
    if (!isAbsolute(this.config.manifestPath)) throw new Error('plugin catalog file: manifestPath must be absolute')
    const manifestText = await readFile(this.config.manifestPath, 'utf8')
    const manifest = parseManifest(manifestText)
    const root = await realpath(dirname(this.config.manifestPath))
    const seen = new Set<string>()
    const files = []
    for (const path of manifest.files) {
      if (path.length === 0 || isAbsolute(path) || path.includes('\\') || !path.endsWith('.yml')) throw new Error('plugin catalog file: invalid source path')
      const target = resolve(root, path)
      const rel = relative(root, target)
      if (rel.startsWith('..') || isAbsolute(rel) || seen.has(path)) throw new Error('plugin catalog file: unsafe or duplicate source path')
      seen.add(path)
      const actual = await realpath(target)
      const actualRel = relative(root, actual)
      if (actualRel.startsWith('..') || isAbsolute(actualRel) || !(await lstat(actual)).isFile()) throw new Error('plugin catalog file: source escapes snapshot root')
      files.push({ path, content: await readFile(actual, 'utf8') })
    }
    if (isAbsolute(manifest.registry) || manifest.registry.includes('\\')) throw new Error('plugin catalog file: invalid registry path')
    const registryTarget = await realpath(resolve(root, manifest.registry))
    const registryRel = relative(root, registryTarget)
    if (registryRel.startsWith('..') || isAbsolute(registryRel) || !(await lstat(registryTarget)).isFile()) {
      throw new Error('plugin catalog file: registry escapes snapshot root')
    }
    const packages: CatalogPackageMapping[] = parsePackages(await readFile(registryTarget, 'utf8'))
    const snapshot = buildCatalogSnapshot({
      sourceCommit: manifest.sourceCommit,
      generatedAt: manifest.generatedAt,
      files,
      packages,
    })
    if (snapshot.revision !== manifest.expectedRevision) {
      throw new Error('plugin catalog file: snapshot content does not match expected revision')
    }
    this.snapshot = snapshot
  }

  current(): CatalogSnapshotV1 | undefined { return this.snapshot }
}

export default FilePluginCatalog
