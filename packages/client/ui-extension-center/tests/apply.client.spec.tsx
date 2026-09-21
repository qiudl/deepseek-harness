// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopExtensionBridge, type DesktopExtensionBridge } from '../src/client/bridge.ts'
import { ExtensionCenterFooterAction } from '../src/client/ExtensionCenterFooterAction.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { delete window.__SLARK_DSH_EXTENSIONS__ })

function bridge(protocol = 1): DesktopExtensionBridge {
  return {
    hello: vi.fn().mockResolvedValue({ ok: true, value: { protocol } }),
    showHub: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  }
}

async function bench(capability?: DesktopExtensionBridge) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  if (capability !== undefined) window.__SLARK_DSH_EXTENSIONS__ = capability
  return { ctx, slots }
}

describe('Slark Desktop Hub entry', () => {
  it('requires only presentation services and a complete narrow bridge', () => {
    expect(inject).toEqual(['slots', 'locale'])
    expect(desktopExtensionBridge()).toBeUndefined()
    const complete = bridge()
    window.__SLARK_DSH_EXTENSIONS__ = { ...complete, showHub: undefined } as never
    expect(desktopExtensionBridge()).toBeUndefined()
    window.__SLARK_DSH_EXTENSIONS__ = complete
    expect(desktopExtensionBridge()).toBe(complete)
  })

  it('appears only after DSH Profile verification and opens the original Hub', async () => {
    const capability = bridge()
    const b = await bench(capability)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1) })
    const entry = b.slots.entries('sidebar.footer.action')[0]!
    expect(entry.component).toBe(ExtensionCenterFooterAction)
    expect(entry.options.id).toBe('extensions')
    ;(entry.inject as unknown as () => { open: () => void })().open()
    expect(capability.showHub).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })

  it('stays absent outside Slark and for unsupported bridge protocols', async () => {
    for (const capability of [undefined, bridge(2)]) {
      const b = await bench(capability)
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      if (capability !== undefined) {
        await vi.waitFor(() => { expect(capability.hello).toHaveBeenCalledOnce() })
      } else {
        await Promise.resolve()
      }
      expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
      await b.ctx.fiber.dispose()
    }
  })
})
