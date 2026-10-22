// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyIndexInjections } from '../../src/client/apply-injections.ts'

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

it('ignores script preload hints and executes script sources through the worker loader', async () => {
  const loadScript = vi.fn(async () => {})
  const preload = 'plugins/??app-a/client.js,app-b/client.js&rev=app'
  const bootstrap = 'plugins/??modules/client.js&rev=boot'

  await applyIndexInjections([
    { kind: 'script-preload', src: preload },
    { kind: 'script-src', placement: 'head', src: bootstrap },
  ], loadScript)

  expect(loadScript).toHaveBeenCalledOnce()
  expect(loadScript).toHaveBeenCalledWith(bootstrap)
  expect(document.querySelector('link[rel="preload"]')).toBeNull()
})

it('awaits the page-owned classic-script executor before later assets and propagates failure', async () => {
  const order: string[] = []
  await applyIndexInjections([
    { kind: 'script', placement: 'head', text: 'bootstrap' },
    { kind: 'script-src', placement: 'body', src: 'plugin' },
  ], async (src) => { order.push(src) }, async (text) => { await Promise.resolve(); order.push(text) })
  expect(order).toEqual(['bootstrap', 'plugin'])
  expect(document.querySelector('script')).toBeNull()
  const load = vi.fn()
  await expect(applyIndexInjections([
    { kind: 'script', placement: 'head', text: 'bad' },
    { kind: 'script-src', placement: 'body', src: 'must-not-run' },
  ], load, async () => { throw new Error('blocked') })).rejects.toThrow('blocked')
  expect(load).not.toHaveBeenCalled()
})
