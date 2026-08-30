/** Validated, immutable snapshots of the awesome-dsh-plugin directory. */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { parseDocument } from 'yaml'
import type {
  CatalogEntryV1,
  CatalogPackageMapping,
  CatalogQueryResultV1,
  CatalogQueryV1,
  CatalogSnapshotInput,
  CatalogSnapshotV1,
} from './types.ts'

export type * from './types.ts'

const MAX_FILE_BYTES = 8 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_DESCRIPTION_LENGTH = 4_096
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000
const COMMIT = /^[a-f0-9]{40}$/
const GITHUB_OWNER = /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const GITHUB_REPOSITORY = /^(?![.-])[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const URL_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@-]+$/
const TARBALL_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const BIDI_OR_CONTROL = /[\p{Cc}\p{Cf}]/u
const SEARCH_WORD = /[\p{Script=Han}]+|[\p{L}\p{N}]+/gu
const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'find', 'for', 'get', 'i', 'inside', 'is', 'me', 'my', 'need', 'on',
  'please', 'plugin', 'plugins', 'something', 'the', 'there', 'to', 'want', 'what', 'when', 'with', 'you',
])
const CJK_INTENT_PHRASES = ['找一个', '我需要', '有没有', '帮我', '我想', '查找', '搜索', '插件', '找个', '请', '找'] as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginCatalog: PluginCatalog
  }
}

/** Host capability seam exposing only the currently accepted catalog revision. */
export abstract class PluginCatalog extends Service {
  constructor(ctx: Context) {
    super(ctx, 'pluginCatalog')
  }

  /** Return the current snapshot, or undefined before any valid source has been accepted. */
  abstract current(): CatalogSnapshotV1 | undefined

  /** Query the current immutable snapshot. */
  query(query: CatalogQueryV1, now = Date.now()): CatalogQueryResultV1 {
    const snapshot = this.current()
    if (snapshot === undefined) throw new Error('plugin catalog: unavailable')
    return queryCatalog(snapshot, query, now)
  }
}

interface CatalogYaml {
  url: string
  name: string
  category: string
  tarball?: string
  description: { zh?: string; en?: string }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(message)
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || BIDI_OR_CONTROL.test(value)) {
    throw new Error(`plugin catalog: invalid ${name}`)
  }
  return value
}

function githubIdentity(repositoryUrl: string): void {
  const url = new URL(repositoryUrl)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('plugin catalog: invalid repository URL')
  }
  const path = url.pathname.replace(/\/$/, '').split('/').slice(1)
  const owner = path[0]
  const repositoryPart = path[1]
  if (owner === undefined || repositoryPart === undefined
    || path.some(segment => !URL_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('plugin catalog: invalid repository path')
  }
  const repository = repositoryPart.replace(/\.git$/, '')
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPOSITORY.test(repository)) {
    throw new Error('plugin catalog: invalid owner/repository path')
  }
  if (path.length > 2 && (path[2] !== 'tree' || path.length < 5)) {
    throw new Error('plugin catalog: invalid monorepo plugin URL')
  }
}

