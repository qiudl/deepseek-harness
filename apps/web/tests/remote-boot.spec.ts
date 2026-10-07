// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const tunnel = vi.hoisted(() => ({
  bootPayload: vi.fn(async () => ({ injections: [] })),
  fetch: vi.fn(async () => new Response(null, { status: 403 })),
  open: vi.fn(),
  loadBundle: vi.fn(),
  constructed: vi.fn(),
}))
vi.mock('@deepseek-ai/dsh-experimental-webworker-runtime/client', () => ({
  WorkerTunnel: class {
    constructor(endpoint: unknown) { tunnel.constructed(endpoint) }
    bootPayload = tunnel.bootPayload
    fetch = tunnel.fetch
    open = tunnel.open
    loadBundle = tunnel.loadBundle
  },
}))

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  document.body.replaceChildren()
})

it('refuses a remote page without a configured trusted parent', async () => {
  vi.stubEnv('VITE_DSH_REMOTE_PARENT_ORIGIN', '')
  await import('../src/remote.ts')
  const boot = (globalThis as { dshRemoteBoot?: { ready(): Promise<unknown> } }).dshRemoteBoot
  expect(boot).toBeDefined()
  await expect(boot!.ready()).rejects.toThrow('remote web: parent origin is not configured')
  expect(tunnel.constructed).not.toHaveBeenCalled()
})

it('accepts one nonce-bound port only from the configured parent origin', async () => {
  tunnel.fetch.mockImplementation(async () => new Response(JSON.stringify({
    schema: 'dsh-remote-collaboration/v1', methods: ['workspace'],
  })))
  vi.stubEnv('VITE_DSH_REMOTE_PARENT_ORIGIN', 'https://staging.ai.pipexerp.com')
  const parent = { postMessage: vi.fn<(message: { nonce: string }, origin: string) => void>() }
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  await import('../src/remote.ts')
  const [ready, origin] = parent.postMessage.mock.calls[0]!
  expect(origin).toBe('https://staging.ai.pipexerp.com')
  expect(ready).toMatchObject({ schema: 'dsh-remote-frame/v1', kind: 'ready' })

  const port = { start: vi.fn(), postMessage: vi.fn(), addEventListener: vi.fn() }
  const send = (source: unknown, eventOrigin: string, nonce: string): void => {
    const event = new Event('message')
    Object.defineProperties(event, {
      source: { value: source }, origin: { value: eventOrigin },
      data: { value: { schema: 'dsh-remote-frame/v1', kind: 'connect', nonce } },
      ports: { value: [port] },
    })
    window.dispatchEvent(event)
  }
  send(parent, 'https://evil.example', ready.nonce)
  send(parent, origin, 'wrong-nonce')
  expect(port.start).not.toHaveBeenCalled()
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toBeUndefined()
  send(parent, origin, ready.nonce)
  const boot = (globalThis as { dshRemoteBoot?: { ready(): Promise<unknown> } }).dshRemoteBoot
  expect(boot).toBeDefined()
  await expect(boot!.ready()).resolves.toMatchObject({ injections: [], transport: { fetch: tunnel.fetch } })
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toMatchObject({
    collaborationScopeAvailable: true, collaborationExecutionAvailable: false,
  })
  const host: unknown = Reflect.get(window, '__DSH_DESKTOP_HOST__')
  if (host === null || typeof host !== 'object') throw Error('expected the installed Host bridge')
  expect(Reflect.get(host, 'collaborationWorkspace')).toBeTypeOf('function')
  expect(port.start).toHaveBeenCalledOnce()
  expect(tunnel.constructed).toHaveBeenCalledOnce()
})
