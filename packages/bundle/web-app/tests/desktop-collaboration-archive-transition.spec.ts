import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { handleDesktopCollaborationArchiveTransitionRequest } from '../src/desktop-collaboration-archive-transition.ts'

const token = 'A'.repeat(43)
const identity = {
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'source-session',
  archive_token: '70000000-0000-4000-8000-000000000007',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test', account_subject: 'alice',
}
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

it('requires its own parent token and exact identity before a durable transition', async () => {
  const transition = vi.fn(async () => ({ archive_phase: 'staged' as const }))
  const server = createServer((req, res) => { void handleDesktopCollaborationArchiveTransitionRequest(req, res, token, transition) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-collaboration-archive-transition`
  const send = (body: unknown, credential = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  expect((await send({ ...identity, action: 'stage' }, 'wrong')).status).toBe(403)
  expect((await send({ ...identity, action: 'prepare' })).status).toBe(400)
  expect((await send({ ...identity, action: ['stage'] })).status).toBe(400)
  expect((await send({ ...identity, action: 'stage', phase: 'archived' })).status).toBe(400)
  expect(transition).not.toHaveBeenCalled()
  const accepted = await send({ ...identity, action: 'stage' })
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ archive_phase: 'staged' })
  expect(transition).toHaveBeenCalledWith({ ...identity, action: 'stage' }, expect.any(AbortSignal))
  transition.mockImplementationOnce(async () => ({ archive_phase: 'archived' as never }))
  const resumed = await send({ ...identity, action: 'stage' })
  expect(resumed.status).toBe(200)
  expect(await resumed.json()).toEqual({ archive_phase: 'archived' })
  transition.mockImplementationOnce(async () => ({ archive_phase: 'released' as never }))
  expect((await send({ ...identity, action: 'stage' })).status).toBe(422)
  for (const [action, archive_phase] of [
    ['prepared', 'prepared'], ['archive', 'archived'], ['restore', 'restored'],
    ['finish_release', 'released'],
  ] as const) {
    transition.mockImplementationOnce(async () => ({ archive_phase: archive_phase as never }))
    const response = await send({ ...identity, action })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ archive_phase })
  }
  transition.mockImplementationOnce(async () => ({ archive_phase: 'prepared' as never }))
  expect((await send({ ...identity, action: 'archive' })).status).toBe(422)
})
