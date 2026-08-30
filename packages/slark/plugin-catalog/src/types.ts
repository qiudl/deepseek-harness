/** Client-safe JSON vocabulary for the validated Slark plugin catalog. */

/** One source file in an upstream catalog revision. */
export interface CatalogSourceFile {
  path: string
  content: string
}

/** Inputs required to build one catalog snapshot. */
export interface CatalogSnapshotInput {
  sourceCommit: string
  generatedAt: string
  files: readonly CatalogSourceFile[]
  /** Optional registry-derived package names, verified against repository URLs. */
  packages?: readonly CatalogPackageMapping[]
}

export interface CatalogPackageMapping { repositoryUrl: string; packageName: string }

/** A normalized install candidate from one catalog revision. */
export interface CatalogEntryV1 {
  entryId: string
  ownerName: string
  repositoryUrl: string
  category: string
  descriptions: Readonly<{ zh?: string; en?: string }>
  declaredTarballUrl?: string
  packageName?: string
  installability: 'catalog_candidate'
}

/** An immutable catalog snapshot. */
export interface CatalogSnapshotV1 {
  revision: string
  sourceCommit: string
  generatedAt: string
  entries: readonly CatalogEntryV1[]
}

/** Deterministic catalog query filters. */
export interface CatalogQueryV1 {
  entryId?: string
  query?: string
  categories?: readonly string[]
  sourceKinds?: readonly ('github' | 'npm' | 'tarball')[]
  distributions?: readonly ('prebuilt' | 'source')[]
  installed?: 'any' | 'yes' | 'no'
  installedEntryIds?: readonly string[]
  sort?: 'relevance' | 'name'
  cursor?: string
  limit?: number
}

/** One page from an explicit catalog revision. */
export interface CatalogQueryResultV1 {
  revision: string
  sourceCommit: string
  generatedAt: string
  categories: readonly string[]
  stale: boolean
  items: readonly CatalogEntryV1[]
  nextCursor: string | null
  total: number
}
