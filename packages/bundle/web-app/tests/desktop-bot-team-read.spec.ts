import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotTeamReadRequest } from '../src/desktop-bot-team-read.ts'

const token = 'A'.repeat(43)
const request = { schema_version: 'dsh-remote-bot-read/v1', kind: 'team', limit: 2 }
const page = { team_revision: 1, next_cursor: null, items: [
  { kind: 'bot', logical_id: 'bot:thanos', name: '灭霸Thanos', role: 'Main', main: true },
], source: 'authority', last_confirmed_at: '2026-10-23T17:00:00.000Z' }

async function fixture(read = vi.fn(async () => page)) {
  const server = createServer((req, res) => { void handleDesktopBotTeamReadRequest(req, res, token, read) })
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

it('admits only the private Host token and exact team selector', async () => {
  const f = await fixture()
  expect((await f.post(request, '')).status).toBe(403)
  expect((await f.post({ ...request, profile_id: 'other' })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
  expect(f.read).toHaveBeenCalledWith(request, expect.any(AbortSignal))
})

it('refuses a plugin response containing private fields', async () => {
  const f = await fixture(vi.fn(async () => ({ ...page, private_path: '/private/work' })))
  expect((await f.post(request)).status).toBe(422)
})
