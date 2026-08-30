// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import axe from 'axe-core'
import type { PluginCatalogPage, PluginCatalogQuery } from '@deepseek-ai/dsh-api-remotes/client'
import { PluginMarket, type PluginMarketProps } from '../src/client/PluginMarket.tsx'
import { en, type PluginMarketLocaleKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); history.replaceState(null, '', '/') })
const t = ((key: PluginMarketLocaleKey): string => en[key]) as PluginMarketProps['t']
const PAGE: PluginCatalogPage = {
  revision: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), generatedAt: '2026-08-30T10:00:00.000Z', categories: ['documents', 'memory'], stale: false, total: 2, nextCursor: null,
  items: [
    { entryId: 'memory', ownerName: 'example/dsh-memory', repositoryUrl: 'https://github.com/example/dsh-memory', category: 'memory', descriptions: { en: 'Project memory' }, packageName: 'dsh-memory', installability: 'catalog_candidate' },
    { entryId: 'pdf', ownerName: 'example/dsh-pdf', repositoryUrl: 'https://github.com/example/dsh-pdf', category: 'documents', descriptions: { en: 'PDF reader' }, declaredTarballUrl: 'https://github.com/example/dsh-pdf/releases/download/v1/a.tgz', installability: 'catalog_candidate' },
  ],
}
const props = (search: PluginMarketProps['search']): PluginMarketProps => ({ t, search }) as PluginMarketProps

describe('PluginMarket', () => {
  it('has no critical automated accessibility violations', async () => {
    const search = vi.fn(async () => PAGE)
    render(<PluginMarket {...props(search)} />)
    await screen.findByText('example/dsh-memory')

    const result = await axe.run(document.body)
    expect(result.violations.filter(violation => violation.impact === 'critical')).toEqual([])
  })

  it('restores URL filters, queries the Remote, and keeps state in the URL', async () => {
    history.replaceState(null, '', '/?keep=1&plugin_query=memory&plugin_source=github&plugin_sort=name')
    const search = vi.fn(async () => PAGE)
    render(<PluginMarket {...props(search)} />)
    await screen.findByText('example/dsh-memory')
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'memory', sourceKinds: ['github'], sort: 'name' }))
    fireEvent.change(screen.getByTestId('plugin-market-search'), { target: { value: 'pdf' } })
    await waitFor(() => { expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'pdf' })) })
    expect(location.search).toContain('keep=1')
    expect(location.search).toContain('plugin_query=pdf')
  })

  it('combines filters and renders a keyboard-accessible read-only detail drawer', async () => {
    const search = vi.fn(async () => PAGE)
    render(<PluginMarket {...props(search)} />)
    await screen.findByText('example/dsh-memory')
    fireEvent.change(screen.getByTestId('plugin-market-category'), { target: { value: 'memory' } })
    fireEvent.change(screen.getByTestId('plugin-market-source'), { target: { value: 'npm' } })
    fireEvent.click(screen.getByTestId('plugin-market-prebuilt'))
    fireEvent.click(screen.getByTestId('plugin-market-installed'))
    await waitFor(() => {
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
        categories: ['memory'], sourceKinds: ['npm'], distributions: ['prebuilt'], installed: 'yes',
      }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'example/dsh-memory' }))
    expect(screen.getByRole('dialog', { name: 'example/dsh-memory' })).toBeTruthy()
    expect(screen.getByText(en.unavailable)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('plugin-market-close'))
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'https://github.com/example/dsh-memory' }))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByTestId('plugin-market-close'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'example/dsh-memory' }))
  })

  it('restores a detail deep link even when the entry is outside the current page', async () => {
    const target = { ...PAGE.items[0]!, entryId: '3'.repeat(32), ownerName: 'Session Lens' }
    history.replaceState(null, '', `/?plugin_entry=${target.entryId}`)
    const search = vi.fn(async (query: PluginCatalogQuery): Promise<PluginCatalogPage> => {
      return query.entryId
        ? { ...PAGE, total: 1, items: [target] }
        : { ...PAGE, total: 1, items: [PAGE.items[1]!] }
    })
    render(<PluginMarket {...props(search)} />)

    expect(await screen.findByRole('dialog', { name: 'Session Lens' })).toBeTruthy()
    expect(search).toHaveBeenCalledWith({ entryId: target.entryId, limit: 1 })
  })

  it('moves forward and back with revision-bound cursors', async () => {
    const first = { ...PAGE, total: 3, items: [PAGE.items[0]!], nextCursor: 'next-page' }
    const second = { ...PAGE, total: 3, items: [PAGE.items[1]!], nextCursor: null }
    const search = vi.fn(async (query: PluginCatalogQuery): Promise<PluginCatalogPage> => {
      return query.cursor === 'next-page' ? second : first
    })
    render(<PluginMarket {...props(search)} />)
    await screen.findByText('example/dsh-memory')

    fireEvent.click(screen.getByTestId('plugin-market-next'))
    await screen.findByText('example/dsh-pdf')
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' }))
    fireEvent.click(screen.getByTestId('plugin-market-previous'))
    await screen.findByText('example/dsh-memory')
    expect(search.mock.calls.at(-1)?.[0]).not.toHaveProperty('cursor')
  })

  it('returns to the first page when a snapshot switch invalidates the cursor', async () => {
    const first = { ...PAGE, items: [PAGE.items[0]!], nextCursor: 'old-revision' }
    const search = vi.fn<PluginMarketProps['search']>()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('invalid cursor'))
      .mockResolvedValueOnce({ ...PAGE, items: [PAGE.items[1]!], nextCursor: null })
    render(<PluginMarket {...props(search)} />)
    await screen.findByText('example/dsh-memory')
    fireEvent.click(screen.getByTestId('plugin-market-next'))

    await screen.findByText('example/dsh-pdf')
    expect(search.mock.calls.at(-1)?.[0]).not.toHaveProperty('cursor')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('contains failures, retries, and clears an empty result', async () => {
    const empty = { ...PAGE, total: 0, items: [] }
    const search = vi.fn<PluginMarketProps['search']>().mockRejectedValueOnce(new Error('private')).mockResolvedValue(empty)
    render(<PluginMarket {...props(search)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    fireEvent.click(screen.getByTestId('plugin-market-retry'))
    expect(await screen.findByText(en.empty)).toBeTruthy()
    fireEvent.click(screen.getByTestId('plugin-market-reset'))
    expect((screen.getByTestId('plugin-market-search') as HTMLInputElement).value).toBe('')
    const deferred = Promise.withResolvers<PluginCatalogPage>()
    const pending = render(<PluginMarket {...props(() => deferred.promise)} />)
    pending.unmount()
    await act(async () => { deferred.resolve(PAGE) })
  })
})
