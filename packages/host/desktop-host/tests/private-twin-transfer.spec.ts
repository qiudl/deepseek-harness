import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { HOST_BINDING_INTENT_PURPOSE, HOST_BINDING_RECEIPT_PURPOSE, type HostBindingIntentProof,
  type HostBindingReceiptProof } from '@deepseek-ai/dsh-host-control-protocol'
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
const upload = (bytes: Buffer) => ({ operation: 'finish', ticket, offset: 0, bytes: bytes.toString('base64url'),
  total_bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }) as const
const complete = upload(encoded)

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

const registration = { audience: 'https://slark.example', ownerUserId: 'owner', computerId: 'computer',
  accountBindingId: 'cloud-account', accountBindingVersion: 2, hostEpoch: '7' }
const profileClaims = { ...registration, version: 1 as const, environmentId: otherProfile,
  hostAccountBindingId: 'host-account', hostAccountBindingVersion: 2, profileId: originalProfile, profileEpoch: 4,
  installationId: originalProfile, hostInstanceId: otherProfile, processNonce: ticket,
  mainBotId: request.botId, sessionId: request.sessionId, issuedAt: 100 }
const signature = 'A'.repeat(86)
const { content: _content, operation: _operation, ...workerCoordinates } = request
const scopedClaim = { ...claim, binding_profile_epoch: true } as const
const groupSource = { namespaceId: 'ds-bot:workspace', roomId: 'session-' + otherProfile, groupId: otherProfile,
  memberCount: 2, membersDigest: 'a'.repeat(64) }
const groupEnd = { state: 'group_end', endpoint: registration.audience, receipt: ticket, status: 'ended',
  operationId: originalProfile, source: groupSource, bindingId: otherProfile, bindingVersion: 1 }
const groupEndUpload = upload(Buffer.from(JSON.stringify(groupEnd)))

it('rejects unauthorized intents and binds cached signing to the same registration and Profile generation', async () => {
  const { transfer, owner, operate } = fixture()
  const intent = { requestId: originalProfile, messageSeq: 3, messageDigest: 'a'.repeat(64), previewDigest: 'b'.repeat(64),
    commandDigest: 'c'.repeat(64), expiresAt: 130 }
  const binding = { ...workerCoordinates, operation: 'binding_intent', intent } as const
  const proof: HostBindingIntentProof = { claims: { ...profileClaims, ...intent, purpose: HOST_BINDING_INTENT_PURPOSE,
    messageId: request.sourceMessageId }, signature }
  const signBindingIntent = vi.fn(() => proof)
  const authority = { ...owner, observeBindingProfileEpoch: () => 4, now: () => 110, signBindingIntent }
  const sign = { operation: 'sign_binding', ticket, registration } as const
  await transfer.execute(claim, authority)
  await expect(transfer.execute(sign, authority)).rejects.toMatchObject({ code: 'unauthorized' })
  operate.mockResolvedValueOnce({ request: binding })
  signBindingIntent.mockReturnValueOnce({ ...proof, claims: { ...proof.claims, profileEpoch: 5 } })
  await transfer.execute(scopedClaim, authority)
  await expect(transfer.execute(sign, authority)).rejects.toMatchObject({ code: 'stale' })
  operate.mockResolvedValueOnce({ request: binding })
  await transfer.execute(scopedClaim, authority)
  const { now: _now, ...wallClockAuthority } = authority
  await expect(transfer.execute(sign, wallClockAuthority)).rejects.toMatchObject({ code: 'stale' })
  operate.mockResolvedValueOnce({ request: binding })
  await transfer.execute(scopedClaim, authority)
  await expect(transfer.execute(sign, authority)).resolves.toEqual({ state: 'binding_intent', ticket, proof })
  await expect(transfer.execute({ ...sign, registration: { ...registration, hostEpoch: '8' } }, authority))
    .rejects.toMatchObject({ code: 'stale' })
  expect(signBindingIntent).toHaveBeenCalledTimes(3)
  operate.mockResolvedValueOnce({ request: binding })
  await transfer.execute(scopedClaim, authority)
  await transfer.execute(sign, authority)
  await expect(transfer.execute(groupEndUpload, authority)).resolves.toEqual({ state: 'completed', ticket })
})

it('forwards handoff results only after a current signed receipt and rejects changed lookup coordinates', async () => {
  const { transfer, owner, operate } = fixture()
  const read = { ...workerCoordinates, operation: 'binding_receipt', receipt: ticket } as const
  const proof: HostBindingReceiptProof = { claims: { ...profileClaims, purpose: HOST_BINDING_RECEIPT_PURPOSE,
    lookupBy: 'request', lookupId: originalProfile, expiresAt: 130 }, signature }
  let now = 110
  const signBindingReceipt = vi.fn(() => proof)
  const authority = { ...owner, observeBindingProfileEpoch: () => 4, now: () => now, signBindingReceipt }
  const sign = { operation: 'sign_binding_receipt', ticket, registration, lookup_id: originalProfile } as const
  const start = async () => {
    operate.mockResolvedValueOnce({ request: read })
    await transfer.execute(scopedClaim, authority)
  }
  operate.mockResolvedValueOnce({ request: read })
  await transfer.execute(claim, authority)
  await expect(transfer.execute(sign, authority)).rejects.toMatchObject({ code: 'unauthorized' })
  await start()
  await expect(transfer.execute(groupEndUpload, authority)).rejects.toMatchObject({ code: 'stale' })
  expect(operate.mock.calls.some(([command]) => command.operation === 'finish')).toBe(false)
  await start()
  signBindingReceipt.mockReturnValueOnce({ ...proof, claims: { ...proof.claims, profileEpoch: 5 } })
  await expect(transfer.execute(sign, authority)).rejects.toMatchObject({ code: 'stale' })
  await start()
  const { now: _now, ...wallClockAuthority } = authority
  await expect(transfer.execute(sign, wallClockAuthority)).rejects.toMatchObject({ code: 'stale' })
  await start()
  await expect(transfer.execute(sign, authority)).resolves.toEqual({ state: 'binding_receipt', ticket, proof })
  await expect(transfer.execute({ ...sign, lookup_id: otherProfile }, authority)).rejects.toMatchObject({ code: 'stale' })
  await start()
  await transfer.execute(sign, authority)
  now = proof.claims.expiresAt
  await expect(transfer.execute(sign, authority)).rejects.toMatchObject({ code: 'stale' })
  await start()
  now = 110
  await transfer.execute(sign, authority)
  await expect(transfer.execute(groupEndUpload, authority)).resolves.toEqual({ state: 'completed', ticket })
  expect(operate).toHaveBeenCalledWith({ operation: 'finish', ticket, result: groupEnd }, expect.any(AbortSignal))
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
