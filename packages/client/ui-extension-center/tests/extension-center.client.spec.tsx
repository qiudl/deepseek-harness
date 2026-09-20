// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionCenterPanel } from '../src/client/ExtensionCenterPanel.tsx'
import type { ExtensionCenterPanelProps } from '../src/client/ExtensionCenterPanel.tsx'
import { en, type ExtensionCenterLocaleKey } from '../src/client/locales.ts'
import type { DesktopExtensionBridge, ExtensionKind } from '../src/client/bridge.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
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
