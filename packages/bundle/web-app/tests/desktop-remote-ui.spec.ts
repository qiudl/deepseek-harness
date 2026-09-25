import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest } from '../src/desktop-remote-ui.ts'

describe('Desktop remote UI read-only bridge', () => {
  it('dispatches only the exact M1 read endpoints with named Remote arguments', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const boot = vi.fn(() => [{ kind: 'script' as const, placement: 'head' as const, text: 'boot()' }])
    const executor = new DesktopRemoteUiExecutor({ invoke } as unknown as TypertGateway, boot)
    const signal = new AbortController().signal
    await expect(executor.execute('boot/injections', { args: {} }, signal))
      .resolves.toEqual({ injections: [{ kind: 'script', placement: 'head', text: 'boot()' }] })
    expect(boot).toHaveBeenCalledOnce()
    await expect(executor.execute('boot/injections', { args: { extra: true } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('session/list', { args: { _request: {} } }, signal))
      .resolves.toEqual({ items: [] })
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'list', args: { _request: {} }, signal })
    for (const endpoint of ['settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
      'credentials/describe', 'permissionPresets/catalog']) {
      const args = endpoint === 'credentials/describe' ? { refs: ['OPENAI_API_KEY'] } : {}
      await expect(executor.execute(endpoint, { args }, signal)).resolves.toEqual({ items: [] })
      const [namespace, method] = endpoint.split('/')
      expect(invoke).toHaveBeenCalledWith({ namespace, method, args, signal })
    }
    await expect(executor.execute('credentials/describe', { args: { refs: ['bad-ref'] } }, signal))
      .rejects.toThrow('invalid payload')
    await expect(executor.execute('settings/describe', { args: { path: '/private' } }, signal))
      .rejects.toThrow('invalid payload')
    for (const endpoint of ['session/prompt', 'session/delete', 'workspace/create', 'llm/listProviders', '$events/result']) {
      await expect(executor.execute(endpoint, { args: {} }, signal)).rejects.toThrow('endpoint denied')
    }
    await expect(executor.execute('dynamicCordisRunner/syncInspectManifest', { args: {} }, signal))
      .rejects.toThrow('endpoint denied')
    expect(invoke).toHaveBeenCalledTimes(6)
  })

  it('requires a private token, rejects forbidden endpoints and bounds input', async () => {
    const token = 'A'.repeat(43)
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteUiExecutor({ invoke } as unknown as TypertGateway, () => [])
    const server = createServer((req, res) => {
      void handleDesktopRemoteUiRequest(req, res, token, (endpoint, payload, signal) =>
        executor.execute(endpoint, payload, signal))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      const request = { endpoint: 'session/list', payload: { args: { _request: {} } } }
      await expect(fetch(origin, { method: 'POST', headers: { cookie: 'dsh-auth=fake' }, body: JSON.stringify(request) })
        .then(response => response.status)).resolves.toBe(403)
      const headers = { authorization: `Bearer ${token}` }
      await expect(fetch(origin, { method: 'POST', headers, body: JSON.stringify({
        endpoint: 'session/prompt', payload: { args: {} },
      }) }).then(response => response.status)).resolves.toBe(422)
      await expect(fetch(origin, { method: 'POST', headers, body: 'x'.repeat(65_537) })
        .then(response => response.status)).resolves.toBe(422)
      const response = await fetch(origin, { method: 'POST', headers, body: JSON.stringify(request) })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ value: { items: [] } })
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })
})
