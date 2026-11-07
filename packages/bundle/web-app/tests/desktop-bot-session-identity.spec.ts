import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotSessionIdentityRequest, type DesktopBotSessionIdentityProvider } from '../src/desktop-bot-session-identity.ts'

const token = 'A'.repeat(43)
const target = { bot_id: 'bot_1', session_id: 'session-2' }

async function fixture() {
  const original = { identity: Symbol('provider'), resolveLocalBotSession: vi.fn<(input: { botId: string; sessionId: string }) => Promise<unknown>>(async () => ({ botId: 'bot_1', sessionId: 'session-2' })) }
  let provider: DesktopBotSessionIdentityProvider | undefined = original
  const server = createServer((req, res) => {
    void handleDesktopBotSessionIdentityRequest(req, res, token, () => provider)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { original, setProvider(value: DesktopBotSessionIdentityProvider | undefined) { provider = value },
    post(body: object, authorization = `Bearer ${token}`) {
      return fetch(url, { method: 'POST', headers: { authorization }, body: JSON.stringify(body) })
    } }
}

it('requires the private worker token and exact target before reading the current producer', async () => {
  const f = await fixture()
  expect((await f.post(target, '')).status).toBe(403)
  expect((await f.post({ ...target, owner: 'alice' })).status).toBe(400)
  expect(f.original.resolveLocalBotSession).not.toHaveBeenCalled()
  const response = await f.post(target)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(target)
  expect(f.original.resolveLocalBotSession).toHaveBeenCalledWith({ botId: 'bot_1', sessionId: 'session-2' })
})

it('returns explicit absence when the current producer is missing', async () => {
  const f = await fixture()
  f.setProvider(undefined)
  expect(await (await f.post(target)).json()).toBeNull()
  f.setProvider({ resolveLocalBotSession: f.original.resolveLocalBotSession })
  expect(await (await f.post(target)).json()).toBeNull()
  f.setProvider({ identity: Symbol('older producer') })
  expect(await (await f.post(target)).json()).toBeNull()
  f.setProvider(f.original)
  f.original.resolveLocalBotSession.mockResolvedValue(null)
  expect(await (await f.post(target)).json()).toBeNull()
})

it('refuses provider replacement during a read even when the stale producer returns matching coordinates', async () => {
  const f = await fixture()
  f.original.resolveLocalBotSession.mockImplementation(async () => {
    f.setProvider({ ...f.original, identity: Symbol('replacement') })
    return { botId: 'bot_1', sessionId: 'session-2' }
  })
  expect((await f.post(target)).status).toBe(422)
})

it('also fences replacement between the producer check and the private response commit', async () => {
  const f = await fixture()
  f.original.resolveLocalBotSession.mockImplementation(async () => {
    // The inner continuation checks first; replacement then precedes the HTTP continuation.
    queueMicrotask(() => { queueMicrotask(() => { f.setProvider(undefined) }) })
    return { botId: 'bot_1', sessionId: 'session-2' }
  })
  expect((await f.post(target)).status).toBe(422)
})

it('rejects a producer response belonging to another Bot or Session', async () => {
  const f = await fixture()
  f.original.resolveLocalBotSession.mockResolvedValue({ botId: 'other', sessionId: 'session-2' })
  expect((await f.post(target)).status).toBe(422)
  f.original.resolveLocalBotSession.mockResolvedValue({ botId: 'bot_1', sessionId: 'other-session' })
  expect((await f.post(target)).status).toBe(422)
})

it('refuses malformed producer records without invoking accessors or returning private content', async () => {
  const f = await fixture()
  let reads = 0
  for (const value of [undefined, 1, [], new Date(), {},
    { botId: 'bot_1', sessionId: 'session-2', privateChat: 'private' },
    { botId: 'bot_1', sessionId: 1 }, { botId: 'other\n', sessionId: 'session-2' },
    { botId: 'bot_1', get sessionId() { reads++; return 'session-2' } },
    { get botId() { reads++; return 'bot_1' }, sessionId: 'session-2' },
  ]) {
    f.original.resolveLocalBotSession.mockResolvedValue(value)
    const response = await f.post(target)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  }
  expect(reads).toBe(0)
})
