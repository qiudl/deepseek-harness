import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotChatReadRequest } from '../src/desktop-bot-chat-read.ts'

const token = 'A'.repeat(43)
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'bot-chat',
  logical_id: 'bot:session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', part: 0, limit: 32768 }
const page = { logical_id: request.logical_id, part: 0, part_count: 1, team_revision: 7,
  event_digest: 'a'.repeat(64), rows_digest: 'b'.repeat(64), complete: true,
  total_bytes: 2, offset: 0, content_base64: Buffer.from('[]').toString('base64'),
  next_cursor: null, source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }

async function fixture(read = vi.fn(async () => page)) {
  const server = createServer((req, res) => { void handleDesktopBotChatReadRequest(req, res, token, read) })
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

it('requires the private token and a bounded logical Bot part', async () => {
  const f = await fixture()
  expect((await f.post(request, '')).status).toBe(403)
  expect((await f.post({ ...request, profile_id: 'other' })).status).toBe(400)
  expect((await f.post({ ...request, limit: 32769 })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
})

it('rejects another part and unexpected private fields in the plugin page', async () => {
  const other = await fixture(vi.fn(async () => ({ ...page, part: 1, part_count: 2 })))
  expect((await other.post(request)).status).toBe(422)
  const hidden = await fixture(vi.fn(async () => ({ ...page, private_path: '/private/work' })))
  expect((await hidden.post(request)).status).toBe(422)
})
