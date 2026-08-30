/** Client-safe BFF projection of plugin catalog query payloads. */

export interface PluginCatalogQuery {
  entryId?: string
  query?: string
  categories?: readonly string[]
  sourceKinds?: readonly ('github' | 'npm' | 'tarball')[]
  distributions?: readonly ('prebuilt' | 'source')[]
  installed?: 'any' | 'yes' | 'no'
  sort?: 'relevance' | 'name'
  cursor?: string
  limit?: number
}

export interface PluginCatalogEntry {
  entryId: string
  ownerName: string
  repositoryUrl: string
  category: string
  descriptions: Readonly<{ zh?: string; en?: string }>
  declaredTarballUrl?: string
  packageName?: string
  installability: 'catalog_candidate'
}

export interface PluginCatalogPage {
  revision: string
  sourceCommit: string
  generatedAt: string
  categories: readonly string[]
  stale: boolean
  items: readonly PluginCatalogEntry[]
  nextCursor: string | null
  total: number
}
