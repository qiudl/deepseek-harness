import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopNativeRoomRetirementRequest } from '../src/desktop-native-room-retirement.ts'

const token = 'A'.repeat(43)
const command = { operation: 'join', room_id: 'room-1', group_id: '10000000-0000-4000-8000-000000000001',
  member_id: '20000000-0000-4000-8000-000000000002', cycle: 1, project_id: 'project', agent_id: 'agent', name: 'My twin' }
async function fixture(retire: Parameters<typeof handleDesktopNativeRoomRetirementRequest>[3]) {
  const pending = new Set<Promise<void>>()
  const errors: unknown[] = []
  const server = createServer((req, res) => {
    const task = handleDesktopNativeRoomRetirementRequest(req, res, token, retire)
    pending.add(task)
    void task.then(() => pending.delete(task), (error: unknown) => { errors.push(error); pending.delete(task) })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
    await Promise.all(pending)
    expect(errors).toEqual([])
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { post: (body: unknown, credential = token, signal?: AbortSignal) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...(signal ? { signal } : {}) }) }
}

it('retirement accepts only the private worker token and complete original identity', async () => {
  const retire = vi.fn(async () => ({ state: 'left', left_room_seq: 0 })), f = await fixture(retire)
  expect((await f.post(command, 'wrong')).status).toBe(403)
  for (const invalid of [{ ...command, binding_id: command.group_id }, { ...command, operation: 'leave' },
    { ...command, name: '' }, { ...command, cycle: 0 }, { ...command, padding: 'a'.repeat(32768) }])
    expect((await f.post(invalid)).status).toBe(400)
  expect(retire).not.toHaveBeenCalled()
  const response = await f.post(command)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ state: 'left', left_room_seq: 0 })
  expect(retire).toHaveBeenCalledWith(command, expect.any(AbortSignal))
})

it('retirement keeps missing-capability and unsuccessful results distinct from a durable left', async () => {
  const retire = vi.fn<Parameters<typeof handleDesktopNativeRoomRetirementRequest>[3]>(), f = await fixture(retire)
  for (const state of ['upgrade_required', 'conflict', 'unavailable', 'invalid']) {
    retire.mockResolvedValueOnce({ state })
    const response = await f.post(command)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state })
  }
  for (const invalid of [{ state: 'joined', joined_room_seq: 0 }, { state: 'left', left_room_seq: '0' },
    { state: 'left', left_room_seq: -1 }, { state: 'left', left_room_seq: Number.MAX_SAFE_INTEGER + 1 },
    { state: 'left', left_room_seq: 0, private: true }]) {
    retire.mockResolvedValueOnce(invalid)
    expect((await f.post(command)).status).toBe(422)
  }
  retire.mockRejectedValueOnce(Error('private store details'))
  const response = await f.post(command)
  expect(response.status).toBe(422)
  expect(await response.text()).toBe('{"error":"unavailable"}')
})

it('retirement cancels its owned call on disconnect and awaits its settlement', async () => {
  const started = Promise.withResolvers<boolean>(), settled = Promise.withResolvers<boolean>()
  const f = await fixture(async (_command, signal) => {
    started.resolve(true)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    settled.resolve(true)
    return { state: 'left', left_room_seq: 0 }
  })
  const cancel = new AbortController()
  onTestFinished(() => { cancel.abort() })
  const response = f.post(command, token, cancel.signal).catch((error: unknown) => error)
  await started.promise
  cancel.abort()
  await response
  await settled.promise
})
