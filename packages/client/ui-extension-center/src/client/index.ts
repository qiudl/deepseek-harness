/** Slark Desktop Hub navigation entry, gated by the active DSH Profile bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { desktopExtensionBridge } from './bridge.ts'
import { ExtensionCenterFooterAction } from './ExtensionCenterFooterAction.tsx'
import { en, zh, type ExtensionCenterLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Desktop Hub entry. */
    extensionCenter: ExtensionCenterLocaleKey
  }
}

export const inject = ['slots', 'locale']
export const NS = 'extensionCenter'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-extension-center: dictionaries')
  const bridge = desktopExtensionBridge()
  if (bridge === undefined) return

  ctx.effect(() => {
    let active = true
    let dispose: (() => void) | undefined
    void bridge.hello().then((result) => {
      if (!active || !result.ok || result.value.protocol !== 1) return
      dispose = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'extensions',
        order: 10,
        locale: NS,
        inject: () => ({ open: () => { void bridge.showHub() } }),
      }, ExtensionCenterFooterAction))
    }).catch(() => { /* capability handshake fails closed */ })
    return () => {
      active = false
      dispose?.()
    }
  }, 'ui-extension-center: gated Desktop Hub entry')
}

export type { DesktopExtensionBridge } from './bridge.ts'
