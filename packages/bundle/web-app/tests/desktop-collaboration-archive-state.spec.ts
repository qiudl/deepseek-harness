import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { handleDesktopCollaborationArchiveStateRequest } from '../src/desktop-collaboration-archive-state.ts'

const token = 'A'.repeat(43)
const target = {
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'source-session',
  archive_token: '70000000-0000-4000-8000-000000000007',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test', account_subject: 'alice',
}
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

it('accepts only a private token and reads the bound phase without a caller phase field', async () => {
  const inspect = vi.fn(async () => ({ archive_phase: 'archived' as const }))
  const server = createServer((req, res) => { void handleDesktopCollaborationArchiveStateRequest(req, res, token, inspect) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-collaboration-archive-state`
  const send = (body: unknown, credential = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  expect((await send(target, 'wrong')).status).toBe(403)
  expect(inspect).not.toHaveBeenCalled()
  const accepted = await send(target)
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ archive_phase: 'archived' })
  expect(inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
  expect((await send({ ...target, archive_phase: 'restored' })).status).toBe(400)
})
