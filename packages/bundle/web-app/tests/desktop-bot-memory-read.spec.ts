import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotMemoryReadRequest } from '../src/desktop-bot-memory-read.ts'

const token = 'A'.repeat(43)
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'memory', logical_id: 'team', limit: 50 }
const page = { logical_id: 'team', scope_revision: 'a'.repeat(64), next_cursor: null,
  item: null, source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }

async function fixture(read = vi.fn(async () => page)) {
  const server = createServer((req, res) => { void handleDesktopBotMemoryReadRequest(req, res, token, read) })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((yes, no) => server.close((error) => {
      if (error) no(error)
      else yes()
    }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(body),
  })
  return { read, post }
}

it('requires the private token and an exact memory scope', async () => {
  const f = await fixture()
  expect((await f.post(request, '')).status).toBe(403)
  expect((await f.post({ ...request, profile_id: 'other' })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
})

it('refuses another scope or private fields in the plugin response', async () => {
  const other = await fixture(vi.fn(async () => ({ ...page, logical_id: 'bot:other' })))
  expect((await other.post(request)).status).toBe(422)
  const hidden = await fixture(vi.fn(async () => ({ ...page, private_path: '/private/work' })))
  expect((await hidden.post(request)).status).toBe(422)
})
