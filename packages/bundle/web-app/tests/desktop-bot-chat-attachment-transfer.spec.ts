import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotChatAttachmentTransferRequest } from '../src/desktop-bot-chat-attachment-transfer.ts'

const token = 'A'.repeat(43)
const scope = { logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  part: 0, team_revision: 7, event_digest: 'a'.repeat(64), manifest_digest: 'b'.repeat(64),
  eventSeq: 1, blockIndex: 0 }
const request = { schema_version: 'dsh-remote-bot-attachment/v1', kind: 'next', ...scope,
  transfer_id: '10000000-0000-4000-8000-000000000001', offset: 0 }
const page = { ...scope, transfer_id: request.transfer_id, attachment_id: `sha256:${'c'.repeat(64)}`,
  total_bytes: 3, offset: 0, chunk_base64: Buffer.from('abc').toString('base64'),
  final: true, source: 'authority' }

async function fixture(read = vi.fn(async () => page)) {
  const server = createServer((req, res) => {
    void handleDesktopBotChatAttachmentTransferRequest(req, res, token, read)
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((yes, no) => server.close((error) => { if (error) no(error); else yes() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(body),
  })
  return { read, post }
}

it('requires worker token and exact logical transfer scope', async () => {
  const f = await fixture()
  expect((await f.post(request, '')).status).toBe(403)
  expect((await f.post({ ...request, path: '/private/other' })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
})

it('rejects a page from a different manifest or a private path', async () => {
  const wrong = await fixture(vi.fn(async () => ({ ...page, manifest_digest: 'd'.repeat(64) })))
  expect((await wrong.post(request)).status).toBe(422)
  const hidden = await fixture(vi.fn(async () => ({ ...page, private_path: '/private/other' })))
  expect((await hidden.post(request)).status).toBe(422)
})
