// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCenterPanel } from '../src/client/ExtensionCenterPanel.tsx'
import { ExtensionCenterFooterAction } from '../src/client/ExtensionCenterFooterAction.tsx'
import type { ExtensionCenterFooterActionProps } from '../src/client/ExtensionCenterFooterAction.tsx'
import type { ExtensionCenterPanelProps } from '../src/client/ExtensionCenterPanel.tsx'
import { en, type ExtensionCenterLocaleKey } from '../src/client/locales.ts'
import type { DesktopExtensionBridge, ExtensionKind } from '../src/client/bridge.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const t = ((key: ExtensionCenterLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (copy, [name, value]) => copy.replaceAll(`{${name}}`, value),
    en[key],
  )) as ExtensionCenterPanelProps['t']

function bridge(list = vi.fn<DesktopExtensionBridge['list']>().mockResolvedValue({
  ok: true,
  value: { entries: [] },
})): DesktopExtensionBridge {
  return {
    hello: vi.fn().mockResolvedValue({
      ok: true,
      value: { protocol: 1, profile: { key: 'profile-a', label: 'Personal' } },
    }),
    list,
    prepare: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    commit: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    status: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    onOpen: vi.fn(() => () => {}),
  }
}

function props(value = bridge()): ExtensionCenterPanelProps {
  return {
    t,
    bridge: value,
    profile: { key: 'profile-a', label: 'Personal' },
  } as ExtensionCenterPanelProps
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function fillInstall(packageName = '@fixture/demo', source = '@fixture/demo@1.2.3'): void {
  fireEvent.change(screen.getByLabelText(en.packageName), { target: { value: packageName } })
  fireEvent.change(screen.getByLabelText(en.packageSource), { target: { value: source } })
}

describe('ExtensionCenterPanel', () => {
  it('opens on Plugins and remembers the last tab per Profile', async () => {
    const value = bridge()
    const first = render(<ExtensionCenterPanel {...props(value)} />)

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText('Personal')).toBeTruthy()
    expect(screen.getByRole('tab', { name: en.tabPlugin }).getAttribute('aria-selected')).toBe('true')
    await waitFor(() => { expect(value.list).toHaveBeenCalledWith('plugin') })

    fireEvent.click(screen.getByRole('tab', { name: en.tabMcp }))
    await waitFor(() => { expect(value.list).toHaveBeenCalledWith('mcp') })
    expect(window.localStorage.getItem('dsh:extension-center:tab:profile-a')).toBe('mcp')
    first.unmount()

    render(<ExtensionCenterPanel {...props(value)} />)
    expect(screen.getByRole('tab', { name: en.tabMcp }).getAttribute('aria-selected')).toBe('true')
  })

  it('renders inventory state and retries the active tab without changing tabs', async () => {
    const list = vi.fn<(kind: ExtensionKind) => ReturnType<DesktopExtensionBridge['list']>>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'host_unavailable', message: 'offline' } })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          entries: [{ id: 'pkg-a', name: 'Package A', version: '1.2.3', description: 'A useful plugin', enabled: true }],
        },
      })
    render(<ExtensionCenterPanel {...props(bridge(list))} />)

    expect((await screen.findByRole('alert')).textContent).toContain(en.loadError)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText('Package A')).toBeTruthy()
    expect(screen.getByText('1.2.3')).toBeTruthy()
    expect(screen.getByText(en.enabled)).toBeTruthy()
    expect(list).toHaveBeenNthCalledWith(2, 'plugin')
  })

  it('shows a kind-specific empty state', async () => {
    render(<ExtensionCenterPanel {...props()} />)
    expect(await screen.findByText(en.emptyPlugin)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en.tabSkill }))
    expect(await screen.findByText(en.emptySkill)).toBeTruthy()
  })

  it('falls back when saved preferences are invalid or unavailable', async () => {
    window.localStorage.setItem('dsh:extension-center:tab:profile-a', 'invalid')
    const first = render(<ExtensionCenterPanel {...props()} />)
    expect(screen.getByRole('tab', { name: en.tabPlugin }).getAttribute('aria-selected')).toBe('true')
    first.unmount()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied') })
    render(<ExtensionCenterPanel {...props()} />)
    expect(await screen.findByText(en.emptyPlugin)).toBeTruthy()
  })

  it('ignores stale inventory completions and handles rejected reads', async () => {
    const plugin = deferred<Awaited<ReturnType<DesktopExtensionBridge['list']>>>()
    const mcp = deferred<Awaited<ReturnType<DesktopExtensionBridge['list']>>>()
    const list = vi.fn<DesktopExtensionBridge['list']>()
      .mockReturnValueOnce(plugin.promise)
      .mockReturnValueOnce(mcp.promise)
    render(<ExtensionCenterPanel {...props(bridge(list))} />)
    fireEvent.click(screen.getByRole('tab', { name: en.tabMcp }))
    await act(async () => { plugin.resolve({ ok: true, value: { entries: [{ id: 'stale', name: 'Stale' }] } }); await plugin.promise })
    expect(screen.queryByText('Stale')).toBeNull()
    await act(async () => { mcp.reject(new Error('offline')); try { await mcp.promise } catch {} })
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('ignores an inventory rejection after unmount', async () => {
    const pending = deferred<Awaited<ReturnType<DesktopExtensionBridge['list']>>>()
    const value = bridge(vi.fn<DesktopExtensionBridge['list']>().mockReturnValue(pending.promise))
    const view = render(<ExtensionCenterPanel {...props(value)} />)
    view.unmount()
    await act(async () => { pending.reject(new Error('late')); try { await pending.promise } catch {} })
  })

  it('validates install fields and reports prepare failures', async () => {
    const value = bridge()
    render(<ExtensionCenterPanel {...props(value)} />)
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect(screen.getByRole('alert').textContent).toBe(en.invalidInstall)
    fireEvent.change(screen.getByLabelText(en.packageName), { target: { value: '@fixture/demo' } })
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect(value.prepare).not.toHaveBeenCalled()

    fillInstall()
    vi.mocked(value.prepare).mockResolvedValueOnce({ ok: false, error: { code: 'denied', message: 'Denied' } })
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect((await screen.findByRole('alert')).textContent).toBe('Denied')

    vi.mocked(value.prepare).mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.operationFailed)
  })

  it('prepares updates without scripts and reports both commit failure forms', async () => {
    const value = bridge()
    vi.mocked(value.prepare).mockResolvedValue({ ok: true, value: {
      planId: 'plan-no-scripts', digest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    } })
    vi.mocked(value.commit)
      .mockResolvedValueOnce({ ok: false, error: { code: 'expired', message: 'Expired' } })
      .mockRejectedValueOnce(new Error('offline'))
    render(<ExtensionCenterPanel {...props(value)} />)
    fireEvent.change(screen.getByLabelText(en.operationType), { target: { value: 'update' } })
    fillInstall('  @fixture/demo  ', '  @fixture/demo@2.0.0  ')
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect(await screen.findByRole('button', { name: en.confirmInstall })).toBeTruthy()
    expect(JSON.parse(vi.mocked(value.prepare).mock.calls[0]?.[1] ?? '{}')).toEqual({
      action: 'update', packageName: '@fixture/demo', spec: '@fixture/demo@2.0.0',
    })
    fireEvent.click(screen.getByRole('button', { name: en.confirmInstall }))
    expect((await screen.findByRole('alert')).textContent).toBe('Expired')

    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.operationFailed)
  })

  it('reconnects a stored operation through transient status failures and refreshes on success', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem('dsh:extension-center:operation:profile-a', 'operation-a')
    const value = bridge()
    vi.mocked(value.status)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, error: { code: 'busy', message: 'busy' } })
      .mockResolvedValueOnce({ ok: true, value: {
        operationId: 'operation-a', outcome: 'running', cancellationRequested: false,
      } })
      .mockResolvedValueOnce({ ok: true, value: {
        operationId: 'operation-a', outcome: 'succeeded', cancellationRequested: false,
      } })
    render(<ExtensionCenterPanel {...props(value)} />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(en.operationQueued)).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(750) })
    expect(screen.getByText(en.operationSucceeded)).toBeTruthy()
    expect(value.list).toHaveBeenCalledTimes(2)
  })

  it('settles a recovered operation with a non-success terminal status', async () => {
    window.localStorage.setItem('dsh:extension-center:operation:profile-a', 'operation-a')
    const value = bridge()
    vi.mocked(value.status).mockResolvedValue({ ok: true, value: {
      operationId: 'operation-a', outcome: 'unknown', cancellationRequested: false,
    } })
    render(<ExtensionCenterPanel {...props(value)} />)
    expect(await screen.findByText(en.operationUnknown)).toBeTruthy()
  })

  it.each(['resolve', 'reject'] as const)('ignores a late status %s after unmount', async (settlement) => {
    window.localStorage.setItem('dsh:extension-center:operation:profile-a', 'operation-a')
    const pending = deferred<Awaited<ReturnType<DesktopExtensionBridge['status']>>>()
    const value = bridge()
    vi.mocked(value.status).mockReturnValue(pending.promise)
    const view = render(<ExtensionCenterPanel {...props(value)} />)
    view.unmount()
    await act(async () => {
      if (settlement === 'resolve') pending.resolve({ ok: true, value: {
        operationId: 'operation-a', outcome: 'running', cancellationRequested: false,
      } })
      else pending.reject(new Error('late'))
      try { await pending.promise } catch {}
    })
  })

  it.each([
    ['unknown', en.operationUnknown],
    ['failed', en.operationFailed],
    ['cancelled', en.operationFailed],
  ] as const)('renders a terminal %s operation', async (outcome, copy) => {
    const value = bridge()
    vi.mocked(value.prepare).mockResolvedValue({ ok: true, value: {
      planId: `plan-${outcome}`, digest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
    } })
    vi.mocked(value.commit).mockResolvedValue({ ok: true, value: {
      operationId: `operation-${outcome}`, outcome, cancellationRequested: false,
    } })
    render(<ExtensionCenterPanel {...props(value)} />)
    fillInstall()
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    fireEvent.click(await screen.findByRole('button', { name: en.confirmInstall }))
    expect(await screen.findByText(copy)).toBeTruthy()
  })

  it('renders optional inventory fields and disabled state independently', async () => {
    const list = vi.fn<DesktopExtensionBridge['list']>().mockResolvedValue({ ok: true, value: { entries: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'disabled', name: 'Disabled', enabled: false },
    ] } })
    render(<ExtensionCenterPanel {...props(bridge(list))} />)
    expect(await screen.findByText('Minimal')).toBeTruthy()
    expect(screen.getByText(en.disabled)).toBeTruthy()
  })

  it('shows exact lifecycle scripts and sends their digest only after explicit confirmation', async () => {
    const value = bridge()
    vi.mocked(value.prepare).mockResolvedValue({ ok: true, value: {
      planId: 'plan-a', digest: 'a'.repeat(64), expiresAt: Date.now() + 60_000,
      scripts: [{ name: 'postinstall', command: 'node build.js' }], scriptDigest: 'b'.repeat(64),
    } })
    vi.mocked(value.commit).mockResolvedValue({ ok: true, value: {
      operationId: 'operation-a', outcome: 'queued', cancellationRequested: false,
    } })
    render(<ExtensionCenterPanel {...props(value)} />)
    fireEvent.change(screen.getByLabelText(en.packageName), { target: { value: '@fixture/demo' } })
    fireEvent.change(screen.getByLabelText(en.packageSource), { target: { value: '@fixture/demo@1.2.3' } })
    fireEvent.click(screen.getByRole('button', { name: en.prepareInstall }))
    expect(await screen.findByText('node build.js')).toBeTruthy()
    expect(value.commit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.confirmScripts }))
    await waitFor(() => { expect(value.commit).toHaveBeenCalledWith('plan-a', 'b'.repeat(64)) })
    expect(window.localStorage.getItem('dsh:extension-center:operation:profile-a')).toBe('operation-a')
  })
})

describe('ExtensionCenterFooterAction', () => {
  it.each([true, false])('opens from the %s sidebar layout', (wide) => {
    const open = vi.fn()
    const footerProps = { wide, open, t } as ExtensionCenterFooterActionProps
    const view = render(<ExtensionCenterFooterAction {...footerProps} />)
    const button = screen.getByRole('button', { name: en.title })
    fireEvent.click(button)
    expect(open).toHaveBeenCalledOnce()
    expect(screen.queryByText(en.title) !== null).toBe(wide)
    view.unmount()
  })
})