function parseYaml(path: string, content: string): CatalogYaml {
  if (!path.endsWith('.yml')) throw new Error('plugin catalog: source path must end in .yml')
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('plugin catalog: source file is too large')
  const document = parseDocument(content, { schema: 'core', merge: false, uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`plugin catalog: invalid YAML in ${path}`)
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch {
    throw new Error(`plugin catalog: aliases are not allowed in ${path}`)
  }
  const row = record(value, `plugin catalog: ${path} must contain an object`)
  exactKeys(row, ['url', 'name', 'category', 'tarball', 'description'], `plugin catalog: unknown field in ${path}`)
  const description = record(row.description, `plugin catalog: ${path} description must be an object`)
  exactKeys(description, ['zh', 'en'], `plugin catalog: unknown description field in ${path}`)
  const normalized: CatalogYaml = {
    url: text(row.url, 'repository URL', 512),
    name: text(row.name, 'owner/name', 200),
    category: text(row.category, 'category', 80),
    description: {},
  }
  if (description.zh !== undefined) normalized.description.zh = text(description.zh, 'Chinese description', MAX_DESCRIPTION_LENGTH)
  if (description.en !== undefined) normalized.description.en = text(description.en, 'English description', MAX_DESCRIPTION_LENGTH)
  if (normalized.description.zh === undefined && normalized.description.en === undefined) {
    throw new Error(`plugin catalog: ${path} has no description`)
  }
  if (row.tarball !== undefined) normalized.tarball = text(row.tarball, 'tarball URL', 1_024)
  return normalized
}

function normalizeEntry(source: CatalogYaml, packages: ReadonlyMap<string, string>): CatalogEntryV1 {
  const repositoryUrl = source.url.replace(/\/$/, '').replace(/\.git$/, '')
  githubIdentity(repositoryUrl)
  let declaredTarballUrl: string | undefined
  if (source.tarball !== undefined) {
    const tarball = new URL(source.tarball)
    if (tarball.protocol !== 'https:' || !TARBALL_HOSTS.has(tarball.hostname) || tarball.username || tarball.password
      || (!tarball.pathname.endsWith('.tgz') && !tarball.pathname.endsWith('.tar.gz'))
      || (tarball.hostname === 'github.com' && !tarball.pathname.includes('/releases/'))) {
      throw new Error('plugin catalog: invalid tarball URL')
    }
    declaredTarballUrl = tarball.href
  }
  const locator = declaredTarballUrl ?? repositoryUrl
  const packageName = packages.get(repositoryUrl)
  return {
    entryId: sha256(`${repositoryUrl}\n${locator}`).slice(0, 32),
    ownerName: source.name,
    repositoryUrl,
    category: source.category,
    descriptions: source.description,
    ...(declaredTarballUrl === undefined ? {} : { declaredTarballUrl }),
    ...(packageName === undefined ? {} : { packageName }),
    installability: 'catalog_candidate',
  }
}

/** Build and validate one immutable catalog snapshot. */
export function buildCatalogSnapshot(input: CatalogSnapshotInput): CatalogSnapshotV1 {
  if (!COMMIT.test(input.sourceCommit)) throw new Error('plugin catalog: invalid source commit')
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error('plugin catalog: invalid generation time')
  if (input.files.length === 0 || input.files.length > MAX_FILES) throw new Error('plugin catalog: invalid file count')
  const totalBytes = input.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('plugin catalog: snapshot is too large')
  const packages = packageMappings(input.packages ?? [])
  const entries = input.files.map(file => normalizeEntry(parseYaml(file.path, file.content), packages))
    .sort((left, right) => left.ownerName.localeCompare(right.ownerName) || left.entryId.localeCompare(right.entryId))
  const repositories = new Set(entries.map(entry => entry.repositoryUrl))
  if ([...packages.keys()].some(repositoryUrl => !repositories.has(repositoryUrl))) {
    throw new Error('plugin catalog: package mapping does not match a catalog source')
  }
  const identities = new Set<string>()
  for (const entry of entries) {
    if (identities.has(entry.repositoryUrl) || identities.has(entry.entryId)) {
      throw new Error(`plugin catalog: duplicate source ${entry.repositoryUrl}`)
    }
    identities.add(entry.repositoryUrl)
    identities.add(entry.entryId)
  }
  const revision = sha256(JSON.stringify({ sourceCommit: input.sourceCommit, entries }))
  return Object.freeze({
    revision,
    sourceCommit: input.sourceCommit,
    generatedAt: new Date(input.generatedAt).toISOString(),
    entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
  })
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
function packageMappings(mappings: readonly CatalogPackageMapping[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  const packageNames = new Set<string>()
  for (const mapping of mappings) {
    const repositoryUrl = mapping.repositoryUrl.replace(/\/$/, '').replace(/\.git$/, '')
    if (!PACKAGE_NAME.test(mapping.packageName) || result.has(repositoryUrl) || packageNames.has(mapping.packageName)) {
      throw new Error('plugin catalog: invalid or duplicate package mapping')
    }
    result.set(repositoryUrl, mapping.packageName)
    packageNames.add(mapping.packageName)
  }
  return result
}

/** Retains the last successfully validated snapshot across failed refreshes. */
export class CatalogSnapshotStore {
  #current?: CatalogSnapshotV1

  /** Validate and publish a complete snapshot atomically. */
  refresh(input: CatalogSnapshotInput): CatalogSnapshotV1 {
    const next = buildCatalogSnapshot(input)
    this.#current = next
    return next
  }

  /** Return the last successfully published snapshot. */
  current(): CatalogSnapshotV1 | undefined {
    return this.#current
  }
}

/** In-memory provider useful for tests and embedded, deployment-owned snapshot publication. */
export class MemoryPluginCatalog extends PluginCatalog {
  /** Cordis services are exposed through a proxy, so state lives in a conventional protected field rather than a JS private slot. */
  protected readonly store = new CatalogSnapshotStore()

  /** Validate and atomically publish one complete snapshot. */
  refresh(input: CatalogSnapshotInput): CatalogSnapshotV1 {
    return this.store.refresh(input)
  }

  current(): CatalogSnapshotV1 | undefined {
    return this.store.current()
  }
}

function cursorOffset(cursor: string | undefined, revision: string): number {
  if (cursor === undefined) return 0
  try {
    const value = record(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')), 'invalid cursor')
    exactKeys(value, ['revision', 'offset'], 'invalid cursor')
    if (value.revision !== revision || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) {
      throw new Error('invalid cursor')
    }
    return value.offset as number
  } catch {
    throw new Error('plugin catalog: invalid cursor')
  }
}

function searchTerms(value: string): readonly string[] {
  let normalized = value.normalize('NFKC').toLocaleLowerCase()
  for (const phrase of CJK_INTENT_PHRASES) normalized = normalized.replaceAll(phrase, ' ')
  const terms = new Set<string>()
  for (const match of normalized.matchAll(SEARCH_WORD)) {
    const token = match[0]
    if (SEARCH_STOP_WORDS.has(token)) continue
    if (/^\p{Script=Han}+$/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) terms.add(token.slice(index, index + 2))
    } else if (token.length > 1) {
      const stem = token.endsWith('ies') && token.length > 4
        ? `${token.slice(0, -3)}y`
        : token.endsWith('ing') && token.length > 5
          ? token.slice(0, -3)
          : token.endsWith('es') && token.length > 4
            ? token.slice(0, -2)
            : token.endsWith('s') && token.length > 3
              ? token.slice(0, -1)
              : token
      terms.add(stem)
    }
  }
  return [...terms]
}

/** Query one immutable snapshot with stable ordering and revision-bound cursors. */
export function queryCatalog(
  snapshot: CatalogSnapshotV1,
  query: CatalogQueryV1,
  now = Date.now(),
): CatalogQueryResultV1 {
  const rawQuery = record(query, 'plugin catalog: query must be an object')
  exactKeys(rawQuery, ['entryId', 'query', 'categories', 'sourceKinds', 'distributions', 'installed', 'installedEntryIds', 'sort', 'cursor', 'limit'],
    'plugin catalog: query contains an undeclared field')
  if (query.entryId !== undefined && (typeof query.entryId !== 'string' || !/^[a-f0-9]{32}$/.test(query.entryId))) {
    throw new Error('plugin catalog: invalid entry id')
  }
  if (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 200
    || BIDI_OR_CONTROL.test(query.query))) throw new Error('plugin catalog: invalid query')
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) {
    throw new Error('plugin catalog: invalid cursor')
  }
  if (query.categories !== undefined && (!Array.isArray(query.categories) || query.categories.length > 100
    || query.categories.some(category => typeof category !== 'string' || category.length === 0 || category.length > 80
      || BIDI_OR_CONTROL.test(category)))) throw new Error('plugin catalog: invalid categories')
  if (query.sourceKinds !== undefined && (!Array.isArray(query.sourceKinds) || query.sourceKinds.length > 3
    || query.sourceKinds.some(kind => kind !== 'github' && kind !== 'npm' && kind !== 'tarball'))) {
    throw new Error('plugin catalog: invalid source kinds')
  }
  if (query.distributions !== undefined && (!Array.isArray(query.distributions) || query.distributions.length > 2
    || query.distributions.some(kind => kind !== 'prebuilt' && kind !== 'source'))) {
    throw new Error('plugin catalog: invalid distributions')
  }
  if (query.installedEntryIds !== undefined && (!Array.isArray(query.installedEntryIds)
    || query.installedEntryIds.length > MAX_FILES
    || query.installedEntryIds.some(entryId => typeof entryId !== 'string' || !/^[a-f0-9]{32}$/.test(entryId)))) {
    throw new Error('plugin catalog: invalid installed entry ids')
  }
  if (rawQuery.installed !== undefined && !['any', 'yes', 'no'].includes(rawQuery.installed as string)) {
    throw new Error('plugin catalog: invalid installed filter')
  }
  if (rawQuery.sort !== undefined && rawQuery.sort !== 'relevance' && rawQuery.sort !== 'name') {
    throw new Error('plugin catalog: invalid sort')
  }
  const limit = query.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('plugin catalog: invalid limit')
  const terms = searchTerms(query.query?.trim() ?? '')
  const categories = new Set(query.categories ?? [])
  const sourceKinds = new Set(query.sourceKinds ?? [])
  const distributions = new Set(query.distributions ?? [])
  const installed = new Set(query.installedEntryIds ?? [])
  const installedFilter = query.installed ?? 'any'
  const minimumMatches = Math.max(1, Math.ceil(terms.length * 0.6))
  const matchingTerms = (entry: CatalogEntryV1): number => {
    const text = `${entry.ownerName} ${Object.values(entry.descriptions).join(' ')}`.toLocaleLowerCase()
    return terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0)
  }
  const score = (entry: CatalogEntryV1): number => {
    const owner = entry.ownerName.toLocaleLowerCase()
    const descriptions = Object.values(entry.descriptions).join(' ').toLocaleLowerCase()
    return terms.reduce((total, term) => total + (owner.includes(term) ? 2 : 0) + (descriptions.includes(term) ? 1 : 0), 0)
  }
  const matches = snapshot.entries.filter((entry) => {
    if (query.entryId !== undefined && entry.entryId !== query.entryId) return false
    if (terms.length > 0 && matchingTerms(entry) < minimumMatches) return false
    if (categories.size > 0 && !categories.has(entry.category)) return false
    const sourceKind = entry.packageName !== undefined ? 'npm' : entry.declaredTarballUrl === undefined ? 'github' : 'tarball'
    if (sourceKinds.size > 0 && !sourceKinds.has(sourceKind)) return false
    const distribution = sourceKind === 'github' ? 'source' : 'prebuilt'
    if (distributions.size > 0 && !distributions.has(distribution)) return false
    if (installedFilter === 'yes' && !installed.has(entry.entryId)) return false
    if (installedFilter === 'no' && installed.has(entry.entryId)) return false
    return true
  }).sort((left, right) => {
    if ((query.sort ?? 'relevance') === 'relevance') {
      const difference = score(right) - score(left)
      if (difference !== 0) return difference
    }
    return left.ownerName.localeCompare(right.ownerName) || left.entryId.localeCompare(right.entryId)
  })
  const offset = cursorOffset(query.cursor, snapshot.revision)
  if (offset > matches.length) throw new Error('plugin catalog: invalid cursor')
  const items = matches.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  const nextCursor = nextOffset < matches.length
    ? Buffer.from(JSON.stringify({ revision: snapshot.revision, offset: nextOffset })).toString('base64url')
    : null
  return {
    revision: snapshot.revision,
    sourceCommit: snapshot.sourceCommit,
    generatedAt: snapshot.generatedAt,
    categories: Object.freeze([...new Set(snapshot.entries.map(entry => entry.category))].sort()),
    stale: now - Date.parse(snapshot.generatedAt) > STALE_AFTER_MS,
    items,
    nextCursor,
    total: matches.length,
  }
}
