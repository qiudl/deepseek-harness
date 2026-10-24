import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopNativeRoomRequest } from '../src/desktop-native-room.ts'

const token = 'A'.repeat(43)
const binding = { room_id: 'room_1', source: {
  workspace_id: '10000000-0000-4000-8000-000000000001',
  session_id: 'bridge_1', source_message_id: 'source_1', source_revision: '1',
} }

async function fixture(prepare: (roomId: string, signal: AbortSignal) => Promise<unknown>) {
  const server = createServer((req, res) => { void handleDesktopNativeRoomRequest(req, res, token, prepare) })
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

it('requires the private worker token and returns only the requested native room Source', async () => {
  const prepare = vi.fn(async () => binding)
  const f = await fixture(prepare)
  expect((await f.post({ room_id: 'room_1' }, 'wrong')).status).toBe(403)
  expect((await f.post({ room_id: 'room_1', private_chat: 'secret' })).status).toBe(400)
  expect(prepare).not.toHaveBeenCalled()
  const response = await f.post({ room_id: 'room_1' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(binding)
  expect(prepare).toHaveBeenCalledWith('room_1', expect.any(AbortSignal))
})

it('rejects a different room, a reused room Session, and private plugin fields', async () => {
  for (const invalid of [{ ...binding, room_id: 'other' },
    { ...binding, source: { ...binding.source, session_id: binding.room_id } },
    { ...binding, source: { ...binding.source, private_chat: 'secret' } }]) {
    const f = await fixture(vi.fn(async () => invalid))
    expect((await f.post({ room_id: binding.room_id })).status).toBe(422)
  }
})

it('returns null for an absent room without disclosing Profile data', async () => {
  const f = await fixture(vi.fn(async () => null))
  const response = await f.post({ room_id: 'missing' })
  expect(response.status).toBe(200)
  expect(await response.json()).toBeNull()
})
