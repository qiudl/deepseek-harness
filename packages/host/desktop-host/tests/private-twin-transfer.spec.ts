import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { PrivateTwinTransfer } from '../src/private-twin-transfer.ts'
import type { PrivateTwinWorkerCommand, PrivateTwinWorkerReply } from '../src/private-twin-worker-protocol.ts'

const originalProfile = 'b3eeeaf0-6d61-4f7c-a6ad-feccae862c10'
const otherProfile = 'ba663a74-8112-4757-a607-1941cae198b5'
const ticket = Buffer.alloc(32, 47).toString('base64url')
const request = { operation: 'send', ticket, botId: 'bot', sessionId: 'session',
  callId: 'call', rootCallId: 'call', sourceMessageId: 'user', content: 'question' } as const
const claim = { operation: 'claim' } as const
const check = { operation: 'check', ticket } as const
const result = { state: 'accepted', receipt: ticket } as const
const encoded = Buffer.from(JSON.stringify(result))
const complete = { operation: 'finish', ticket, offset: 0, bytes: encoded.toString('base64url'),
  total_bytes: encoded.length, digest: createHash('sha256').update(encoded).digest('hex') } as const

function fixture() {
  const signal = new AbortController().signal
  const transfer = new PrivateTwinTransfer(signal)
  const operate = vi.fn(async (command: PrivateTwinWorkerCommand): Promise<PrivateTwinWorkerReply> => {
    if (command.operation === 'claim') return { request }
    if (command.operation === 'check') return { current: true }
    return { completed: true }
  })
  const authorize = vi.fn(() => originalProfile)
  const owner = { key: 'paired-account', signal, authorize, capture: () => ({ assertCurrent() {}, operate }) }
  return { transfer, owner, operate, authorize }
}

it('serializes claims and refuses another account without consuming the original lease', async () => {
  const { transfer, owner, operate } = fixture()
  const captured = Promise.withResolvers<PrivateTwinWorkerReply>()
  operate.mockImplementationOnce(async () => captured.promise)
  const pending = transfer.execute(claim, owner)
  await expect(transfer.execute(claim, owner)).rejects.toMatchObject({ code: 'busy' })
  captured.resolve({ request })
  await expect(pending).resolves.toMatchObject({ state: 'claimed', ticket })
  await expect(transfer.execute(claim, owner)).rejects.toMatchObject({ code: 'busy' })
  await expect(transfer.execute(check, { ...owner, key: 'different-account' })).rejects.toMatchObject({ code: 'stale' })
  await expect(transfer.execute({ ...check, ticket: Buffer.alloc(32, 31).toString('base64url') }, owner))
    .rejects.toMatchObject({ code: 'stale' })
  await expect(transfer.execute(complete, owner)).resolves.toEqual({ state: 'completed', ticket })
  operate.mockResolvedValueOnce({ request: null })
  await expect(transfer.execute(claim, owner)).resolves.toEqual({ state: 'idle' })
})

it('rechecks Account scope after Worker I/O and retires a cleared transfer during a check', async () => {
  const { transfer, owner, operate, authorize } = fixture()
  authorize.mockReturnValueOnce(originalProfile).mockReturnValueOnce(otherProfile)
  await expect(transfer.execute(claim, owner)).rejects.toMatchObject({ code: 'stale' })
  await transfer.execute(claim, owner)
  operate.mockImplementationOnce(async () => { transfer.clear(); return { current: true } })
  await expect(transfer.execute(check, owner)).rejects.toMatchObject({ code: 'stale' })
  await transfer.execute(claim, owner)
  authorize.mockReturnValueOnce(originalProfile).mockReturnValueOnce(originalProfile).mockReturnValueOnce(otherProfile)
  await expect(transfer.execute(check, owner)).rejects.toMatchObject({ code: 'stale' })
})

it('rejects out-of-bounds reads and an upload that resumes at a different offset', async () => {
  const { transfer, owner, operate } = fixture()
  const header = await transfer.execute(claim, owner)
  assertClaimed(header)
  await expect(transfer.execute({ operation: 'read', ticket, offset: header.total_bytes }, owner))
    .rejects.toMatchObject({ code: 'stale' })
  await transfer.execute(claim, owner)
  const first = { ...complete, bytes: encoded.subarray(0, 1).toString('base64url') }
  await expect(transfer.execute(first, owner)).resolves.toEqual({ state: 'staged', ticket, next_offset: 1 })
  const skipped = { ...complete, offset: 2, bytes: encoded.subarray(2).toString('base64url') }
  await expect(transfer.execute(skipped, owner)).rejects.toMatchObject({ code: 'stale' })
  expect(operate.mock.calls.some(([command]) => command.operation === 'finish')).toBe(false)
})

it('pins a binding claim to the Native generation before and after every Worker exchange', async () => {
  const { transfer, owner, operate } = fixture()
  const scopedClaim = { operation: 'claim', binding_profile_epoch: true } as const
  const scoped = { ticket, botId: request.botId, sessionId: request.sessionId, callId: request.callId,
    rootCallId: request.rootCallId, sourceMessageId: request.sourceMessageId,
    operation: 'binding_propose', proposal: { kind: 'twin', action: 'bind',
      sourceRef: ticket, sourceId: 'child', targetRef: ticket, defaultAgentRef: null, messageSeq: 2 } } as const
  let epoch = 4
  const authority = { ...owner, observeBindingProfileEpoch: () => epoch }
  await expect(transfer.execute(scopedClaim, owner)).rejects.toMatchObject({ code: 'upgrade_required' })
  operate.mockImplementationOnce(async () => { epoch++; return { request: scoped } })
  await expect(transfer.execute(scopedClaim, authority)).rejects.toMatchObject({ code: 'stale' })
  operate.mockResolvedValueOnce({ request: scoped })
  await expect(transfer.execute(scopedClaim, authority)).resolves.toMatchObject({ state: 'claimed', binding_profile_epoch: 5 })
  operate.mockImplementationOnce(async () => { epoch++; return { current: true } })
  await expect(transfer.execute(check, authority)).rejects.toMatchObject({ code: 'stale' })
  expect(operate.mock.calls.some(([command]) => command.operation === 'finish')).toBe(false)
  operate.mockResolvedValueOnce({ request: scoped })
  const legacy = await transfer.execute(claim, authority)
  expect(legacy).not.toHaveProperty('binding_profile_epoch')
})

function assertClaimed<T extends { state: string }>(result: T): asserts result is Extract<T, { state: 'claimed' }> {
  if (result.state !== 'claimed') throw Error('expected a claimed transfer')
}

it('expires a live transfer without invalidating the replacement when an old deadline fires', async () => {
  const { transfer, owner } = fixture()
  const first = new AbortController(), second = new AbortController(), third = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(first.signal)
    .mockReturnValueOnce(second.signal).mockReturnValueOnce(third.signal)
  try {
    await transfer.execute(claim, owner)
    await transfer.execute(complete, owner)
    await transfer.execute(claim, owner)
    first.abort()
    await expect(transfer.execute(check, owner)).resolves.toEqual({ state: 'current', ticket })
    second.abort()
    await expect(transfer.execute(check, owner)).rejects.toMatchObject({ code: 'stale' })
    await expect(transfer.execute(claim, owner)).resolves.toMatchObject({ state: 'claimed', ticket })
    third.abort()
  } finally { timeout.mockRestore() }
})
