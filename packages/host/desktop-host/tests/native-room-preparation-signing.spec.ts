import { readFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { parseHostNativeRoomPreparationProof, parseHostNativeRoomPreparationWorkerRead,
  encodeHostNativeRoomPreparationProofPayload, type HostNativeRoomPreparationProof,
  type HostControlRequestId } from '@deepseek-ai/dsh-host-control-protocol'
import { signNativeRoomPreparation, verifyNativeRoomPreparationSignatures } from '../src/native-room-preparation-signing.ts'
import { assertNativePreparationCurrent, readAccountNativeRoomPreparation } from '../src/account-native-room-preparation.ts'
import type { BotIdentityAccount } from '../src/account-bot-identity.ts'
import type { DesktopHost } from '../src/desktop-host.ts'

const fixturePath = new URL('../../control-protocol/tests/fixtures/native-room-preparation-v1.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  cases: { result: { outcome: { proof: HostNativeRoomPreparationProof } } }[]
}
const proofs = fixture.cases.map(row => parseHostNativeRoomPreparationProof(row.result.outcome.proof))
// Public deterministic test key, shared with the independently frozen wire fixture.
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 0x2a)]), type: 'pkcs8', format: 'der' }), publicKey = createPublicKey(key)
const signPayload = (payload: Uint8Array) => sign(null, payload, key).toString('base64url')
const verifyPayload = (payload: Uint8Array, signature: string) => verify(null, payload, publicKey, Buffer.from(signature, 'base64url'))
const requestId = '50000000-0000-4000-8000-000000000005' as HostControlRequestId
function unsignedRead(proof: HostNativeRoomPreparationProof) {
  const common = { state: 'observed', operation: proof.output.operation, observation: proof.observation }
  return parseHostNativeRoomPreparationWorkerRead(proof.output.operation === 'prepare_source'
    ? { ...common, source_snapshot: proof.output.source_snapshot }
    : proof.output.operation === 'attest_source' ? common : { ...common, activation_fence: {
      workspace_id: proof.output.activation_assertion.challenge.workspace_id,
      session_id: proof.output.activation_assertion.challenge.session_id,
      group_id: proof.output.activation_assertion.challenge.group_id,
      group_version: proof.output.activation_assertion.challenge.group_version } })
}
function accountFields(proof: HostNativeRoomPreparationProof) {
  const { schema_version: _schema, purpose: _purpose, target: _target, observation: _observation,
    output: _output, host_profile_id: _profile, signature: _signature, ...fields } = proof
  return fields
}

it('signs all three phases and verifies independently frozen original and new domains', () => {
  for (const proof of proofs) {
    const result = signNativeRoomPreparation(unsignedRead(proof), proof.target, proof.host_profile_id,
      accountFields(proof), requestId, signPayload)
    expect(result.state).toBe('prepared')
    if (result.state !== 'prepared') throw Error('missing signed proof')
    expect(result.proof.target).toEqual(proof.target)
    expect(result.proof.observation).toEqual(proof.observation)
    expect(verifyNativeRoomPreparationSignatures(result.proof, verifyPayload)).toBe(true)
    expect(verifyNativeRoomPreparationSignatures(proof, verifyPayload)).toBe(true)
    if (result.proof.output.operation === 'prepare_source') {
      expect(result.proof.output.native_room_assertion.issued_at).toBe(proof.issued_at)
      expect(proof.output.operation).toBe('prepare_source')
      if (proof.output.operation !== 'prepare_source') throw Error('wrong golden artifact')
      expect(result.proof.output.source_snapshot).toEqual(proof.output.source_snapshot)
    } else expect(result).toEqual({ state: 'prepared', proof })
  }
})

it('does not sign inability or mismatched participation and rejects a counterfeit old signature even inside a valid new signature', () => {
  const p = proofs[0]!, signer = vi.fn(signPayload)
  for (const state of ['bot_unavailable', 'room_unavailable', 'membership_changed', 'not_prepared',
    'recovery_required', 'source_conflict', 'too_large'] as const)
    expect(signNativeRoomPreparation({ state }, p.target, p.host_profile_id, accountFields(p), requestId, signer)).toEqual({ state })
  expect(() => signNativeRoomPreparation({ state: 'upgrade_required' }, p.target, p.host_profile_id,
    accountFields(p), requestId, signer)).toThrow(expect.objectContaining({ code: 'upgrade_required' }))
  const read = unsignedRead(p)
  if (read.state !== 'observed') throw Error('missing observation')
  expect(() => signNativeRoomPreparation({ ...read, observation: { ...read.observation, bot_id: 'other' as never } },
    p.target, p.host_profile_id, accountFields(p), requestId, signer)).toThrow()
  expect(signer).not.toHaveBeenCalled()
  for (const proof of proofs) {
    const output = proof.output.operation === 'prepare_source'
      ? { ...proof.output, native_room_assertion: { ...proof.output.native_room_assertion, signature: 'A'.repeat(86) } }
      : proof.output.operation === 'attest_source'
        ? { ...proof.output, source_assertion: { ...proof.output.source_assertion, signature: 'A'.repeat(86) } }
        : { ...proof.output, activation_assertion: { ...proof.output.activation_assertion, signature: 'A'.repeat(86) } }
    const unsigned = parseHostNativeRoomPreparationProof({ ...proof, output })
    const forged = parseHostNativeRoomPreparationProof({ ...unsigned,
      signature: signPayload(encodeHostNativeRoomPreparationProofPayload(unsigned)) })
    expect(verifyNativeRoomPreparationSignatures(forged, verifyPayload)).toBe(false)
    expect(verifyNativeRoomPreparationSignatures({ ...proof, signature: 'A'.repeat(86) as never }, verifyPayload)).toBe(false)
  }
})

