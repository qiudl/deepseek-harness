import { expect, it, vi } from 'vitest'
import { createDraftTransitionRegistry } from '../src/client/draft-transition.ts'

it('prepares all mounted editors and refuses an unconfirmed save', async () => {
  const registry = createDraftTransitionRegistry(), first = vi.fn(async () => true)
  registry.register(first)
  const remove = registry.register(async () => false)
  expect(await registry.prepare()).toBe(false)
  remove(); remove(); expect(await registry.prepare()).toBe(true); expect(first).toHaveBeenCalledTimes(2)
})

it('rejects a preparation when the editor set changes while saving', async () => {
  const registry = createDraftTransitionRegistry()
  let release!: (saved: boolean) => void
  const remove = registry.register(() => new Promise((resolve) => { release = resolve }))
  const pending = registry.prepare()
  remove(); registry.register(async () => true); release(true)
  expect(await pending).toBe(false)
  expect(await registry.prepare()).toBe(true)
})

it('contains a failed editor without reporting the other editors saved', async () => {
  const registry = createDraftTransitionRegistry()
  registry.register(async () => { throw Error('editor unavailable') })
  expect(await registry.prepare()).toBe(false)
})

it('invalidates a pending preparation when its plugin is disposed', async () => {
  const registry = createDraftTransitionRegistry()
  let release!: (saved: boolean) => void
  registry.register(() => new Promise((resolve) => { release = resolve }))
  const pending = registry.prepare(); registry.dispose(); release(true)
  expect(await pending).toBe(false); expect(await registry.prepare()).toBe(false)
})
