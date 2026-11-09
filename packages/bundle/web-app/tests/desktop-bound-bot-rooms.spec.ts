import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBoundBotRoomsRequest } from '../src/desktop-bound-bot-rooms.ts'

const token = 'A'.repeat(43)
const query = { bot_id: 'operator', limit: 20, cursor: null }
const page = { state: 'page', bot_id: 'operator', workspace_id: '10000000-0000-4000-8000-000000000001',
  state_revision: 1, membership_snapshot: 'a'.repeat(64), items: [{ room_id: 'room-1', member_set_digest: 'b'.repeat(64) }], next_cursor: null }
async function fixture(inspect: Parameters<typeof handleDesktopBoundBotRoomsRequest>[3]) {
  const pending = new Set<Promise<void>>()
  const server = createServer((req, res) => {
    const task = handleDesktopBoundBotRoomsRequest(req, res, token, inspect)
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((yes, no) => server.close((error) => { if (error) no(error); else yes() }))
    await Promise.all(pending)
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: unknown, credential = token, signal?: AbortSignal) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
  return { post }
}

it('accepts only the private worker token and bounded selector, returning no-cache detached metadata', async () => {
  const inspect = vi.fn(async () => page), f = await fixture(inspect)
  expect((await f.post(query, 'wrong')).status).toBe(403)
  expect((await f.post({ ...query, challenge_nonce: token })).status).toBe(400)
  expect((await f.post({ ...query, cursor: 'a'.repeat(2049) })).status).toBe(400)
  expect(inspect).not.toHaveBeenCalled()
  const response = await f.post(query)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(page)
  expect(inspect).toHaveBeenCalledWith(query, expect.any(AbortSignal))
  expect((await f.post({ ...query, cursor: 'a'.repeat(2048) })).status).toBe(200)
})

it('rejects a different Bot, excess items, a stuck cursor and any extra private result', async () => {
  const inspect = vi.fn<Parameters<typeof handleDesktopBoundBotRoomsRequest>[3]>(), f = await fixture(inspect)
  for (const invalid of [{ ...page, bot_id: 'other' }, { ...page, items: [...page.items, { room_id: 'room-2', member_set_digest: 'b'.repeat(64) }] },
    { ...page, next_cursor: 'same' }, { ...page, private_chat: 'secret' }]) {
    inspect.mockResolvedValueOnce(invalid)
    const response = await f.post({ ...query, limit: 1, cursor: 'same' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  }
})

it('preserves all explicit non-page outcomes, including an older plugin that needs upgrading', async () => {
  const inspect = vi.fn<Parameters<typeof handleDesktopBoundBotRoomsRequest>[3]>(), f = await fixture(inspect)
  for (const state of ['bot_unavailable', 'snapshot_changed', 'upgrade_required', 'unavailable', 'invalid']) {
    inspect.mockResolvedValueOnce({ state })
    const response = await f.post(query)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state })
  }
  inspect.mockRejectedValueOnce(Error('private plugin details'))
  const failed = await f.post(query)
  expect(failed.status).toBe(422)
  expect(await failed.text()).not.toContain('private plugin')
})

it('cancels the owned inspection on disconnect and awaits its quiescent completion', async () => {
  const started = Promise.withResolvers<boolean>(), settled = Promise.withResolvers<boolean>()
  let cancelled = false
  const f = await fixture(async (_query, signal) => {
    started.resolve(true)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }) })
    settled.resolve(true)
    return page
  })
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const request = f.post(query, token, controller.signal).catch((error: unknown) => error)
  await started.promise
  controller.abort()
  await request
  await settled.promise
  expect(cancelled).toBe(true)
})
