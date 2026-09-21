// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply, inject } from '../src/client/index.ts'
import { ExtensionCenterPanel } from '../src/client/ExtensionCenterPanel.tsx'
import { ExtensionCenterFooterAction } from '../src/client/ExtensionCenterFooterAction.tsx'
import { desktopExtensionBridge, type DesktopExtensionBridge } from '../src/client/bridge.ts'
import { apply as applyHost } from '../src/index.ts'

afterEach(() => { delete window.__SLARK_DSH_EXTENSIONS__ })

async function bench(bridge?: DesktopExtensionBridge) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LayoutService extends Service {
    readonly selectPanel = vi.fn<(id: MainPanelId | null) => void>()
    constructor(serviceCtx: Context) { super(serviceCtx, 'layout') }
  }
  const layout = new LayoutService(ctx)
  if (bridge !== undefined) window.__SLARK_DSH_EXTENSIONS__ = bridge
  return { ctx, slots: ctx.get('slots') as SlotRegistry, layout }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

function readyBridge(): DesktopExtensionBridge {
  return {
    hello: vi.fn().mockResolvedValue({
      ok: true,
      value: { protocol: 1, profile: { key: 'profile-a', label: 'Personal' } },
    }),
    list: vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } }),
    prepare: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    commit: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    status: vi.fn().mockResolvedValue({ ok: false, error: { code: 'unused', message: 'unused' } }),
    onOpen: vi.fn(() => () => {}),
  }
}

describe('ui-extension-center browser plugin', () => {
  it('declares only its presentation dependencies', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout'])
    expect(() => { applyHost() }).not.toThrow()
  })

  it('accepts only a complete restricted bridge', () => {
    expect(desktopExtensionBridge()).toBeUndefined()
    const complete = readyBridge()
    for (const key of ['hello', 'list', 'prepare', 'commit', 'status', 'onOpen'] as const) {
      window.__SLARK_DSH_EXTENSIONS__ = { ...complete, [key]: undefined }
      expect(desktopExtensionBridge()).toBeUndefined()
    }
    window.__SLARK_DSH_EXTENSIONS__ = complete
    expect(desktopExtensionBridge()).toBe(complete)
  })

  it('stays absent without the restricted desktop bridge', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })

  it('registers both surfaces only after a successful DSH/Profile handshake', async () => {
    const bridge = readyBridge()
    const b = await bench(bridge)
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    await vi.waitFor(() => { expect(b.slots.entries('main')).toHaveLength(1) })
    expect(b.slots.entries('main')[0]?.component).toBe(ExtensionCenterPanel)
    expect(b.slots.entries('main')[0]?.options.key).toBe('extensions')
    expect((b.slots.entries('main')[0]?.inject as unknown as () => unknown)()).toEqual({
      bridge, profile: { key: 'profile-a', label: 'Personal' },
    })
    expect(b.slots.entries('sidebar.footer.action')[0]?.component).toBe(ExtensionCenterFooterAction)

    const footer = b.slots.entries('sidebar.footer.action')[0]!
    const injected = (footer.inject as unknown as () => { open: () => void })()
    injected.open()
    expect(b.layout.selectPanel).toHaveBeenCalledWith('extensions')

    const open = vi.mocked(bridge.onOpen).mock.calls[0]?.[0]
    open?.()
    expect(b.layout.selectPanel).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })

  it('fails closed when the bridge rejects the active Profile', async () => {
    const bridge = readyBridge()
    vi.mocked(bridge.hello).mockResolvedValue({
      ok: false,
      error: { code: 'dsh_profile_view_required', message: 'not active' },
    })
    const b = await bench(bridge)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(bridge.hello).toHaveBeenCalledOnce() })
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })

  it('fails closed on an unsupported protocol or rejected handshake promise', async () => {
    const unsupported = readyBridge()
    vi.mocked(unsupported.hello).mockResolvedValue({
      ok: true,
      value: { protocol: 2, profile: { key: 'profile-a', label: 'Personal' } },
    } as never)
    const first = await bench(unsupported)
    declare(first.slots)
    await first.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(unsupported.hello).toHaveBeenCalledOnce() })
    expect(first.slots.entries('main')).toHaveLength(0)
    await first.ctx.fiber.dispose()

    const rejected = readyBridge()
    vi.mocked(rejected.hello).mockRejectedValue(new Error('offline'))
    const second = await bench(rejected)
    declare(second.slots)
    await second.ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(rejected.hello).toHaveBeenCalledOnce() })
    expect(second.slots.entries('main')).toHaveLength(0)
    await second.ctx.fiber.dispose()
  })

  it('does not register when disposed before the handshake settles', async () => {
    let resolve!: (value: Awaited<ReturnType<DesktopExtensionBridge['hello']>>) => void
    const handshake = new Promise<Awaited<ReturnType<DesktopExtensionBridge['hello']>>>((done) => { resolve = done })
    const bridge = readyBridge()
    vi.mocked(bridge.hello).mockReturnValue(handshake)
    const b = await bench(bridge)
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    resolve({ ok: true, value: { protocol: 1, profile: { key: 'profile-a', label: 'Personal' } } })
    await handshake
    expect(b.slots.entries('main')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })

  it('follows late slot declaration, owner reload, and plugin teardown', async () => {
    const b = await bench(readyBridge())
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await Promise.resolve()
    expect(b.slots.entries('main')).toHaveLength(0)

    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('main')).toHaveLength(1) })
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    stop()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)

    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('main')).toHaveLength(1) })
    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
