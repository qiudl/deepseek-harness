import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PluginCatalogEntry, PluginCatalogPage, PluginCatalogQuery } from '@deepseek-ai/dsh-api-remotes/client'
import { IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginMarket.module.css'

export interface PluginMarketInjected { search: (query: PluginCatalogQuery) => Promise<PluginCatalogPage> }
export type PluginMarketProps = PropsRuntime<'settings.plugins.tab'> & PropsLocale<'settings.pluginMarket'> & InjectFace<PluginMarketInjected>
type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; page: PluginCatalogPage }

const URL_KEYS = ['plugin_query', 'plugin_category', 'plugin_source', 'plugin_prebuilt', 'plugin_installed', 'plugin_sort', 'plugin_entry'] as const
function initialParam(name: typeof URL_KEYS[number]): string { return new URLSearchParams(globalThis.location.search).get(name) ?? '' }
function description(entry: PluginCatalogEntry): string { return entry.descriptions.zh ?? entry.descriptions.en ?? '' }
function sourceKind(entry: PluginCatalogEntry): 'github' | 'npm' | 'tarball' {
  return entry.packageName !== undefined ? 'npm' : entry.declaredTarballUrl === undefined ? 'github' : 'tarball'
}
function monogram(entry: PluginCatalogEntry): string { return (entry.ownerName.split('/').at(-1) ?? entry.ownerName).slice(0, 3).toUpperCase() }

