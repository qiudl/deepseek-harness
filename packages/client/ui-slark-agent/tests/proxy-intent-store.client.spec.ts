// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { clearProxyIntent, readProxyIntent, writeProxyIntent } from '../src/client/proxy-intent-store.ts'

const target = ['workspace', 'original-session', 'group'] as const
const intent = { operation: 'proxy_replace' as const,
  request_id: '11111111-1111-4111-8111-111111111111', expected_binding_epoch: 2, bot_id: 'my_bot' }
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks() })

it('scopes a pending proxy request to the original group and preserves its key', () => {
  expect(readProxyIntent(...target)).toBeNull()
  expect(writeProxyIntent(...target, intent)).toBe(true)
  expect(readProxyIntent(...target)).toEqual(intent)
  expect(readProxyIntent('other', target[1], target[2])).toBeNull()
  clearProxyIntent(...target)
  expect(readProxyIntent(...target)).toBeNull()
})

it('ignores malformed or forged saved proxy requests', () => {
  expect(writeProxyIntent(...target, intent)).toBe(true)
  const storageKey = sessionStorage.key(0)!
  for (const value of ['{', 'null', '[]', '1', JSON.stringify({ ...intent, secret: 'private' }),
    JSON.stringify({ ...intent, operation: 'other' }), JSON.stringify({ ...intent, request_id: 'bad' }),
    JSON.stringify({ ...intent, expected_binding_epoch: -1 }),
    JSON.stringify({ ...intent, expected_binding_epoch: 0.5 }),
    JSON.stringify({ ...intent, bot_id: '../other' }),
    JSON.stringify({ ...intent, operation: 'proxy_unbind' })]) {
    sessionStorage.setItem(storageKey, value)
    expect(readProxyIntent(...target)).toBeNull()
  }
})

it('does not send a request when browser storage refuses persistence', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage denied') })
  expect(writeProxyIntent(...target, intent)).toBe(false)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('storage denied') })
  expect(readProxyIntent(...target)).toBeNull()
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw Error('storage denied') })
  expect(() => { clearProxyIntent(...target) }).not.toThrow()
})
