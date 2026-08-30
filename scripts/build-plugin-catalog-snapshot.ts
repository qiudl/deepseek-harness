/** Build a deployment snapshot from one clean, pinned awesome-dsh-plugin checkout. */

import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildCatalogSnapshot, type CatalogPackageMapping } from '../packages/slark/plugin-catalog/src/index.ts'

interface RegistryPlugin { url: string; npm?: string | null }
interface Registry { count: number; plugins: RegistryPlugin[] }

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error(`build-plugin-catalog-snapshot: missing ${name}`)
  }
  return resolve(value)
}

function git(checkout: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
}

function registryFrom(value: unknown): Registry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid registry object')
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.count) || !Array.isArray(row.plugins) || row.count !== row.plugins.length) {
    throw new Error('registry count does not match plugins')
  }
  for (const plugin of row.plugins) {
    if (typeof plugin !== 'object' || plugin === null || Array.isArray(plugin)
      || typeof (plugin as Record<string, unknown>).url !== 'string'
      || ((plugin as Record<string, unknown>).npm != null && typeof (plugin as Record<string, unknown>).npm !== 'string')) {
      throw new Error('invalid registry plugin')
    }
  }
  return row as unknown as Registry
}

async function main(): Promise<void> {
  const checkout = argument('--checkout')
  const registryPath = argument('--registry')
  const output = argument('--output')
  const checkoutRoot = await realpath(checkout)
  if (await realpath(git(checkoutRoot, ['rev-parse', '--show-toplevel'])) !== checkoutRoot) {
    throw new Error('checkout must name the Git worktree root')
  }
  if (git(checkoutRoot, ['remote', 'get-url', 'origin']) !== 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git') {
    throw new Error('checkout origin is not the official awesome-dsh-plugin repository')
  }
  const outputRelative = relative(checkoutRoot, output)
  if (outputRelative === '' || (!outputRelative.startsWith('..') && !isAbsolute(outputRelative))) {
    throw new Error('output must be outside the source checkout')
  }
  const registryName = basename(registryPath)
  if (!registryName.endsWith('.json') || registryName === 'manifest.json') throw new Error('unsafe registry filename')
  const sourceCommit = git(checkoutRoot, ['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('checkout HEAD is not a full commit')
  if (git(checkoutRoot, ['status', '--porcelain', '--', 'data/plugins']) !== '') {
    throw new Error('checkout data/plugins has uncommitted changes')
  }
  const sourceRoot = join(checkoutRoot, 'data/plugins')
  const names = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.yml'))
    .map(entry => entry.name)
    .sort()
  const files = await Promise.all(names.map(async path => ({ path: `data/plugins/${path}`, content: await readFile(join(sourceRoot, path), 'utf8') })))
  const registryText = await readFile(registryPath, 'utf8')
  const registry = registryFrom(JSON.parse(registryText) as unknown)
  if (registry.count !== files.length) throw new Error('registry and top-level YAML counts differ')
  const packages: CatalogPackageMapping[] = registry.plugins.flatMap(plugin => plugin.npm == null
    ? []
    : [{ repositoryUrl: plugin.url, packageName: plugin.npm }])
  const generatedAt = new Date().toISOString()
  const snapshot = buildCatalogSnapshot({ sourceCommit, generatedAt, files, packages })
  const sourceUrls = new Set(snapshot.entries.map(entry => entry.repositoryUrl))
  const registryUrls = new Set(registry.plugins.map(plugin => plugin.url.replace(/\/$/, '').replace(/\.git$/, '')))
  if (sourceUrls.size !== registryUrls.size || [...sourceUrls].some(url => !registryUrls.has(url))) {
    throw new Error('registry URLs do not match catalog sources')
  }

  await mkdir(output)
  await mkdir(join(output, 'data/plugins'), { recursive: true })
  await Promise.all(names.map(name => cp(join(sourceRoot, name), join(output, 'data/plugins', name), { errorOnExist: true })))
  await cp(registryPath, join(output, registryName), { errorOnExist: true })
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceCommit,
    expectedRevision: snapshot.revision,
    generatedAt,
    files: files.map(file => file.path),
    registry: registryName,
  }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ sourceCommit, revision: snapshot.revision, entries: snapshot.entries.length, output })}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
