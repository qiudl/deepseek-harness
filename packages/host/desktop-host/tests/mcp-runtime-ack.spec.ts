import { createServer } from 'node:http'
import { expect, it, onTestFinished } from 'vitest'
import { waitForMcpRuntime } from '../src/mcp-runtime-ack.ts'

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
