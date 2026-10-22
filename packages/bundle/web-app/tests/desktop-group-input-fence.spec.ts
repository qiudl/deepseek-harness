import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { parseHostGroupInputFenceValue } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopGroupInputFenceRequest } from '../src/desktop-group-input-fence.ts'

const token = 'A'.repeat(43)
const challenge = {
  request_id: '10000000-0000-4000-8000-000000000001', challenge_nonce: 'A'.repeat(43),
  expires_at: 2000, audience: 'https://slark.example.test',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test', account_subject: '30000000-0000-4000-8000-000000000003',
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'session',
  group_id: '70000000-0000-4000-8000-000000000007', group_version: 1,
}
const value = { workspace_id: challenge.workspace_id, session_id: challenge.session_id,
  group_id: challenge.group_id, group_version: challenge.group_version }
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => Promise.all(servers.splice(0).map(server =>
  new Promise<void>(resolve => server.close(() => { resolve() })))) )

it('installs only a private exact fence and refuses mismatched acknowledgement', async () => {
  const install = vi.fn(async () => parseHostGroupInputFenceValue(value))
  const server = createServer((req, res) => { void handleDesktopGroupInputFenceRequest(req, res, token, install) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-group-input-fence`
  const send = (body: unknown, credential = token) => fetch(url, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  expect((await send(challenge, 'wrong')).status).toBe(403)
  for (const bad of [{ ...challenge, group_id: 'wrong' }, { ...challenge, group_version: 0 },
    { ...challenge, extra: true }]) expect((await send(bad)).status).toBe(400)
  expect(install).not.toHaveBeenCalled()
  const accepted = await send(challenge)
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual(value)
  expect(install).toHaveBeenCalledWith(challenge, expect.any(AbortSignal))
  install.mockResolvedValueOnce(parseHostGroupInputFenceValue({ ...value, group_version: 2 }))
  expect((await send(challenge)).status).toBe(422)
})
