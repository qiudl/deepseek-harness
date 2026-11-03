import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotGroupRequest } from '../src/desktop-bot-group.ts'

const token = 'A'.repeat(43)
const delivery = { operation: 'deliver', schemaVersion: 1,
  deliveryId: '10000000-0000-4000-8000-000000000001',
  groupId: '20000000-0000-4000-8000-000000000002', botId: 'writer',
  memberCycle: 2, messageSeq: 7, payloadDigest: 'a'.repeat(64), text: 'Hello, Bot.' } as const
const accepted = { state: 'accepted', deliveryId: delivery.deliveryId,
  groupId: delivery.groupId, botId: delivery.botId, memberCycle: delivery.memberCycle,
  payloadDigest: delivery.payloadDigest, sessionId: 'session-1' } as const

async function fixture(run: (input: unknown, signal: AbortSignal) => Promise<unknown>) {
  const server = createServer((req, res) => { void handleDesktopBotGroupRequest(req, res, token, run) })
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

it('requires the worker token and exact bounded delivery before calling the plugin', async () => {
  const run = vi.fn(async () => accepted)
  const f = await fixture(run)
  expect((await f.post(delivery, 'wrong')).status).toBe(403)
  expect((await f.post({ ...delivery, privateChat: 'secret' })).status).toBe(400)
  expect((await f.post({ ...delivery, text: 'x'.repeat(16001) })).status).toBe(400)
  expect(run).not.toHaveBeenCalled()
  const response = await f.post(delivery)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(accepted)
  expect(run).toHaveBeenCalledWith(delivery, expect.any(AbortSignal))
})

it('rejects a plugin receipt for another group or delivery', async () => {
  const f = await fixture(vi.fn(async () => ({ ...accepted, groupId: 'other' })))
  expect((await f.post(delivery)).status).toBe(422)
  const other = await fixture(vi.fn(async () => ({ ...accepted, deliveryId:
    '30000000-0000-4000-8000-000000000003' })))
  expect((await other.post(delivery)).status).toBe(422)
  const secret = await fixture(vi.fn(async () => ({ ...accepted, privateChat: 'secret' })))
  expect((await secret.post(delivery)).status).toBe(422)
  const result = await fixture(vi.fn(async () => ({ ...accepted, state: 'result_recorded',
    resultId: 'other:final' })))
  expect((await result.post(delivery)).status).toBe(422)
})

it('reads a scoped missing receipt without exposing another group result', async () => {
  const query = { operation: 'receipt', deliveryId: delivery.deliveryId,
    groupId: delivery.groupId, botId: delivery.botId, memberCycle: delivery.memberCycle } as const
  const run = vi.fn(async () => ({ state: 'missing' }))
  const f = await fixture(run)
  const response = await f.post(query)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ state: 'missing' })
  expect(run).toHaveBeenCalledWith(query, expect.any(AbortSignal))
})

it('pages only one scoped durable result and forwards its exact acknowledgement', async () => {
  const query = { operation: 'result_page', groupId: delivery.groupId,
    botId: delivery.botId, memberCycle: delivery.memberCycle, after: 0, limit: 1 } as const
  const item = { id: `${delivery.deliveryId}:final`, deliveryId: delivery.deliveryId,
    groupId: delivery.groupId, botId: delivery.botId, memberCycle: delivery.memberCycle,
    seq: 1, status: 'completed', text: 'Done.' } as const
  const f = await fixture(vi.fn(async () => ({ state: 'ok', results: [item], next: 1 })))
  expect(await (await f.post(query)).json()).toEqual({ state: 'ok', results: [item], next: 1 })
  expect((await f.post({ ...query, limit: 2 })).status).toBe(400)
  const wrong = await fixture(vi.fn(async () => ({ state: 'ok', results: [
    { ...item, groupId: '30000000-0000-4000-8000-000000000003' }], next: 1 })))
  expect((await wrong.post(query)).status).toBe(422)
  const acknowledged = await fixture(vi.fn(async () => ({ state: 'acknowledged' })))
  expect(await (await acknowledged.post({ operation: 'ack_result', groupId: delivery.groupId,
    botId: delivery.botId, memberCycle: delivery.memberCycle, deliveryId: delivery.deliveryId,
    resultId: item.id })).json()).toEqual({ state: 'acknowledged' })
  expect((await acknowledged.post({ operation: 'ack_result', groupId: delivery.groupId,
    botId: delivery.botId, memberCycle: delivery.memberCycle, deliveryId: delivery.deliveryId,
    resultId: 'other:final' })).status).toBe(400)
})

it('requires a positive revocation version and forwards the in-flight decision', async () => {
  const run = vi.fn(async () => ({ state: 'revoked' }))
  const f = await fixture(run)
  const command = { operation: 'revoke_cycle', groupId: delivery.groupId,
    botId: delivery.botId, memberCycle: delivery.memberCycle,
    version: 3, stopInFlight: true } as const
  expect(await (await f.post(command)).json()).toEqual({ state: 'revoked' })
  expect(run).toHaveBeenCalledWith(command, expect.any(AbortSignal))
  expect((await f.post({ ...command, version: 0 })).status).toBe(400)
})
