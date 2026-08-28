// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { OfficialBrandMark, OfficialBrandName } from '../src/client/Brand.tsx'
import {
  SLARK_WORKBENCH_RETURN_URL,
  SlarkWorkbenchReturn,
} from '../src/client/SlarkWorkbenchReturn.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const BRAND_HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const
const HOLES = [
  ...BRAND_HOLES,
  'sidebar.footer.action',
] as const

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('official browser-brand plugin', () => {
  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('leaves every slot empty outside the official build profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    vi.stubEnv('DSH_CLIENT_SLARK_WORKBENCH', '0')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of BRAND_HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.slots.entries('sidebar.footer.action')).toHaveLength(0)

    before.disposeHoles?.()
    for (const hole of BRAND_HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of BRAND_HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of BRAND_HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of BRAND_HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of BRAND_HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('adds one reversible Slark return action only for the Slark workbench build', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    vi.stubEnv('DSH_CLIENT_SLARK_WORKBENCH', '1')
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(subject.slots.entries('sidebar.footer.action')).toHaveLength(1)
    for (const hole of BRAND_HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    await fiber.dispose()
    expect(subject.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })

  it('renders an exact top-level Desktop return signal in both sidebar layouts', () => {
    const view = render(<SlarkWorkbenchReturn wide />)
    const link = view.getByRole('link', { name: '切换到企业工作台' })
    expect(link.getAttribute('href')).toBe(SLARK_WORKBENCH_RETURN_URL)
    expect(view.getByText('企业工作台')).toBeTruthy()
    view.rerender(<SlarkWorkbenchReturn wide={false} />)
    expect(view.queryByText('企业工作台')).toBeNull()
    expect(view.getByRole('link', { name: '切换到企业工作台' }).getAttribute('href'))
      .toBe(SLARK_WORKBENCH_RETURN_URL)
  })

  it('renders the official name independently from both requested mark sizes', () => {
    const name = render(<OfficialBrandName />)
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('26 0 156 24')
    name.unmount()

    const mark = render(<OfficialBrandMark size={34} className="hero-mark" />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    expect(mark.container.querySelector('svg')?.getAttribute('class')).toBe('hero-mark')
    mark.rerender(<OfficialBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })
})
