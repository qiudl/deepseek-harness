import { createServer } from 'node:http'
import { expect, it, onTestFinished } from 'vitest'
import { reloadProfileMcpRuntime, waitForMcpRuntime } from '../src/mcp-runtime-ack.ts'
import type { PersonProfileRecord } from '../src/types.ts'
import type { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'

const profile: PersonProfileRecord = {
  profileId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150' as PersonProfileRecord['profileId'],
  kind: 'account',
  personIndex: 'person-index',
  keyHandle: 'keychain:fixture',
  unlockVerifier: 'verifier',
  accountBindings: [],
  bindingGeneration: 1,
  createdAt: 1,
}

it('waits for active MCP entries over the authenticated worker API', async () => {
  let calls = 0
  const server = createServer((req, res) => {
    expect(req.url).toBe('/api/pluginInventory/list')
    expect(req.headers.cookie).toBe('test-cookie=private-value')
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(body) as { rpcId: string }
      expect(request).toMatchObject({ type: 'client-request', method: 'pluginInventory/list', payload: { args: {} } })
      calls++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { entries: [{
        entryId: 'include:mcp-demo', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: calls < 2 ? 'loading' : 'active',
      }] } } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing port')
  await waitForMcpRuntime({ origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'test-cookie', value: 'private-value' } },
    ['mcp-demo'], new AbortController().signal)
  expect(calls).toBe(2)
})

it('does not acknowledge removal while the fresh worker still exposes the MCP row', async () => {
  let calls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const { rpcId } = JSON.parse(body) as { rpcId: string }
      const entries = ++calls === 1 ? [{ entryId: 'include:mcp-demo', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active' }] : []
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { entries } } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing port')
  await waitForMcpRuntime({ origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'test', value: 'fixture' } },
    [], new AbortController().signal, ['mcp-demo'])
  expect(calls).toBe(2)
})

it('rejects a stale Profile before replacing its MCP worker', async () => {
  let disposed = false
  const workers = {
    dispose: async () => { disposed = true },
  } as unknown as ProfileWorkerSupervisor

  await expect(reloadProfileMcpRuntime({
    workers,
    resolveProfile: () => null,
    ensureWorker: async () => {},
  }, profile.profileId, new AbortController().signal, [], () => {}, [])).rejects.toMatchObject({ code: 'stale' })
  expect(disposed).toBe(false)
})

it('replaces the Profile worker and acknowledges the exact fresh MCP generation', async () => {
  const calls: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const { rpcId } = JSON.parse(body) as { rpcId: string }
      calls.push('inventory')
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { entries: [{
        entryId: 'include:mcp-fresh', moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, fiberPhase: 'active',
      }] } } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing port')
  const workers = {
    dispose: async (profileId: string) => { calls.push(`dispose:${profileId}`) },
    activate: async (profileId: string) => {
      calls.push(`activate:${profileId}`)
      return { origin: `http://127.0.0.1:${address.port}`, generation: 2, bootstrapCookie: { name: 'test', value: 'fixture' } }
    },
  } as unknown as ProfileWorkerSupervisor

  await reloadProfileMcpRuntime({
    workers,
    resolveProfile: profileId => profileId === profile.profileId ? profile : null,
    ensureWorker: async (resolved) => { calls.push(`ensure:${resolved.profileId}`) },
  }, profile.profileId, new AbortController().signal, ['mcp-fresh'], () => { calls.push('guard') }, [])

  expect(calls).toEqual([
    'guard',
    `dispose:${profile.profileId}`,
    'guard',
    `ensure:${profile.profileId}`,
    'guard',
    `activate:${profile.profileId}`,
    'inventory',
  ])
})
