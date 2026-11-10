import { createServer } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBoundBotRoomsRequest } from '../src/desktop-bound-bot-rooms.ts'

const token = 'A'.repeat(43)
const operation = 'B'.repeat(42) + 'A'
const query = { bot_id: 'operator', limit: 1, cursor: null }

it('returns a correlated native terminal receipt only after the actual service settles', async () => {
  const started = Promise.withResolvers<boolean>(), release = Promise.withResolvers<boolean>()
  const pending: Promise<void>[] = []
  const server = createServer((req, res) => {
    pending.push(handleDesktopBoundBotRoomsRequest(req, res, token, async () => {
      started.resolve(true)
      await release.promise
      return { state: 'bot_unavailable' }
    }))
  })
  onTestFinished(async () => {
    release.resolve(true)
    await Promise.all(pending)
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  let received = false
  const request = fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-dsh-native-drain': operation,
  }, body: JSON.stringify(query) }).then((response) => { received = true; return response })
  await started.promise
  expect(received).toBe(false)
  release.resolve(true)
  const response = await request
  expect(response.status).toBe(200)
  expect(response.headers.get('x-dsh-native-settled')).toBe(operation)
  expect(await response.json()).toEqual({ state: 'bot_unavailable' })
})

it('marks a native deadline without destroying an admitted operation before it really settles', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const started = Promise.withResolvers<boolean>(), cancelled = Promise.withResolvers<boolean>(), release = Promise.withResolvers<boolean>()
  const tasks: Promise<void>[] = []
  const server = createServer((req, res) => {
    tasks.push(handleDesktopBoundBotRoomsRequest(req, res, token, async (_target, signal) => {
      signal.addEventListener('abort', () =>{  cancelled.resolve(true) }, { once: true })
      started.resolve(true)
      await release.promise
      return { state: 'bot_unavailable' }
    }))
  })
  onTestFinished(async () => {
    timer.mockRestore(); release.resolve(true)
    await Promise.all(tasks)
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  let received = false
  const request = fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'x-dsh-native-drain': operation,
  }, body: JSON.stringify(query) }).then((response) => { received = true; return response })
  await started.promise
  const timeout = timer.mock.calls.find(([, delay]) => delay === 10_000)?.[0]
  if (typeof timeout !== 'function') throw Error('missing native deadline')
  timeout()
  await cancelled.promise
  expect(received).toBe(false)
  release.resolve(true)
  const response = await request
  expect(response.status).toBe(422)
  expect(response.headers.get('x-dsh-native-settled')).toBe(operation)
})

it('authenticates before receipts and refuses noncanonical operation nonces without invoking the service', async () => {
  const inspect = vi.fn(async () => ({ state: 'bot_unavailable' }))
  const server = createServer((req, res) => { void handleDesktopBoundBotRoomsRequest(req, res, token, inspect) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw Error('missing owned listener')
  const post = (nonce: string, credential = token, body: unknown = query) => fetch(`http://127.0.0.1:${address.port}`,
    { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'x-dsh-native-drain': nonce }, body: JSON.stringify(body) })
  const denied = await post(operation, 'wrong')
  expect(denied.status).toBe(403)
  expect(denied.headers.get('x-dsh-native-settled')).toBeNull()
  for (const nonce of ['bad', 'B'.repeat(43)]) {
    const response = await post(nonce)
    expect(response.status).toBe(400)
    expect(response.headers.get('x-dsh-native-settled')).toBeNull()
  }
  const invalid = await post(operation, token, { ...query, extra: true })
  expect(invalid.status).toBe(400)
  expect(invalid.headers.get('x-dsh-native-settled')).toBe(operation)
  expect(inspect).not.toHaveBeenCalled()
})
