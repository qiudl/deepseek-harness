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
