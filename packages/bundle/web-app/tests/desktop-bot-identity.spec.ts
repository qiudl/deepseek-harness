import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { HostBotIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopBotIdentityRequest } from '../src/desktop-bot-identity.ts'

const token = 'A'.repeat(43)
const identity = { bot_id: 'bot_1', actor_ref: 'deepseek-bot:bot_1', display_name: 'My Bot' }

async function fixture(resolve: (botId: string, signal: AbortSignal) => Promise<HostBotIdentity | null>
  = vi.fn(async () => identity)) {
  const server = createServer((req, res) => { void handleDesktopBotIdentityRequest(req, res, token, resolve) })
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
  return { resolve, post }
}

it('requires the private token, validates exact target and returns only the Bot identity', async () => {
  const f = await fixture()
  expect((await f.post({ bot_id: 'bot_1' }, '')).status).toBe(403)
  expect((await f.post({ bot_id: '../other' })).status).toBe(400)
  expect((await f.post({ bot_id: 'bot_1', private_chat: 'secret' })).status).toBe(400)
  expect(f.resolve).not.toHaveBeenCalled()
  const response = await f.post({ bot_id: 'bot_1' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(identity)
  expect(f.resolve).toHaveBeenCalledWith('bot_1', expect.any(AbortSignal))
})

it('returns absence and refuses a mismatched or oversized plugin response', async () => {
  const absent = await fixture(vi.fn(async () => null))
  expect(await (await absent.post({ bot_id: 'bot_1' })).json()).toBeNull()
  const mismatch = await fixture(vi.fn(async () => ({ ...identity, bot_id: 'other' })))
  expect((await mismatch.post({ bot_id: 'bot_1' })).status).toBe(422)
  const oversized = await fixture(vi.fn(async () => ({ ...identity, display_name: '汉'.repeat(171) })))
  expect((await oversized.post({ bot_id: 'bot_1' })).status).toBe(422)
})
