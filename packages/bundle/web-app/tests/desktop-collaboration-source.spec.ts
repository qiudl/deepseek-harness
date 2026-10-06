import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopCollaborationSourceRequest, handleDesktopCollaborationSourceSnapshotRequest } from '../src/desktop-collaboration-source.ts'
import { handleDesktopCollaborationReferenceGrantRequest } from '../src/desktop-collaboration-source.ts'

const token = 'A'.repeat(43)
const target = { workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 'session' as never, source_message_id: 'message-1', source_revision: '1' }
const selection = { ...target, snapshot_digest: 'a'.repeat(64) }

function privatePoster(url: string, token: string) {
  return (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

it('reads only separately committed reference grants over the private worker token and exact request digest', async () => {
  const query = { ...target, reference_request_digest: 'b'.repeat(64) }
  const inspect = vi.fn(async (): Promise<unknown> => ({ ...selection, reference_request_digest: query.reference_request_digest }))
  const server = createServer((req, res) => { void handleDesktopCollaborationReferenceGrantRequest(req, res, token, inspect) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = privatePoster(url, token)
  expect((await post(query, '')).status).toBe(403)
  expect((await post({ ...query, snapshot_digest: selection.snapshot_digest })).status).toBe(400)
  expect(inspect).not.toHaveBeenCalled()
  expect(await (await post(query)).json()).toEqual({ ...selection, reference_request_digest: query.reference_request_digest })
  expect(inspect).toHaveBeenCalledWith(query, expect.any(AbortSignal))
  inspect.mockResolvedValue({ ...selection, reference_request_digest: 'c'.repeat(64) })
  expect((await post(query)).status).toBe(422)
  inspect.mockRejectedValue(Error('private path secret'))
  expect(await (await post(query)).text()).toBe('{"error":"unavailable"}')
})

async function fixture(inspect = vi.fn(async ():Promise<unknown> => selection),full=false) {
  const handler = full ? handleDesktopCollaborationSourceSnapshotRequest : handleDesktopCollaborationSourceRequest
  const server = createServer((req, res) => { void handler(req, res, token, inspect) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = privatePoster(url, token)
  return { inspect, post }
}

it('requires the private worker token and rejects cookie-only or arbitrary identity requests', async () => {
  const f = await fixture()
  expect((await f.post(target, '')).status).toBe(403)
  expect((await f.post(target, `Bearer ${'B'.repeat(43)}`)).status).toBe(403)
  for (const body of [{ ...target, workspace_id: '/private' }, { ...target, provider: 'caller-model' },
    { ...target, session_id: '中'.repeat(86) }]) expect((await f.post(body)).status).toBe(400)
  expect(f.inspect).not.toHaveBeenCalled()
  const response = await f.post(target)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(selection)
  expect(f.inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
})

it('sanitizes reader failures and rejects mismatched or secret-bearing results', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(Error('private path and API key'))
  const failure = await f.post(target)
  expect(failure.status).toBe(422)
  expect(await failure.json()).toEqual({ error: 'unavailable' })
  f.inspect.mockResolvedValueOnce({ ...selection, session_id: 'other' as never })
  expect((await f.post(target)).status).toBe(422)
  f.inspect.mockResolvedValueOnce({ ...selection, api_key: 'private' })
  expect((await f.post(target)).status).toBe(422)
})

it('full Source reader rejects malformed journal digests, nested credentials and coordinate replacement',async()=>{
  const inspect=vi.fn(async():Promise<unknown>=>({ ...target,original_message:'original',active_mentions:[],model_snapshot:{ provider:'p',model:'m',configuration_generation:'1',adapter_fingerprint:'a'.repeat(64) },host_journal_commit:{ journal_id:'j',commit_version:'1',content_digest:'b'.repeat(64) } }))
  const f=await fixture(inspect,true)
  expect((await f.post(target,'')).status).toBe(403);expect(inspect).not.toHaveBeenCalled()
  for(const value of [await inspect(),{ ...await inspect() as object,session_id:'other' },{ ...await inspect() as object,model_snapshot:{ api_key:'private' } }]){
    inspect.mockResolvedValueOnce(value);const response=await f.post(target);expect(response.status).toBe(422);expect(await response.json()).toEqual({ error:'unavailable' })
  }
})
