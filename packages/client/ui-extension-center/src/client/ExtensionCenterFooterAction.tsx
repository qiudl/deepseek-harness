import { IconCordisPluginOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ReactNode } from 'react'
import css from './ExtensionCenterFooterAction.module.css'

export interface ExtensionCenterFooterActionInjected {
  readonly open: () => void
}

export type ExtensionCenterFooterActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & SidebarFooterActionOwnerProps
  & PropsLocale<'extensionCenter'>
  & InjectFace<ExtensionCenterFooterActionInjected>

/** Sidebar row immediately above Settings. */
export function ExtensionCenterFooterAction({ wide, open, t }: ExtensionCenterFooterActionProps): ReactNode {
  const label = t('title')
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={wide ? css.action : `${css.action} ${css.rail}`}
        aria-label={label}
        data-testid="extension-center-open"
        onClick={open}
      >
        <IconCordisPluginOutline14 size={wide ? 16 : 18} />
        {wide && <span>{label}</span>}
      </button>
    </Tooltip>
  )
}