export function PluginMarket({ search, t }: PluginMarketProps): ReactNode {
  const [query, setQuery] = useState(() => initialParam('plugin_query'))
  const [category, setCategory] = useState(() => initialParam('plugin_category'))
  const [source, setSource] = useState<'github' | 'npm' | 'tarball' | ''>(() => {
    const value = initialParam('plugin_source'); return value === 'github' || value === 'npm' || value === 'tarball' ? value : ''
  })
  const [installedOnly, setInstalledOnly] = useState(() => initialParam('plugin_installed') === 'yes')
  const [prebuiltOnly, setPrebuiltOnly] = useState(() => initialParam('plugin_prebuilt') === 'yes')
  const [sort, setSort] = useState<'relevance' | 'name'>(() => initialParam('plugin_sort') === 'name' ? 'name' : 'relevance')
  const [cursor, setCursor] = useState<string | undefined>()
  const [previous, setPrevious] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(() => initialParam('plugin_entry') || null)
  const [deepLinkedEntry, setDeepLinkedEntry] = useState<PluginCatalogEntry | null>(null)
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<State>({ status: 'loading' })
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  const intent = useMemo<PluginCatalogQuery>(() => ({
    ...(query.trim() === '' ? {} : { query: query.trim() }),
    ...(category === '' ? {} : { categories: [category] }),
    ...(source === '' ? {} : { sourceKinds: [source] }),
    ...(prebuiltOnly ? { distributions: ['prebuilt'] as const } : {}),
    installed: installedOnly ? 'yes' : 'any', sort, limit: 20, ...(cursor === undefined ? {} : { cursor }),
  }), [category, cursor, installedOnly, prebuiltOnly, query, sort, source])

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void Promise.resolve().then(() => search(intent)).then(
      (page) => { if (current) setState({ status: 'ready', page }) },
      () => {
        if (!current) return
        if (cursor !== undefined) {
          setCursor(undefined)
          setPrevious([])
        } else {
          setState({ status: 'error' })
        }
      },
    )
    return () => { current = false }
  }, [intent, request, search])

  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search)
    for (const key of URL_KEYS) params.delete(key)
    if (query.trim()) params.set('plugin_query', query.trim())
    if (category) params.set('plugin_category', category)
    if (source) params.set('plugin_source', source)
    if (prebuiltOnly) params.set('plugin_prebuilt', 'yes')
    if (installedOnly) params.set('plugin_installed', 'yes')
    if (sort === 'name') params.set('plugin_sort', 'name')
    if (selected) params.set('plugin_entry', selected)
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${suffix}${globalThis.location.hash}`)
  }, [category, installedOnly, prebuiltOnly, query, selected, sort, source])

  const page = state.status === 'ready' ? state.page : undefined
  const categories = page?.categories ?? []
  const selectedEntry = page?.items.find(item => item.entryId === selected)
    ?? (deepLinkedEntry?.entryId === selected ? deepLinkedEntry : undefined)
  useEffect(() => {
    let current = true
    if (deepLinkedEntry?.entryId === selected) return () => { current = false }
    if (selected === null || page?.items.some(item => item.entryId === selected)) {
      setDeepLinkedEntry(null)
      return () => { current = false }
    }
    void search({ entryId: selected, limit: 1 }).then(
      (detail) => { if (current) setDeepLinkedEntry(detail.items[0] ?? null) },
      () => { if (current) setDeepLinkedEntry(null) },
    )
    return () => { current = false }
  }, [deepLinkedEntry, page?.items, search, selected])
  useEffect(() => { if (selectedEntry && closeRef.current) closeRef.current.focus() }, [selectedEntry])
  const closeDetail = (): void => {
    setSelected(null)
    setDeepLinkedEntry(null)
    if (returnFocus.current) returnFocus.current.focus()
    returnFocus.current = null
  }
  useEffect(() => {
    if (!selectedEntry) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeDetail()
        return
      }
      if (event.key !== 'Tab') return
      const drawer = closeRef.current?.closest('[role="dialog"]')
      const focusable = drawer?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [selectedEntry])
  const reset = (): void => { setQuery(''); setCategory(''); setSource(''); setPrebuiltOnly(false); setInstalledOnly(false); setSort('relevance'); setCursor(undefined); setPrevious([]) }

  return <section className={css.market} aria-busy={state.status === 'loading'} data-testid="plugin-market">
    <header className={css.hero}><span className={css.kicker}>awesome-dsh-plugin · read only</span><h2>{t('title')}</h2><p>{t('subtitle')}</p></header>
    <div className={css.controls}>
      <label className={css.search}><IconSearchOutline16 aria-hidden="true"/><span className={css.visuallyHidden}>{t('search')}</span><input data-testid="plugin-market-search" type="search" value={query} placeholder={t('search')} onChange={(event) => { setQuery(event.currentTarget.value); setCursor(undefined); setPrevious([]) }}/></label>
      <label>{t('category')}<select data-testid="plugin-market-category" value={category} onChange={(event) => { setCategory(event.currentTarget.value); setCursor(undefined); setPrevious([]) }}><option value="">{t('all')}</option>{categories.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
      <label>{t('source')}<select data-testid="plugin-market-source" value={source} onChange={(event) => { setSource(event.currentTarget.value as typeof source); setCursor(undefined); setPrevious([]) }}><option value="">{t('all')}</option><option value="github">{t('github')}</option><option value="npm">{t('npm')}</option><option value="tarball">{t('tarball')}</option></select></label>
      <label className={css.check}><input data-testid="plugin-market-installed" type="checkbox" checked={installedOnly} onChange={(event) => { setInstalledOnly(event.currentTarget.checked); setCursor(undefined); setPrevious([]) }}/>{t('installed')}</label>
      <label className={css.check} title={t('prebuiltHint')}><input data-testid="plugin-market-prebuilt" type="checkbox" checked={prebuiltOnly} onChange={(event) => { setPrebuiltOnly(event.currentTarget.checked); setCursor(undefined); setPrevious([]) }}/>{t('prebuilt')}</label>
      <select data-testid="plugin-market-sort" aria-label={t('relevance')} value={sort} onChange={(event) => { setSort(event.currentTarget.value as typeof sort); setCursor(undefined); setPrevious([]) }}><option value="relevance">{t('relevance')}</option><option value="name">{t('name')}</option></select>
    </div>
    {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
    {state.status === 'error' ? <div className={css.status}><p role="alert">{t('error')}</p><button data-testid="plugin-market-retry" type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div> : null}
    {page ? <><div className={css.summary}><strong>{page.total}</strong> {t('results')}<span data-stale={page.stale}>{page.stale ? t('stale') : t('current')}</span></div>
      {page.items.length === 0 ? <div className={css.empty}><h3>{t('empty')}</h3><p>{t('emptyHint')}</p><button data-testid="plugin-market-reset" type="button" onClick={reset}>{t('reset')}</button></div> : <ul className={css.list}>{page.items.map(entry => <li key={entry.entryId} className={css.card} data-testid={`plugin-market-card-${entry.entryId}`}><div className={css.monogram}>{monogram(entry)}</div><div className={css.cardBody}><div className={css.cardTitle}><button type="button" onClick={(event) => { returnFocus.current = event.currentTarget; setSelected(entry.entryId) }}>{entry.ownerName}</button><span>{t('candidate')}</span></div><p>{description(entry)}</p><div className={css.tags}><span>{entry.category}</span><span>{t(sourceKind(entry))}</span></div></div></li>)}</ul>}
      <nav className={css.pagination} aria-label="pagination"><button data-testid="plugin-market-previous" type="button" disabled={previous.length === 0} onClick={() => { const copy = previous.slice(); const prior = copy.pop(); setPrevious(copy); setCursor(prior || undefined) }}>{t('previous')}</button><button data-testid="plugin-market-next" type="button" disabled={page.nextCursor === null} onClick={() => { setPrevious(values => [...values, cursor ?? '']); setCursor(state.status === 'ready' ? state.page.nextCursor ?? undefined : undefined) }}>{t('next')}</button></nav>
    </> : null}
    {selectedEntry ? <div className={css.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDetail() }}><aside className={css.drawer} role="dialog" aria-modal="true" aria-labelledby="plugin-market-detail-title"><button ref={closeRef} data-testid="plugin-market-close" className={css.close} type="button" aria-label={t('close')} onClick={closeDetail}>×</button><span className={css.kicker}>{t('candidate')}</span><h2 id="plugin-market-detail-title">{selectedEntry.ownerName}</h2><p>{description(selectedEntry)}</p><dl><div><dt>{t('sourceLabel')}</dt><dd><a href={selectedEntry.repositoryUrl} target="_blank" rel="noreferrer">{selectedEntry.repositoryUrl}</a></dd></div><div><dt>{t('revision')}</dt><dd><code>{page?.revision}</code></dd></div></dl><p className={css.notice}>{t('unavailable')}</p></aside></div> : null}
  </section>
}