it('bounds the complete escaped result frame before either signature and accepts the exact limit', () => {
  const proof = proofs[0]!, read = unsignedRead(proof), signer = vi.fn(signPayload)
  if (read.state !== 'observed' || read.operation !== 'prepare_source') throw Error('missing prepare snapshot')
  const baseline = signNativeRoomPreparation(read, proof.target, proof.host_profile_id, accountFields(proof), requestId, signPayload)
  const bytes = Buffer.byteLength(JSON.stringify({ version: 1, type: 'result', request_id: requestId,
    method: 'profile.native_room_preparation', result: { outcome: baseline } }))
  const padded = { ...read, source_snapshot: { ...read.source_snapshot,
    snapshot_json: read.source_snapshot.snapshot_json + ' '.repeat(49_152 - bytes) } }
  const exact = signNativeRoomPreparation(padded, proof.target, proof.host_profile_id, accountFields(proof), requestId, signer)
  expect(exact.state).toBe('prepared'); expect(signer).toHaveBeenCalledTimes(2)
  signer.mockClear()
  for (const extra of [' ', '\t', ' '.repeat(512)]) {
    expect(signNativeRoomPreparation({ ...padded, source_snapshot: { ...padded.source_snapshot,
      snapshot_json: padded.source_snapshot.snapshot_json + extra } }, proof.target, proof.host_profile_id,
    accountFields(proof), requestId, signer)).toEqual({ state: 'too_large' })
    expect(signer).not.toHaveBeenCalled()
  }
})

it('keeps exact Account/Profile and original challenge authorization before and after worker I/O', async () => {
  for (const p of proofs) {
    let profile = p.host_profile_id, now = p.issued_at
    const account: BotIdentityAccount = {
      authorityEnvironmentId: p.authority_environment_id,
      accountBindingHandle: p.account_binding_handle, authorityBindingVersion: p.authority_binding_version,
      issuer: p.account_issuer, subject: p.account_subject, ownerId: 'fixture-owner' }
    const host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'> = {
      authorizeCollaborationRegistration: vi.fn(), authorizeAccountModelText: () => profile as never }
    const read = unsignedRead(p), signal = new AbortController(), worker = vi.fn(async () => read)
    const workers = { nativeRoomPreparationReceiver: () => ({ read: worker, assertCurrent() {} }) }
    const run = () => readAccountNativeRoomPreparation(host, workers,
      account, p.target, signal.signal, () => now)
    await expect(readAccountNativeRoomPreparation(host, workers, { ...account, ownerId: '' },
      p.target, signal.signal, () => now)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(worker).not.toHaveBeenCalled()
    const actual = await run()
    expect({ profileId: actual.profileId, value: actual.value }).toEqual({ profileId: profile, value: read })
    actual.assertCurrent()
    worker.mockImplementationOnce(async () => { profile = 'f0000000-0000-4000-8000-00000000000f' as never; return read })
    await expect(run()).rejects.toMatchObject({ code: 'profile_mismatch' })
    worker.mockClear()
    await expect(run()).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(worker).not.toHaveBeenCalled(); profile = p.host_profile_id
    worker.mockImplementationOnce(async () => { now = p.target.expires_at; return read })
    await expect(run()).rejects.toMatchObject({ code: 'stale' }); now = p.issued_at
    worker.mockImplementationOnce(async () => { signal.abort(); return read })
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' })
    if (p.target.operation !== 'prepare_source') {
      const mismatch = { ...account, subject: 'different-owner' }
      worker.mockClear()
      await expect(readAccountNativeRoomPreparation(host, workers, mismatch,
        p.target, new AbortController().signal, () => now)).rejects.toMatchObject({ code: 'profile_mismatch' })
      expect(worker).not.toHaveBeenCalled()
    }
  }
})

it('enforces the independent sixty-second lease and the old challenge deadline without extending either', () => {
  for (const p of proofs) {
    expect(() =>{  assertNativePreparationCurrent(p.target, p.issued_at) }).not.toThrow()
    expect(() =>{  assertNativePreparationCurrent(p.target, p.target.expires_at) }).toThrow(expect.objectContaining({ code: 'stale' }))
    expect(() =>{  assertNativePreparationCurrent({ ...p.target, expires_at: p.issued_at + 60_001 }, p.issued_at) })
      .toThrow(expect.objectContaining({ code: 'stale' }))
    if (p.target.operation !== 'prepare_source') {
      const old = p.target.operation === 'attest_source'
        ? { ...p.target, source_challenge: { ...p.target.source_challenge, expires_at: p.issued_at } }
        : { ...p.target, activation_challenge: { ...p.target.activation_challenge, expires_at: p.issued_at } }
      expect(() =>{  assertNativePreparationCurrent(old, p.issued_at) }).toThrow(expect.objectContaining({ code: 'stale' }))
    }
  }
})
