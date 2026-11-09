import { twinBindingFixture } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { parseHostTwinBindingOffer, parseHostTwinBindingAck, parseHostTwinBindingDirective,
  encodeHostTwinBindingAck, hostTwinBindingCommandDigest } from '@deepseek-ai/dsh-host-control-protocol'
import { TwinBindingReceipts, type TwinBindingReceiptFile } from '../src/twin-binding-receipts.ts'
import { HostAuthorityError } from '../src/types.ts'

const vector = twinBindingFixture()
function fixture() {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const offer = parseHostTwinBindingOffer(vector.offer, vector)
  const makeAck = (changes: Record<string, unknown> = {}) => {
    const unsigned = parseHostTwinBindingAck({ ...vector.ack, peer: { ...vector.ack.peer, publicKey }, ...changes })
    return parseHostTwinBindingAck({ ...unsigned,
      signature: sign(null, Buffer.from(encodeHostTwinBindingAck(unsigned)), keys.privateKey).toString('base64url') })
  }
  const ack = makeAck()
  const request = parseHostTwinBindingDirective({ ...vector.directive, peer: ack.peer })
  let bytes: Buffer | undefined, writes = 0, writeError: Error | undefined, barrierError: Error | undefined
  const file: TwinBindingReceiptFile = {
    read: () => bytes === undefined ? undefined : Buffer.from(bytes),
    ensureDurable: () => { if (barrierError) throw barrierError },
    write: (value, guard) => { guard(); if (writeError) throw writeError; bytes = Buffer.from(value); writes++ },
  }
  const options = { profileId: ack.hostProfileId, installationId: ack.peer.installationId, publicKey, file }
  return { offer, ack, request, makeAck, options, file,
    store: (limits: { maximumBytes?: number; maximumReceipts?: number } = {}) => new TwinBindingReceipts({ ...options, ...limits }),
    bytes: () => bytes, writes: () => writes, setBytes: (value: Buffer) => { bytes = value },
    failWrite: (error: Error) => { writeError = error },
    barrier: (error?: Error) => { barrierError = error } }
}

it('returns the original signed fact across retries, a new process peer and store recreation', () => {
  const f = fixture(), store = f.store()
  expect(store.read(f.request)).toBeUndefined()
  expect(store.commit(f.offer, f.ack, () => {})).toEqual(f.ack)
  const original = f.bytes()
  const next = f.makeAck({ peer: { ...f.ack.peer, hostInstanceId: f.ack.requestId,
    processNonce: Buffer.alloc(32, 3).toString('base64url') }, durableAt: 2000 })
  expect(f.store().commit(f.offer, next, () => {})).toEqual(f.ack)
  expect(f.store().read(f.request)).toEqual(f.ack)
  expect(f.bytes()).toEqual(original)
  expect(f.writes()).toBe(1)
  expect(f.store().read({ ...f.request, ownerUserId: 'other-owner' })).toBeUndefined()
  expect(f.store().read({ ...f.request, authorityEnvironmentId: f.ack.requestId })).toBeUndefined()
})

it('rejects same-key retargeting and Account version changes without rewriting the original', () => {
  const f = fixture(); f.store().commit(f.offer, f.ack, () => {})
  const original = f.bytes()
  expect(() => f.store().commit(f.offer, f.makeAck({ accountBindingVersion: 2 }), () => {}))
    .toThrow('idempotency_conflict')
  for (const patch of [{ accountBindingId: 'other' }, { accountBindingVersion: 2 },
    { bindingId: f.ack.requestId }, { bindingGeneration: '2' }, { scopeVersion: '2' },
    { scopeDigest: 'a'.repeat(64) }, { payloadDigest: 'b'.repeat(64) }])
    expect(() => f.store().read({ ...f.request, ...patch })).toThrow('idempotency_conflict')
  expect(f.bytes()).toEqual(original)
})

it('serializes different-key commits and checks whole-collection quotas before mutation', () => {
  const f = fixture()
  const otherId = f.ack.hostProfileId
  const second = f.makeAck({ requestId: otherId, payloadDigest: hostTwinBindingCommandDigest(otherId, f.offer) })
  const store = f.store({ maximumReceipts: 1 })
  store.commit(f.offer, f.ack, () => {})
  const original = f.bytes()!
  expect(() => store.commit(f.offer, second, () => {})).toThrow('unavailable')
  expect(f.bytes()).toEqual(original)
  f.store().commit(f.offer, second, () => {})
  const persisted = JSON.parse(f.bytes()!.toString()) as { receipts: unknown[] }
  expect(persisted.receipts).toHaveLength(2)
  expect(f.store().read(f.request)).toEqual(f.ack)
  const tiny = fixture()
  expect(() => tiny.store({ maximumBytes: original.length - 1 }).commit(tiny.offer, tiny.ack, () => {})).toThrow('unavailable')
  expect(tiny.bytes()).toBeUndefined()
})

