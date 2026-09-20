import { useEffect, useId, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DesktopExtensionBridge, ExtensionEntry, ExtensionKind, ExtensionProfile,
} from './bridge.ts'
import type { ExtensionCenterLocaleKey } from './locales.ts'
import css from './ExtensionCenterPanel.module.css'

export interface ExtensionCenterPanelInjected {
  readonly bridge: DesktopExtensionBridge
  readonly profile: ExtensionProfile
}

export type ExtensionCenterPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'extensionCenter'>
  & InjectFace<ExtensionCenterPanelInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly entries: readonly ExtensionEntry[] }

type InstallPlan = {
  readonly planId: string
  readonly scripts?: readonly { readonly name: string; readonly command: string }[]
  readonly scriptDigest?: string
}
type OperationState = {
  readonly operationId: string
  readonly outcome: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly reason?: string
}

const TABS = [
  { kind: 'plugin', label: 'tabPlugin', empty: 'emptyPlugin' },
  { kind: 'mcp', label: 'tabMcp', empty: 'emptyMcp' },
  { kind: 'skill', label: 'tabSkill', empty: 'emptySkill' },
] as const satisfies readonly {
  kind: ExtensionKind
  label: ExtensionCenterLocaleKey
  empty: ExtensionCenterLocaleKey
}[]

function storageKey(profile: ExtensionProfile): string {
  return `dsh:extension-center:tab:${profile.key}`
}

function operationStorageKey(profile: ExtensionProfile): string {
  return `dsh:extension-center:operation:${profile.key}`
}

function rememberedTab(profile: ExtensionProfile): ExtensionKind {
  try {
    const stored = window.localStorage.getItem(storageKey(profile))
    return TABS.some(tab => tab.kind === stored) ? stored as ExtensionKind : 'plugin'
  } catch {
    return 'plugin'
  }
}

