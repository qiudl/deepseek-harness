import { createServer } from 'node:http'
import { expect, it, onTestFinished } from 'vitest'
import { readProfileSkillCatalog, readProfileSkillRuntime } from '../src/skill-worker-client.ts'

it.each(['success', 'wrong-rpc', 'unauthorized'].flatMap(mode => ['inspectProfile', 'profileCatalog'].map(method => ({ mode, method }))))('reads the authenticated worker response: $method $mode', async ({ mode, method }) => {
  const server = createServer((req, res) => {
    expect(req.headers.cookie).toBe('fixture=private')
    expect(req.url).toBe(`/api/skills/${method}`)
    let body = ''; req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(body) as { rpcId: string; payload: unknown }
      expect(request.payload).toEqual({ args: method === 'inspectProfile' ? { request: { name: 'demo' } } : {} })
      if (mode === 'unauthorized') { res.writeHead(401); res.end(); return }
      res.end(JSON.stringify({ type: 'server-response', rpcId: mode === 'wrong-rpc' ? 'wrong' : request.rpcId,
        result: { ok: true, value: method === 'inspectProfile' ? { skill: { name: 'demo' } } : { complete: true, skills: [] } } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing port')
  const worker = { origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'fixture', value: 'private' } }
  const read = () => method === 'inspectProfile' ? readProfileSkillRuntime(worker, 'demo', new AbortController().signal)
    : readProfileSkillCatalog(worker, new AbortController().signal)
  if (mode === 'success') await expect(read()).resolves.toEqual(method === 'inspectProfile' ? { name: 'demo' } : { complete: true, skills: [] })
  else await expect(read()).rejects.toThrow()
})

async function responseFixture(value: (rpcId: string) => unknown, status = 200) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const { rpcId } = JSON.parse(body) as { rpcId: string }
      res.writeHead(status)
      res.end(JSON.stringify(value(rpcId)))
    })
  })
  onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing port')
  return { origin: `http://127.0.0.1:${address.port}`, bootstrapCookie: { name: 'fixture', value: 'private' } }
}

it.each([
  null, 42, 'not an envelope', [], {},
  { type: 'client-request' },
  { type: 'server-response', result: { ok: false } },
  { type: 'server-response', result: {} },
  ...[null, 42, [], 'body', undefined].map(value => ({ type: 'server-response', result: { ok: true, value } })),
])('rejects malformed worker envelopes without treating them as a missing skill: %#', async (value) => {
  const worker = await responseFixture(rpcId => value && typeof value === 'object' && !Array.isArray(value) ? { ...value, rpcId } : value)
  await expect(readProfileSkillRuntime(worker, 'demo', new AbortController().signal)).rejects.toThrow('invalid_runtime_response')
})

it('distinguishes an explicitly absent skill from a missing response field', async () => {
  const missing = await responseFixture(rpcId => ({ type: 'server-response', rpcId, result: { ok: true, value: {} } }))
  await expect(readProfileSkillRuntime(missing, 'demo', new AbortController().signal)).rejects.toThrow('invalid_runtime_response')
  const absent = await responseFixture(rpcId => ({ type: 'server-response', rpcId, result: { ok: true, value: { skill: null } } }))
  await expect(readProfileSkillRuntime(absent, 'demo', new AbortController().signal)).resolves.toBeNull()
})

it('rejects a successful HTTP response without a body', async () => {
  const worker = await responseFixture(() => null, 204)
  await expect(readProfileSkillCatalog(worker, new AbortController().signal)).rejects.toThrow('runtime_unavailable')
})

it('caps streamed response bytes before parsing the worker payload', async () => {
  const worker = await responseFixture(() => 'x'.repeat(262_145))
  await expect(readProfileSkillCatalog(worker, new AbortController().signal)).rejects.toThrow('runtime_response_too_large')
})

it('honors cancellation before opening a connection', async () => {
  const worker = { origin: 'http://127.0.0.1:1', bootstrapCookie: { name: 'fixture', value: 'private' } }
  await expect(readProfileSkillCatalog(worker, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
})
