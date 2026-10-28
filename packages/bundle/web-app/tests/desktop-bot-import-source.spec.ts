import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, onTestFinished, vi } from 'vitest'
import { handleDesktopBotImportSourceRequest } from '../src/desktop-bot-import-source.ts'

const token = 'A'.repeat(43)
const operationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const request = { kind: 'open', operationId, sourceDigest: 'a'.repeat(64),
  sessionId: 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }
const result = { version: 1, operationId, transferId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  sessionId: request.sessionId, eventDigest: 'd'.repeat(64), eventCount: 0, totalBytes: 2 }

async function fixture(read = vi.fn(async () => result)) {
  const server = createServer((req, res) => { void handleDesktopBotImportSourceRequest(req, res, token, read) })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((yes, no) => server.close((error) => { if (error) no(error); else yes() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization }, body: JSON.stringify(body),
  })
  return { post, read }
}

it('requires the worker token and exact transfer shape', async () => {
  const f = await fixture()
  expect((await f.post(request, '')).status).toBe(403)
  expect((await f.post({ ...request, arbitrarySession: true })).status).toBe(400)
  expect(f.read).not.toHaveBeenCalled()
  const response = await f.post(request)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(result)
})

it('rejects a response for another operation or Session', async () => {
  const wrongOperation = await fixture(vi.fn(async () => ({ ...result, operationId: result.transferId })))
  expect((await wrongOperation.post(request)).status).toBe(422)
  const wrongSession = await fixture(vi.fn(async () => ({ ...result, sessionId: 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })))
  expect((await wrongSession.post(request)).status).toBe(422)
})
