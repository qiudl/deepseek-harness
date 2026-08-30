// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, NS } from '../src/client/index.ts'
import { PluginMarket, type PluginMarketInjected } from '../src/client/PluginMarket.tsx'

afterEach(cleanup)
async function bench() {
  const ctx = new Context(); await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx); locale.setLocale('zh'); ctx.provide('locale', locale)
  class RemoteService extends Service { constructor(inner: Context) { super(inner, 'remote') } }
  new RemoteService(ctx)
  const search = vi.fn().mockResolvedValue({ ok: true, value: { revision: 'f'.repeat(64), sourceCommit: 'a'.repeat(40), generatedAt: new Date().toISOString(), categories: [], stale: false, items: [], nextCursor: null, total: 0 } })
  ctx.provide('remote.pluginCatalogGateway', { search })
  return { ctx, slots: ctx.slots, search }
}

describe('plugin market Cordis client plugin', () => {
  it('registers one lazy localized market tab through the settings slot', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginCatalogGateway'])
    const b = await bench()
    b.slots.register({ name: 'root', children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = b.ctx.plugin({ inject: [...inject], apply }); await fiber.await()
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(PluginMarket)
    expect(entry.options).toMatchObject({ id: 'market', order: 5 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('插件市场')
    expect(b.search).not.toHaveBeenCalled()
    const injected = (entry.inject as unknown as () => PluginMarketInjected)()
    await injected.search({ limit: 20 })
    expect(b.search).toHaveBeenCalledWith({ limit: 20 })
    await fiber.dispose()
  })
})
