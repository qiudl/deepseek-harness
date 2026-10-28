import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotImportInventoryRequest } from '../src/desktop-bot-import-inventory.ts'

const token = 'A'.repeat(43)
const page = { version: 1, sourceDigest: 'a'.repeat(64), teamRevision: 3,
  sessionIds: ['session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], nextCursor: null }

async function fixture(read = vi.fn(async () => page)) {
  const server = createServer((req, res) => { void handleDesktopBotImportInventoryRequest(req, res, token, read) })
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

it('admits only a private token and exact inventory request', async () => {
  const f = await fixture()
  expect((await f.post({ kind: 'inventory' }, '')).status).toBe(403)
  expect((await f.post({ kind: 'inventory', profileId: 'other' })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post({ kind: 'inventory' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
})

it('rejects a worker reply with arbitrary Session or unknown fields', async () => {
  const f = await fixture(vi.fn(async () => ({ ...page, sessionIds: [page.sessionIds[0]!],
    profileRoot: '/private/other' })))
  expect((await f.post({ kind: 'inventory' })).status).toBe(422)
})
