// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installRemoteWorkbench } from '../src/remote-workbench.ts'
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  Reflect.deleteProperty(window, '__DSH_NATIVE_WORKBENCH__')
  vi.restoreAllMocks()
})

it('leaves native controls absent when the parent does not advertise them', async () => {
  await installRemoteWorkbench(async () => new Response(null, { status: 403 }))
  expect(Reflect.get(window, '__DSH_NATIVE_WORKBENCH__')).toBeUndefined()
})
it('installs only advertised native calls and carries the original Session draft', async () => {
  const calls: { path: string; body: unknown }[] = []
  const fetch: TunnelFetch = async (path, init) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: String(path), body })
    if (path === '/__native_workbench__') return Response.json({ schema: 'dsh-native-workbench/v1', duet: true, draft: true })
    if (path === '/__native_duet__') return Response.json({ ok: true, value: { accepted: true } })
    return Response.json({ ok: true, value: { revision: 1, text: '未发送' } })
  }
  await installRemoteWorkbench(fetch)
  const bridge = Reflect.get(window, '__DSH_NATIVE_WORKBENCH__') as {
    duetStart(sessionId: string): Promise<void>
    conversationDraft(input: { action: 'read'; sessionId: string }): Promise<unknown>
  }
  await bridge.duetStart('session-a')
  await expect(bridge.conversationDraft({ action: 'read', sessionId: 'session-a' })).resolves.toEqual({ ok: true, value: { revision: 1, text: '未发送' } })
  expect(calls.slice(1)).toEqual([
    { path: '/__native_duet__', body: { sessionId: 'session-a' } },
    { path: '/__native_draft__', body: { action: 'read', sessionId: 'session-a' } },
  ])
  window.dispatchEvent(new Event('pagehide'))
  expect(Reflect.get(window, '__DSH_NATIVE_WORKBENCH__')).toBeUndefined()
  await expect(bridge.duetStart('session-b')).rejects.toThrow()
  expect(calls).toHaveLength(3)
})
it('rejects malformed capabilities and refuses to replace an installed bridge', async () => {
  await installRemoteWorkbench(async () => Response.json({ schema: 'dsh-native-workbench/v1', duet: true, draft: true, token: 'forged' }))
  expect(Reflect.get(window, '__DSH_NATIVE_WORKBENCH__')).toBeUndefined()
  Reflect.set(window, '__DSH_NATIVE_WORKBENCH__', {})
  await expect(installRemoteWorkbench(async () => Response.json({ schema: 'dsh-native-workbench/v1', duet: true, draft: false }))).rejects.toThrow()
})
