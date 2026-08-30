/** Cordis client plugin registering the plugin market into the Plugins settings section. */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PluginMarket, type PluginMarketInjected } from './PluginMarket.tsx'
import { en, zh, type PluginMarketLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.pluginMarket': PluginMarketLocaleKey }
}

export const NS = 'settings.pluginMarket'
export const inject = ['slots', 'locale', 'remote', 'remote.pluginCatalogGateway']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-market: dictionaries')
  const t = ctx.locale.bind(NS)
  const search: PluginMarketInjected['search'] = async (query) => {
    const result = await ctx.remote.pluginCatalogGateway.search(query)
    if (!result.ok) throw new Error(`pluginCatalogGateway.search failed: ${result.error.code}`)
    return result.value
  }
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: 'market', order: 5, label: () => t('tab'), locale: NS,
    inject: (): PluginMarketInjected => ({ search }),
  }, PluginMarket))
}
