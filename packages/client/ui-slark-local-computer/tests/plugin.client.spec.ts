import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { LocalComputerControl, type LocalComputerInjected } from '../src/client/LocalComputerControl.tsx'

const GRANT = '11111111-1111-4111-8111-111111111111'
const state = {
  items: [{
    grant_id: GRANT,
    computer_label: 'Studio Mac',
    computer_display_code: 'ABC234',
    workspace_alias: 'Source',
    mode: 'read_write',
    expires_at: '2030-01-01T00:00:00.000Z',
  }],
  selected_grant_id: GRANT,
  publication_version: 4,
  selection_required: false,
}

describe('Slark local-computer client plugin', () => {
  it('keeps the host half inert', () => {
    expect(() => { applyHost() }).not.toThrow()
  })

  it('registers one reversible sidebar entry backed only by the connection service', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'sidebar.footer.action': { kind: 'many', scope: 'root' } },
    } as never, () => null)
    const fetchSlarkEdge = vi.fn()
      .mockResolvedValueOnce(Response.json(state))
      .mockResolvedValueOnce(Response.json({ ...state, reload_required: false }))
    ctx.provide('connection', { fetchSlarkEdge } as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entries = ctx.slots.entries('sidebar.footer.action')
    expect(inject).toEqual(['connection', 'slots'])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.component).toBe(LocalComputerControl)

    const face = (entries[0]!.inject as unknown as () => LocalComputerInjected)()
    await expect(face.listTargets()).resolves.toMatchObject({ selectedGrantId: GRANT })
    await expect(face.selectTarget(GRANT, 4)).resolves.toMatchObject({ reloadRequired: false })
    expect(fetchSlarkEdge).toHaveBeenNthCalledWith(1, '/api/slark/v1/local-computer-targets', expect.any(Object))
    expect(fetchSlarkEdge).toHaveBeenNthCalledWith(2, '/api/slark/v1/local-computer-target', expect.any(Object))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    face.reload()
    expect(reload).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()

    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })
})