/** Root main panel for the current active DSH Profile. */
export function ExtensionCenterPanel({ bridge, profile, t }: ExtensionCenterPanelProps) {
  const tabId = useId()
  const [kind, setKind] = useState<ExtensionKind>(() => rememberedTab(profile))
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [packageName, setPackageName] = useState('')
  const [source, setSource] = useState('')
  const [pluginAction, setPluginAction] = useState<'install' | 'update'>('install')
  const [preparing, setPreparing] = useState(false)
  const [installError, setInstallError] = useState<string>()
  const [plan, setPlan] = useState<InstallPlan>()
  const [operation, setOperation] = useState<OperationState | undefined>(() => {
    try {
      const id = window.localStorage.getItem(operationStorageKey(profile))
      return id ? { operationId: id, outcome: 'running' } : undefined
    } catch { return undefined }
  })

  useEffect(() => {
    try { window.localStorage.setItem(storageKey(profile), kind) } catch { /* presentation preference only */ }
  }, [kind, profile])

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void bridge.list(kind).then(
      (result) => {
        if (!current) return
        setState(result.ok ? { status: 'ready', entries: result.value.entries } : { status: 'error' })
      },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [bridge, kind, request])

  useEffect(() => {
    if (!operation || !['queued', 'running'].includes(operation.outcome)) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      void bridge.status(operation.operationId).then((result) => {
        if (!current) return
        if (!result.ok) {
          timer = setTimeout(poll, 1000)
          return
        }
        const next = result.value
        setOperation(next)
        if (next.outcome === 'queued' || next.outcome === 'running') timer = setTimeout(poll, 750)
        else if (next.outcome === 'succeeded') setRequest(value => value + 1)
      }, () => { if (current) timer = setTimeout(poll, 1000) })
    }
    poll()
    return () => { current = false; if (timer) clearTimeout(timer) }
  }, [bridge, operation?.operationId, operation?.outcome])

  const prepareInstall = () => {
    if (!packageName.trim() || !source.trim()) { setInstallError(t('invalidInstall')); return }
    setPreparing(true); setInstallError(undefined); setPlan(undefined)
    void bridge.prepare('plugin', JSON.stringify({ ...(pluginAction === 'update' ? { action: 'update' } : {}),
      packageName: packageName.trim(), spec: source.trim() })).then((result) => {
      setPreparing(false)
      if (!result.ok) { setInstallError(result.error.message); return }
      setPlan({ planId: result.value.planId,
        ...(result.value.scripts ? { scripts: result.value.scripts } : {}),
        ...(result.value.scriptDigest ? { scriptDigest: result.value.scriptDigest } : {}) })
    }, () => { setPreparing(false); setInstallError(t('operationFailed')) })
  }

  const commitInstall = () => {
    if (!plan) return
    setPreparing(true); setInstallError(undefined)
    void bridge.commit(plan.planId, plan.scriptDigest).then((result) => {
      setPreparing(false)
      if (!result.ok) { setInstallError(result.error.message); return }
      const next = result.value
      setOperation(next)
      try { window.localStorage.setItem(operationStorageKey(profile), next.operationId) } catch { /* reconnect hint only */ }
      setPlan(undefined)
    }, () => { setPreparing(false); setInstallError(t('operationFailed')) })
  }

  const selected = TABS.find(tab => tab.kind === kind) ?? TABS[0]
  return (
    <main className={css.root} data-testid="extension-center-panel">
      <header className={css.header}>
        <div>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <div className={css.profile} aria-label={t('profileLabel')}>
          <span>{t('profileLabel')}</span>
          <strong>{profile.label}</strong>
        </div>
      </header>

      <div className={css.tabs} role="tablist" aria-label={t('title')}>
        {TABS.map(tab => (
          <button
            key={tab.kind}
            id={`${tabId}-${tab.kind}`}
            type="button"
            role="tab"
            aria-selected={kind === tab.kind}
            aria-controls={`${tabId}-panel`}
            data-testid={`extension-center-tab-${tab.kind}`}
            onClick={() => { setKind(tab.kind) }}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      <section
        id={`${tabId}-panel`}
        className={css.content}
        role="tabpanel"
        aria-labelledby={`${tabId}-${kind}`}
      >
        {kind === 'plugin' && (
          <div className={css.installer} data-testid="plugin-installer">
            <h2>{t('installTitle')}</h2>
            <div className={css.installFields}>
              <label>{t('operationType')}<select value={pluginAction}
                onChange={(event) => { setPluginAction(event.currentTarget.value as 'install' | 'update') }}>
                <option value="install">{t('installAction')}</option>
                <option value="update">{t('updateAction')}</option>
              </select></label>
              <label>{t('packageName')}<input value={packageName} placeholder={t('packageNamePlaceholder')}
                onChange={(event) => { setPackageName(event.currentTarget.value) }} /></label>
              <label>{t('packageSource')}<input value={source} placeholder={t('packageSourcePlaceholder')}
                onChange={(event) => { setSource(event.currentTarget.value) }} /></label>
              <button type="button" disabled={preparing || !!plan} onClick={prepareInstall}>
                {t(preparing ? 'preparing' : 'prepareInstall')}
              </button>
            </div>
            {installError && <p className={css.installError} role="alert">{installError}</p>}
            {plan && (
              <div className={css.confirmation}>
                {plan.scripts && <><strong>{t('scriptsWarning')}</strong><ul>{plan.scripts.map(script => (
                  <li key={script.name}><code>{script.name}</code><code>{script.command}</code></li>
                ))}</ul></>}
                <button type="button" disabled={preparing} onClick={commitInstall}>
                  {t(plan.scripts ? 'confirmScripts' : 'confirmInstall')}
                </button>
              </div>
            )}
            {operation && <p className={css.operation} data-outcome={operation.outcome}>{t(
              operation.outcome === 'succeeded' ? 'operationSucceeded'
                : operation.outcome === 'unknown' ? 'operationUnknown'
                  : operation.outcome === 'failed' || operation.outcome === 'cancelled' ? 'operationFailed'
                    : 'operationQueued')}</p>}
          </div>
        )}
        {state.status === 'loading' && <p className={css.status}>{t('loading')}</p>}
        {state.status === 'error' && (
          <div className={css.error} role="alert">
            <p>{t('loadError')}</p>
            <button type="button" data-testid="extension-center-retry" onClick={() => { setRequest(value => value + 1) }}>
              {t('retry')}
            </button>
          </div>
        )}
        {state.status === 'ready' && state.entries.length === 0 && (
          <div className={css.empty}>
            <span aria-hidden="true">◇</span>
            <p>{t(selected.empty)}</p>
          </div>
        )}
        {state.status === 'ready' && state.entries.length > 0 && (
          <ul className={css.cards}>
            {state.entries.map(entry => (
              <li key={entry.id} className={css.card} data-extension-id={entry.id}>
                <div className={css.cardHeading}>
                  <strong>{entry.name}</strong>
                  {entry.version !== undefined && <code>{entry.version}</code>}
                </div>
                {entry.description !== undefined && <p>{entry.description}</p>}
                {entry.enabled !== undefined && (
                  <span className={entry.enabled ? css.enabled : css.disabled}>
                    {t(entry.enabled ? 'enabled' : 'disabled')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
