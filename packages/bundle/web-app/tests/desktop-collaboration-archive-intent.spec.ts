import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { handleDesktopCollaborationArchiveIntentRequest } from '../src/desktop-collaboration-archive-intent.ts'

const token = 'A'.repeat(43)
const target = {
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'source-session',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test', account_subject: 'alice',
}
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

it('returns the original token only to the parent Host for an exact Account Session', async () => {
  const inspect = vi.fn(async () => ({ archive_phase: 'prepared' as const,
    archive_token: '70000000-0000-4000-8000-000000000007' }))
  const server = createServer((req, res) => { void handleDesktopCollaborationArchiveIntentRequest(req, res, token, inspect) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-collaboration-archive-intent`
  const send = (body: unknown, credential = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  expect((await send(target, 'wrong')).status).toBe(403)
  expect(inspect).not.toHaveBeenCalled()
  const accepted = await send(target)
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ archive_phase: 'prepared', archive_token: '70000000-0000-4000-8000-000000000007' })
  expect(inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
  expect((await send({ ...target, archive_token: '70000000-0000-4000-8000-000000000007' })).status).toBe(400)
})