it('cannot report success before durable write and retains a committed fact when a late fence changes', () => {
  const before = fixture()
  before.failWrite(new HostAuthorityError('unavailable'))
  expect(() => before.store().commit(before.offer, before.ack, () => {})).toThrow('unavailable')
  expect(before.bytes()).toBeUndefined()
  const cancelled = fixture()
  expect(() => cancelled.store().commit(cancelled.offer, cancelled.ack,
    () => { throw new HostAuthorityError('stale') })).toThrow('stale')
  expect(cancelled.bytes()).toBeUndefined()
  const late = fixture(); let checks = 0
  expect(() => late.store().commit(late.offer, late.ack, () => {
    if (++checks === 3) throw new HostAuthorityError('stale')
  })).toThrow('stale')
  expect(late.store().read(late.request)).toEqual(late.ack)
  expect(late.writes()).toBe(1)
})

it('refuses malformed, wrong-owner, forged, duplicate and oversized storage without treating it as empty', () => {
  const f = fixture(); f.store().commit(f.offer, f.ack, () => {})
  const initial = JSON.parse(f.bytes()!.toString()) as { version: number
      profileId: string
      receipts: Array<{ offer: typeof vector.offer; ack: typeof vector.ack }> }, entry = initial.receipts[0]!
  for (const raw of [
    Buffer.from('{'), Buffer.from([0xff]), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{}'),
    Buffer.from(JSON.stringify({ ...initial, version: 2 })),
    Buffer.from(JSON.stringify({ ...initial, profileId: f.ack.requestId })),
    Buffer.from(JSON.stringify({ ...initial, receipts: {} })),
    Buffer.from(JSON.stringify({ ...initial, receipts: [entry, entry] })),
    Buffer.from(JSON.stringify({ ...initial, receipts: [null] })),
    Buffer.from(JSON.stringify({ ...initial, receipts: [{ ...entry, private_chat: 'secret' }] })),
    Buffer.from(JSON.stringify({ ...initial, receipts: [{ ...entry, ack: { ...entry.ack, signature: 'A'.repeat(86) } }] })),
    Buffer.from(JSON.stringify({ ...initial, receipts: [{ ...entry, ack: { ...entry.ack, botId: 'other' } }] })),
    Buffer.alloc(16 * 1024 * 1024 + 1),
  ]) {
    f.setBytes(raw)
    expect(() => f.store().commit(f.offer, f.ack, () => {})).toThrow('unavailable')
    expect(f.bytes()!.equals(raw)).toBe(true)
  }
  expect(f.writes()).toBe(1)
})

it('rejects unsafe owner configuration, unrelated installation facts and uncommitted candidate scope', () => {
  const f = fixture()
  for (const patch of [{ profileId: '../other' }, { installationId: 'bad' }, { publicKey: 'bad' },
    { publicKey: 'B'.repeat(43) }, { maximumBytes: 0 }, { maximumBytes: 16 * 1024 * 1024 + 1 },
    { maximumReceipts: 0 }, { maximumReceipts: 10001 }])
    expect(() => new TwinBindingReceipts({ ...f.options, ...patch })).toThrow('unavailable')
  for (const patch of [{ hostProfileId: f.ack.requestId }, { bindingId: f.ack.requestId },
    { bindingGeneration: '2' }, { scopeVersion: '2' }, { scopeDigest: 'a'.repeat(64) },
    { payloadDigest: 'b'.repeat(64) }, { peer: { ...f.ack.peer, installationId: f.ack.requestId } }])
    expect(() => f.store().commit(f.offer, f.makeAck(patch), () => {})).toThrow('unavailable')
  expect(f.bytes()).toBeUndefined()
})

it('does not recover a published candidate until the platform durability barrier succeeds', () => {
  const f = fixture()
  f.store().commit(f.offer, f.ack, () => {})
  const original = f.bytes()
  f.barrier(new HostAuthorityError('unavailable'))
  expect(() => f.store().read(f.request)).toThrow('unavailable')
  expect(() => f.store().commit(f.offer, f.ack, () => {})).toThrow('unavailable')
  expect(f.bytes()).toEqual(original)
  expect(f.writes()).toBe(1)
  f.barrier()
  expect(f.store().read(f.request)).toEqual(f.ack)
  expect(f.store().commit(f.offer, f.ack, () => {})).toEqual(f.ack)
  expect(f.writes()).toBe(1)
})
