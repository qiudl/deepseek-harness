/** Slark Desktop Hub navigation entry, gated by the active DSH Profile bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { desktopExtensionBridge } from './bridge.ts'
import { ExtensionCenterFooterAction } from './ExtensionCenterFooterAction.tsx'
import { HubBackingPanel } from './HubBackingPanel.tsx'
import { en, zh, type ExtensionCenterLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Desktop Hub entry. */
    extensionCenter: ExtensionCenterLocaleKey
  }
}

export const inject = ['slots', 'locale', 'layout']
/** Locale namespace for the Desktop Hub navigation entry. */
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
      const select = (): void => { ctx.layout.selectPanel(PANEL_ID) }
      const hide = (): void => { void bridge.hideHub() }
      disposers.push(
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ hide }),
        }, HubBackingPanel)),
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'extensions',
          order: 10,
          locale: NS,
          inject: () => ({
            open: () => {
              select()
              void bridge.showHub().then((opened) => {
                if (!opened.ok) ctx.layout.selectPanel(null)
              }).catch(() => { ctx.layout.selectPanel(null) })
            },
          }),
        }, ExtensionCenterFooterAction)),
        bridge.onOpen(select),
      )
    }).catch(() => { /* capability handshake fails closed */ })
    return () => {
      active = false
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'ui-extension-center: gated Desktop Hub entry')
}

export type { DesktopExtensionBridge } from './bridge.ts'
