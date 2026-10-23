import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopNativeRoomOperationRequest } from '../src/desktop-native-room-operations.ts'

const token = 'A'.repeat(43)
const member = '22222222-2222-4222-8222-222222222222'
const command = { operation: 'messages', room_id: 'room_1', member_id: member,
  cycle: 1, after_seq: 5, limit: 2 }

async function fixture(run: Parameters<typeof handleDesktopNativeRoomOperationRequest>[3]) {
  const server = createServer((req, res) => {
    void handleDesktopNativeRoomOperationRequest(req, res, token, run)
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((yes, no) => server.close((error) => {
      if (error) no(error)
      else yes()
    }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, credential = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  return { post }
}

it('keeps native room lines behind the private worker token and exact cursor', async () => {
  const value = { state: 'ok', room_id: 'room_1', next_seq: 6, last_seq: 6,
    messages: [{ seq: 6, source_kind: 'user', message_id: 'message-6', text: 'hello' }] }
  const run = vi.fn(async () => value)
  const f = await fixture(run)
  expect((await f.post(command, 'wrong')).status).toBe(403)
  expect((await f.post({ ...command, secret: 'x' })).status).toBe(400)
  expect(run).not.toHaveBeenCalled()
  const reply = await f.post(command)
  expect(reply.status).toBe(200)
  expect(reply.headers.get('cache-control')).toBe('no-store')
  expect(await reply.json()).toEqual(value)
  expect(run).toHaveBeenCalledWith(command, expect.any(AbortSignal))
})

it('rejects a page from another room and strips plugin errors', async () => {
  const f = await fixture(async () => ({ state: 'ok', room_id: 'other',
    next_seq: 6, last_seq: 6, messages: [] }))
  expect((await f.post(command)).status).toBe(422)
  const g = await fixture(async () => { throw Error('private details') })
  expect(await (await g.post(command)).json()).toEqual({ error: 'unavailable' })
})
