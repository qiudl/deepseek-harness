/** Private reply HTTP authenticates a distinct write token and returns only committed persistence metadata. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { collaborationJournalDigest } from '../../../api/session-controller/src/collaboration-source-journal.ts'
const token = 'C'.repeat(43)
const input = () => ({
  namespace_id: 'n2_' + 'a'.repeat(64),
  projection: {
    delivery_id: 'delivery',
    invocation_id: 'invocation',
    plan_id: 'plan',
    task_id: 'task',
    task_revision: '1',
    delivery_state: 'pending',
    delivery_state_version: '1',
    source_locator: {
      workspace_id: '12345678-1234-4123-8123-123456789abc',
      session_id: 'session',
      source_message_id: 'message',
      source_revision: '1',
    },
    source_snapshot_digest: 'a'.repeat(64),
    execution_state: 'succeeded',
    invocation_state_version: '3',
    target: { project_id: 'p', agent_id: 'guide' },
    target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
    answer: '完整答案 😀',
    result_digest: createHash('sha256')
      .update(JSON.stringify({ answer: '完整答案 😀', failure_code: null, state: 'succeeded' }))
      .digest('hex'),
  },
})
function saved(value = input()) {
  const { delivery_state: _state, delivery_state_version: _version, ...projection } = value.projection
  const body = { namespace_id: value.namespace_id, ...projection }
  return {
    ...body,
    host_journal_commit: {
      journal_id: '12345678-1234-4123-8123-123456789abc',
      commit_version: '1',
      content_digest: collaborationJournalDigest(body),
    },
  }
}
async function fixture() {
  const { handleDesktopCollaborationDeliveryRequest } = await import('../src/desktop-collaboration-delivery.ts')
  const receive = vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<unknown> => saved())
  const server = createServer((req, res) => {
    void handleDesktopCollaborationDeliveryRequest(req, res, token, receive)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      }),
    )
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown = input(), authorization = `Bearer ${token}`) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { receive, post, url }
}
it('requires the distinct parent write token and refuses cookie, Source-read token and caller local commits', async () => {
  const f = await fixture()
  for (const auth of ['', `Bearer ${'A'.repeat(43)}`]) expect((await f.post(input(), auth)).status).toBe(403)
  const value = input()
  expect((await f.post({ ...value, host_journal_commit: { commit_version: '1' } })).status).toBe(400)
  expect((await f.post({ ...value, projection: { ...value.projection, api_key: 'private' } })).status).toBe(400)
  expect(f.receive).not.toHaveBeenCalled()
  const response = await f.post()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const receipt = (await response.json()) as Record<string, unknown>
  expect(receipt.delivery_id).toBe('delivery')
  expect(receipt.host_journal_commit).toEqual(saved().host_journal_commit)
  expect(receipt).not.toHaveProperty('answer')
  expect(receipt).not.toHaveProperty('target')
})
it('does not acknowledge mismatched, corrupted or failed persistence and exposes no error details', async () => {
  const f = await fixture()
  f.receive.mockRejectedValueOnce(Error('private API key and path'))
  const failure = await f.post()
  expect(failure.status).toBe(422)
  expect(await failure.json()).toEqual({ error: 'unavailable' })
  f.receive.mockResolvedValueOnce({ ...saved(), source_locator: { ...saved().source_locator, session_id: 'other' } })
  expect((await f.post()).status).toBe(422)
  f.receive.mockResolvedValueOnce({
    ...saved(),
    host_journal_commit: { ...saved().host_journal_commit, content_digest: '0'.repeat(64) },
  })
  expect((await f.post()).status).toBe(422)
  const foreign = input()
  foreign.projection.plan_id = 'different-plan'
  f.receive.mockResolvedValueOnce(saved(foreign))
  expect((await f.post()).status).toBe(422)
})

it('refuses non-POST requests and oversized replies before persistence', async () => {
  const f = await fixture()
  expect((await fetch(f.url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
  expect((await f.post({ ...input(), padding: 'x'.repeat(1024 * 1024) })).status).toBe(400)
  expect(f.receive).not.toHaveBeenCalled()
})

it('cancels persistence ownership when its caller disconnects without retrying the write', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  f.receive.mockImplementationOnce(async (_input, signal) => {
    started.resolve(signal)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { cancelled.resolve(undefined); resolve() }, { once: true })
    })
    return saved()
  })
  const caller = new AbortController()
  const request = fetch(f.url, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(input()), signal: caller.signal,
  })
  const rejected = expect(request).rejects.toThrow()
  const ownedSignal = await started.promise
  caller.abort()
  await rejected
  await cancelled.promise
  expect(ownedSignal.aborted).toBe(true)
  expect(f.receive).toHaveBeenCalledTimes(1)
})

it('expires persistence ownership without acknowledging the delayed write', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  f.receive.mockImplementationOnce(async (_input, signal) => {
    started.resolve(signal)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { cancelled.resolve(undefined); resolve() }, { once: true })
    })
    return saved()
  })
  const request = f.post()
  const ownedSignal = await started.promise
  await cancelled.promise
  const response = await request
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: 'unavailable' })
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(ownedSignal.aborted).toBe(true)
  expect(f.receive).toHaveBeenCalledTimes(1)
}, 20_000)
