import { createRoot } from 'react-dom/client'
import type { PluginCatalogEntry, PluginCatalogPage, PluginCatalogQuery } from '@deepseek-ai/dsh-api-remotes/client'
import { PluginMarket, type PluginMarketProps } from '../../../src/client/PluginMarket.tsx'
import { en } from '../../../src/client/locales.ts'

const entries: PluginCatalogEntry[] = [
  {
    entryId: '1'.repeat(32), ownerName: 'Session Lens', repositoryUrl: 'https://github.com/example/session-lens',
    category: 'memory', descriptions: { en: 'Search and inspect session memory.' }, packageName: 'session-lens',
    installability: 'catalog_candidate',
  },
  {
    entryId: '2'.repeat(32), ownerName: 'example/dsh-terminal', repositoryUrl: 'https://github.com/example/dsh-terminal',
    category: 'ui', descriptions: { en: 'Terminal interface for DSH.' }, installability: 'catalog_candidate',
  },
]

async function search(query: PluginCatalogQuery): Promise<PluginCatalogPage> {
  const terms = (query.query?.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(term => term.length > 2 && !['need', 'plugin', 'find', 'for', 'the'].includes(term))
  const items = entries.filter((entry) => {
    const text = `${entry.ownerName} ${Object.values(entry.descriptions).join(' ')}`.toLowerCase()
    if (terms.length > 0 && !terms.some(term => text.includes(term))) return false
    if (query.categories?.length && !query.categories.includes(entry.category)) return false
    if (query.distributions?.includes('prebuilt') && entry.packageName === undefined && entry.declaredTarballUrl === undefined) return false
    if (query.installed === 'yes' && entry.packageName === undefined) return false
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  return {
    revision: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), generatedAt: new Date().toISOString(),
    categories: ['memory', 'ui'], stale: false, items, nextCursor: null, total: items.length,
  }
}

function t(key: keyof typeof en): string { return en[key] }

const root = document.getElementById('root')
if (root === null) throw new Error('missing browser fixture root')
createRoot(root).render(<PluginMarket {...({ search, t } as PluginMarketProps)}/>)
