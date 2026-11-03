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

it('accepts one bounded Agent result chunk only through the private worker token', async () => {
  const chunk = { operation: 'agent-result-chunk', room_id: 'room_1',
    group_id: '11111111-1111-4111-8111-111111111111', member_id: member,
    cycle: 1, turn_id: '33333333-3333-5333-8333-333333333333',
    turn_order: 2, trigger_room_seq: 6, project_id: 'project', agent_id: 'agent',
    reply_message_id: 'reply-1', status: 'completed', result_digest: 'a'.repeat(64),
    chunk_index: 0, chunk_count: 1, chunk_text: '中'.repeat(4500),
    chunk_digest: 'b'.repeat(64) }
  const result = { state: 'recorded', turn_id: chunk.turn_id,
    chunk_index: 0, room_seq: 7 }
  const run = vi.fn(async () => result)
  const f = await fixture(run)
  expect((await f.post(chunk, 'wrong')).status).toBe(403)
  expect((await f.post(chunk)).status).toBe(200)
  expect(run).toHaveBeenCalledWith(chunk, expect.any(AbortSignal))
  expect((await f.post({ ...chunk, chunk_text: '中'.repeat(5000) })).status).toBe(400)
})
