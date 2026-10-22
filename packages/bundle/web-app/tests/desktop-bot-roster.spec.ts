import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotRosterRequest } from '../src/desktop-bot-roster.ts'

const token = 'A'.repeat(43)
const first = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'One' }
const page = { bots: [first], next_cursor: null }

async function fixture(list = vi.fn(async () => page)) {
  const server = createServer((req, res) => { void handleDesktopBotRosterRequest(req, res, token, list) })
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
  return { list, post }
}

it('returns only a bounded Profile roster to the private worker token', async () => {
  const f = await fixture()
  expect((await f.post({ after_bot_id: '', limit: 50 }, '')).status).toBe(403)
  expect((await f.post({ after_bot_id: '', limit: 50, profile_path: '/private' })).status).toBe(400)
  expect(f.list).not.toHaveBeenCalled()
  const response = await f.post({ after_bot_id: '', limit: 50 })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
  expect(f.list).toHaveBeenCalledWith('', 50, expect.any(AbortSignal))
})

it('rejects a page outside the requested cursor or with private fields', async () => {
  const wrongCursor = await fixture(vi.fn(async () => page))
  expect((await wrongCursor.post({ after_bot_id: 'bot_2', limit: 50 })).status).toBe(422)
  const leaked = await fixture(vi.fn(async () => ({ bots: [{ ...first, memory: 'private' }], next_cursor: null })))
  expect((await leaked.post({ after_bot_id: '', limit: 50 })).status).toBe(422)
})
