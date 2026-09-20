/** DSH-native Extension Center, gated by the active Slark DSH Profile bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { desktopExtensionBridge } from './bridge.ts'
import { ExtensionCenterFooterAction } from './ExtensionCenterFooterAction.tsx'
import { ExtensionCenterPanel } from './ExtensionCenterPanel.tsx'
import { en, zh, type ExtensionCenterLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the DSH-native Extension Center. */
    extensionCenter: ExtensionCenterLocaleKey
  }
}

export const inject = ['slots', 'locale', 'layout']
export const NS = 'extensionCenter'
const PANEL_ID = 'extensions' as MainPanelId

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-extension-center: dictionaries')
  const bridge = desktopExtensionBridge()
  if (bridge === undefined) return

  ctx.effect(() => {
    let active = true
    const disposers: (() => void)[] = []
    void bridge.hello().then((result) => {
      if (!active || !result.ok || result.value.protocol !== 1) return
      const profile = result.value.profile
      disposers.push(
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ bridge, profile }),
        }, ExtensionCenterPanel)),
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'extensions',
          order: 10,
          locale: NS,
          inject: () => ({ open: () => { ctx.layout.selectPanel(PANEL_ID) } }),
        }, ExtensionCenterFooterAction)),
        bridge.onOpen(() => { ctx.layout.selectPanel(PANEL_ID) }),
      )
    }).catch(() => { /* capability handshake fails closed */ })
    return () => {
      active = false
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'ui-extension-center: gated desktop surfaces')
}

export type { DesktopExtensionBridge, ExtensionKind } from './bridge.ts'
