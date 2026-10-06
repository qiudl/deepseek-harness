import { createHash } from 'node:crypto'
import { collaborationJournalDigest } from '@deepseek-ai/dsh-api-session-controller'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopCollaborationSourceRequest, handleDesktopCollaborationSourceSnapshotRequest } from '../src/desktop-collaboration-source.ts'
import { handleDesktopCollaborationReferenceGrantRequest, handleDesktopCollaborationReferenceCaptureRequest } from '../src/desktop-collaboration-source.ts'
import { handleDesktopCollaborationRootRequest } from '../src/desktop-collaboration-source.ts'

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

async function fixture(inspect = vi.fn(async ():Promise<unknown> => selection),full: boolean | 'root' = false) {
  const handler = full === 'root' ? handleDesktopCollaborationRootRequest : full ? handleDesktopCollaborationSourceSnapshotRequest : handleDesktopCollaborationSourceRequest
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

it('captures computed metadata only under its separate Reference capability and rejects caller content and mismatched recipients', async () => {
  const referenceToken = 'B'.repeat(43)
  const request = {
    source: { workspace_id: target.workspace_id, session_id: target.session_id,
      source_message_id: target.source_message_id, revision: target.source_revision, message_digest: 'b'.repeat(64) },
    reference_request_id: 'ref', source_kind: 'message', source_locator: 'previous', source_version: '1',
    range: { start: 0, end: 3, unit: 'utf16' }, mime_type: 'text/plain', byte_length: 3,
    content_digest: createHash('sha256').update('ref').digest('hex'), recipient_mention_ids: ['mention'],
    source_evidence_spans: [{ source_message_id: target.source_message_id, source_revision: '1', start: 0, end: 2 }],
  }
  const { mime_type: _mime, content_digest: _digest, byte_length: _bytes, ...fields } = request
  const { message_digest: _sourceDigest, ...source } = fields.source
  const input = { ...fields, source, range: { unit: 'whole' } }
  const metadata = { descriptor: selection, request, reference_request_digest: collaborationJournalDigest(request) }
  const capture = vi.fn(async (): Promise<unknown> => metadata)
  const server = createServer((req, res) => { void handleDesktopCollaborationReferenceCaptureRequest(req, res, referenceToken, capture) })
  onTestFinished(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, post = privatePoster(url, referenceToken)
  expect((await post(input, `Bearer ${token}`)).status).toBe(403)
  expect((await post(input, '')).status).toBe(403)
  expect((await post({ ...input, content: 'injected' })).status).toBe(400)
  expect(capture).not.toHaveBeenCalled()
  const response = await post(input)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(metadata)
  expect(capture).toHaveBeenCalledWith(input, expect.any(AbortSignal))
  expect((await post({ ...input, range: request.range })).status).toBe(200)
  expect((await post({ ...input, range: { ...request.range, end: 2 } })).status).toBe(422)
  expect((await post({ ...input, range: { unit: 'quote', text: 'ref' } })).status).toBe(200)
  expect((await post({ ...input, range: { unit: 'quote', text: 'bad' } })).status).toBe(422)
  expect((await post({ ...input, range: { unit: 'quote', text: 'r' } })).status).toBe(422)
  const fileRequest = { ...request, source_kind: 'file', range: { start: 0, end: 3, unit: 'byte' }, mime_type: 'application/octet-stream' }
  capture.mockResolvedValue({ ...metadata, request: fileRequest, reference_request_digest: collaborationJournalDigest(fileRequest) })
  expect((await post({ ...input, source_kind: 'file' })).status).toBe(200)
  const wrong = { ...request, recipient_mention_ids: ['other'] }
  capture.mockResolvedValue({ ...metadata, request: wrong, reference_request_digest: collaborationJournalDigest(wrong) })
  expect((await post(input)).status).toBe(422)
  capture.mockRejectedValue(Error('private path and credential'))
  expect(await (await post(input)).json()).toEqual({ error: 'unavailable' })
})

it('refuses root metadata belonging to another namespace or admission command', async () => {
  const input = { ...target, namespace_id: 'n2_' + 'b'.repeat(64), command_id: '10000000-0000-4000-8000-000000000001' }
  const value = { namespace_id: input.namespace_id, command_id: input.command_id,
    root_task_id: '20000000-0000-4000-8000-000000000002', root_trace_id: 'c'.repeat(32), payload_digest: 'd'.repeat(64), source_descriptor: selection }
  const inspect = vi.fn(async (): Promise<unknown> => value), f = await fixture(inspect, 'root')
  expect((await f.post(input)).status).toBe(200)
  for (const patch of [{ namespace_id: 'n2_' + 'f'.repeat(64) }, { command_id: value.root_task_id }]) {
    inspect.mockResolvedValueOnce({ ...value, ...patch })
    const response = await f.post(input)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  }
})
