import { createHash, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CollaborationDeliveryUploads } from '../src/collaboration-delivery-uploads.ts'

function fixture(answer = '😀'.repeat(32768)) {
  const canonical = (value: unknown): string => value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value)
  const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
  const capsule = { namespace_id: 'ns', projection: { delivery_id: 'd', invocation_id: 'i', plan_id: 'p', task_id: 't', task_revision: '1',
    source_locator: { workspace_id: randomUUID(), session_id: 's', source_message_id: 'm', source_revision: '1' },
    source_snapshot_digest: 'a'.repeat(64), execution_state: 'succeeded', invocation_state_version: '2',
    result_digest: hash({ state: 'succeeded', answer, failure_code: null }), target: { project_id: 'p', agent_id: 'a' },
    target_display_snapshot: { agent_name: 'Guide', project_name: 'Project' }, answer, delivery_state: 'pending', delivery_state_version: '1' } }
  const { delivery_state: _state, delivery_state_version: _version, ...body } = capsule.projection
  const commit = { namespace_id: 'ns', delivery_id: 'd', invocation_id: 'i', source_locator: body.source_locator,
    source_snapshot_digest: body.source_snapshot_digest, result_digest: body.result_digest,
    host_journal_commit: { journal_id: randomUUID(), commit_version: '1', content_digest: hash({ namespace_id: 'ns', ...body }) } }
  const receive = vi.fn(async (_capsule: unknown, _signal: AbortSignal) => commit), assertCurrent = vi.fn(), authorize = vi.fn()
  const lifetime = new AbortController(), upload_id = randomUUID(), bytes = Buffer.from(JSON.stringify(capsule))
  const payload_digest = createHash('sha256').update(bytes).digest('hex'), uploads = new CollaborationDeliveryUploads()
  const chunks = Array.from({ length: Math.ceil(bytes.length / 16384) }, (_, i) => ({ upload_id, offset: i * 16384,
    total_bytes: bytes.length, payload_digest, chunk_base64url: bytes.subarray(i * 16384, (i + 1) * 16384).toString('base64url') }))
  const input = { ownerId: 'owner', bindingKey: 'binding', signal: lifetime.signal, authorize,
    capture: () => ({ assertCurrent, receive }) }
  return { uploads, input, chunks, capsule, commit, receive, lifetime, assertCurrent, authorize }
}
it('commits the complete Unicode reply once, after sequential bounded fragments and matching durable coordinates', async () => {
  const f = fixture()
  for (const [i, chunk] of f.chunks.entries()) {
    const result = await f.uploads.accept({ ...f.input, chunk })
    expect(result.kind).toBe(i === f.chunks.length - 1 ? 'committed' : 'staged')
  }
  expect(f.receive).toHaveBeenCalledTimes(1)
  expect(f.receive.mock.calls[0]?.[0]).toEqual(f.capsule)
  f.lifetime.abort()
})
it('replays identical fragments without advancing twice and refuses conflicting/order/binding changes', async () => {
  const f = fixture()
  const first = await f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })
  expect(await f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })).toEqual(first)
  await expect(f.uploads.accept({ ...f.input, chunk: f.chunks[2]! })).rejects.toThrow()
  expect(f.receive).not.toHaveBeenCalled()
  const conflicting = fixture()
  await conflicting.uploads.accept({ ...conflicting.input, chunk: conflicting.chunks[0]! })
  await expect(conflicting.uploads.accept({ ...conflicting.input, chunk: { ...conflicting.chunks[0]!,
    chunk_base64url: Buffer.alloc(16384).toString('base64url') } })).rejects.toThrow()
  const other = fixture()
  await other.uploads.accept({ ...other.input, chunk: other.chunks[0]! })
  await expect(other.uploads.accept({ ...other.input, bindingKey: 'other', chunk: other.chunks[1]! })).rejects.toThrow()
  f.lifetime.abort(); other.lifetime.abort(); conflicting.lifetime.abort()
})
it('refuses replaced workers, revoked Accounts, digest substitution and mismatching private commit', async () => {
  for (const kind of ['worker', 'account', 'digest', 'commit']) {
    const f = fixture('short')
    if (kind === 'worker') f.assertCurrent.mockImplementation(() => { throw Error('stale') })
    if (kind === 'account') f.authorize.mockImplementation(() => { throw Error('revoked') })
    if (kind === 'commit') f.receive.mockResolvedValue({ ...f.commit, result_digest: 'b'.repeat(64) })
    await expect(f.uploads.accept({ ...f.input, chunk: { ...f.chunks[0]!, ...(kind === 'digest' ? { payload_digest: 'b'.repeat(64) } : {}) } })).rejects.toThrow()
    if (kind !== 'commit') expect(f.receive).not.toHaveBeenCalled()
    f.lifetime.abort()
  }
})

it('rejects malformed complete reply bytes before a worker write and releases the upload reservation', async () => {
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('[]')]) {
    const f = fixture('short')
    try {
      await expect(f.uploads.accept({ ...f.input, chunk: { ...f.chunks[0]!, total_bytes: bytes.length,
        payload_digest: createHash('sha256').update(bytes).digest('hex'), chunk_base64url: bytes.toString('base64url'),
      } })).rejects.toMatchObject({ code: 'unavailable' })
      expect(f.receive).not.toHaveBeenCalled()
      expect((await f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })).kind).toBe('committed')
      expect(f.receive).toHaveBeenCalledTimes(1)
    } finally { f.lifetime.abort() }
  }
})
it('keeps the budget reserved while an aborted or concurrent durable write settles, and never reports a late commit', async () => {
  const f = fixture('short'); let finish!: () => void
  f.receive.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve }); return f.commit })
  const pending = f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })
  await vi.waitFor(() => { expect(f.receive).toHaveBeenCalledTimes(1) })
  await expect(f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })).rejects.toThrow()
  f.lifetime.abort()
  const fragment = fixture(), pendingOwners = Array.from({ length: 4 }, () => new AbortController())
  const reserve = (i: number) => f.uploads.accept({ ...f.input, ownerId: `pending-${i}`, signal: pendingOwners[i]!.signal,
    chunk: fragment.chunks[0]! })
  for (let i = 0; i < 3; i++) await reserve(i)
  await expect(reserve(3)).rejects.toThrow()
  finish()
  await expect(pending).rejects.toThrow()
  expect((await reserve(3)).kind).toBe('staged')
  pendingOwners.forEach((owner) => { owner.abort() }); fragment.lifetime.abort()
  expect(f.receive).toHaveBeenCalledTimes(1)
})
it('bounds all connections together and reclaims abandoned upload capacity on connection closure', async () => {
  const f = fixture(), owners: AbortController[] = []
  for (let i = 0; i < 4; i++) {
    const lifetime = new AbortController(); owners.push(lifetime)
    await f.uploads.accept({ ...f.input, ownerId: `owner-${i}`, signal: lifetime.signal, chunk: { ...f.chunks[0]!, upload_id: randomUUID() } })
  }
  await expect(f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })).rejects.toThrow()
  owners[0]!.abort()
  expect((await f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })).kind).toBe('staged')
  owners.forEach((owner) => { owner.abort() }); f.lifetime.abort()
})
it('expires pending fragments and does not resume their bytes under a fresh upload offset', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    await f.uploads.accept({ ...f.input, chunk: f.chunks[0]! })
    await vi.advanceTimersByTimeAsync(30001)
    await expect(f.uploads.accept({ ...f.input, chunk: f.chunks[1]! })).rejects.toThrow()
    f.lifetime.abort()
  } finally { vi.useRealTimers() }
})
