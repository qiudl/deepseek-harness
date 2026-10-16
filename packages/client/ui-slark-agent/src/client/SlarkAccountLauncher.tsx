/** Current Slark identity beside the shell-owned Settings action. */
import { useEffect, useState } from 'react'
import { IconSettingsOutlineMedium, IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './SlarkAccountLauncher.module.css'

/** Display-only account data; contains no credentials or authority identifiers. */
export interface SlarkAccountIdentity { name: string; avatarUrl: string | null }
/** Root-owned identity source and refresh command for the account-bound carrier. */
export interface SlarkAccountInjected {
  hooks: { slarkAccount: ObservableSnapshot<SlarkAccountIdentity | null> }
  refreshAccount(): Promise<void>
}
type Props = PropsRuntime<'settings.launcher'> & PropsLocale<'slarkAgent'> & InjectFace<SlarkAccountInjected>

/** Render the account name and picture with Settings at the right edge.
 * @param props - Framework account source, refresh command and shell-owned Settings action.
 * @returns Sidebar identity row, with an icon fallback when the picture cannot load.
 */
export function SlarkAccountLauncher({ wide, openSettings, settingsOpen, settingsShortcut, useSlarkAccount, refreshAccount, t }: Props) {
  const account = useSlarkAccount(value => value)
  const [failedUrl, setFailedUrl] = useState<string>()
  useEffect(() => { void refreshAccount() }, [refreshAccount])
  return <div className={css.row} data-collapsed={!wide} data-testid="slark-account-row">
    {wide && <><span className={css.avatar} aria-hidden="true">
      {account?.avatarUrl && account.avatarUrl !== failedUrl
        ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => { setFailedUrl(account.avatarUrl ?? undefined) }} />
        : <IconUserOutlineMedium size={16} />}
    </span><span className={css.identity}><strong>{account?.name ?? t('account.unavailable')}</strong><small>{t('account.profile')}</small></span></>}
    <button type="button" className={css.settings} data-testid="slark-account-settings" aria-label={t('account.settings')}
      aria-keyshortcuts={settingsShortcut?.aria} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={openSettings}>
      <IconSettingsOutlineMedium size={18} />
    </button>
  </div>
}
