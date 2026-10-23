import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopNativeRoomRequest } from '../src/desktop-native-room.ts'

const token = 'A'.repeat(43)
const source = { workspace_id: '11111111-1111-4111-8111-111111111111',
  session_id: 'bridge-session', source_message_id: 'source-message', source_revision: '1' }

async function fixture(prepare = vi.fn(async (roomId: string) => ({ room_id: roomId, source }))) {
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
  const post = (body: unknown, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(body),
  })
  return { post, prepare }
}

it('prepares a bridge Source only for a worker-token request naming one room', async () => {
  const f = await fixture()
  expect((await f.post({ room_id: 'native-room' }, '')).status).toBe(403)
  expect((await f.post({ room_id: 'native-room', source }, `Bearer ${token}`)).status).toBe(400)
  expect(f.prepare).not.toHaveBeenCalled()
  const response = await f.post({ room_id: 'native-room' })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ room_id: 'native-room', source })
  expect(f.prepare).toHaveBeenCalledWith('native-room', expect.any(AbortSignal))
})

it('rejects a mismatched room, same Session, or extra Profile data', async () => {
  const mismatch = await fixture(vi.fn(async () => ({ room_id: 'other-room', source })))
  expect((await mismatch.post({ room_id: 'native-room' })).status).toBe(422)
  const same = await fixture(vi.fn(async () => ({ room_id: 'native-room',
    source: { ...source, session_id: 'native-room' } })))
  expect((await same.post({ room_id: 'native-room' })).status).toBe(422)
  const leak = await fixture(vi.fn(async () => ({ room_id: 'native-room',
    source: { ...source, token: 'secret' } })))
  expect((await leak.post({ room_id: 'native-room' })).status).toBe(422)
})
