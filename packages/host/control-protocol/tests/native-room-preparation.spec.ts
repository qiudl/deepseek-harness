import type { HostControlFrame } from '../src/types.ts'
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'
import { parseHostNativeRoomPreparationTarget, parseHostNativeRoomPreparationProof,
  parseHostNativeRoomPreparationOutcome, encodeHostNativeRoomPreparationProofPayload } from '../src/native-room-preparation.ts'
import type { HostNativeRoomPreparationProof } from '../src/native-room-preparation.ts'

interface Golden {
  key: { public_key_spki_pem: string }
  cases: { name: string
    request: Record<string, unknown>
    result: { outcome: { state: 'prepared'; proof: HostNativeRoomPreparationProof } }
    expected: { payload_base64: string; payload_sha256: string; signature: string } }[]
}
const golden = JSON.parse(readFileSync(new URL('./fixtures/native-room-preparation-v1.json', import.meta.url), 'utf8')) as Golden
function rawProof(index = 0): Record<string, unknown> {
  return JSON.parse(JSON.stringify(golden.cases[index]!.result.outcome.proof)) as Record<string, unknown>
}
const child = (value: Record<string, unknown>, key: string) => value[key] as Record<string, unknown>

const ids = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004']
const otherId = 'f0000000-0000-4000-8000-00000000000f'
const params = { client_instance_id: ids[0], host_instance_id: ids[1], process_nonce: 'A'.repeat(43),
  jti: ids[2], issued_at: 1000, expires_at: 2000, authority_environment_id: ids[3],
  account_binding_handle: 'binding-1', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.test', account_subject: ids[1] }
const base = { challenge_nonce: 'A'.repeat(43), expires_at: 2000, binding_id: ids[0],
  binding_generation: '9007199254740993', computer_id: 'computer-1',
  slark_audience: 'https://slark.example.test', expected_profile_id: ids[2],
  bot_id: 'bot-1', room_id: 'room-1', workspace_id: ids[3], member_set_digest: 'a'.repeat(64) }
const source = { workspace_id: ids[3], session_id: 'original-bridge', source_message_id: 'original-message',
  source_revision: '1', snapshot_digest: 'b'.repeat(64) }
const challenge = { request_id: ids[0], challenge_nonce: 'A'.repeat(43), expires_at: 4000,
  audience: base.slark_audience, environment_id: params.authority_environment_id,
  account_issuer: params.account_issuer, account_subject: params.account_subject,
  workspace_id: source.workspace_id, session_id: source.session_id }
const targets = [
  { ...base, operation: 'prepare_source', expected_source: null },
  { ...base, operation: 'prepare_source', expected_source: source },
  { ...base, operation: 'attest_source', source_challenge: { ...challenge, ...source, host_epoch: '5' } },
  { ...base, operation: 'attest_activation', source,
    activation_challenge: { ...challenge, group_id: ids[0], group_version: 1 } },
]

it('retains the original native-room method while separately decoding all three preparation stages', () => {
  const original = { version: 1, type: 'request', request_id: ids[0], method: 'profile.native_room',
    params: { ...params, room_id: base.room_id } }
  const legacy = decodeHostControlFrame(JSON.stringify(original) + '\n')
  expect(JSON.parse(encodeHostControlFrame(legacy))).toEqual(original)
  for (const target of targets) {
    const frame = { version: 1, type: 'request', request_id: ids[0], method: 'profile.native_room_preparation',
      params: { ...params, target } }
    const decoded = decodeHostControlFrame(JSON.stringify(frame) + '\n')
    expect(JSON.parse(encodeHostControlFrame(decoded))).toEqual(frame)
  }
})

it('keeps definite inability to prepare separate from a signed successful proof', () => {
  for (const state of ['bot_unavailable', 'room_unavailable', 'membership_changed', 'not_prepared',
    'recovery_required', 'source_conflict', 'too_large']) {
    const frame = { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_preparation',
      result: { outcome: { state } } }
    const decoded = decodeHostControlFrame(JSON.stringify(frame) + '\n')
    expect(JSON.parse(encodeHostControlFrame(decoded))).toEqual(frame)
  }
})

it('matches all independently constructed signature bytes including the known original Source branch', () => {
  expect(golden.cases.map(value => value.name)).toEqual(['prepare_source', 'attest_source', 'attest_activation', 'prepare_source_known'])
  const key = createPublicKey(golden.key.public_key_spki_pem)
  for (const fixture of golden.cases) {
    const proof = parseHostNativeRoomPreparationProof(fixture.result.outcome.proof)
    const payload = encodeHostNativeRoomPreparationProofPayload(proof)
    expect(payload.toString('base64'), fixture.name).toBe(fixture.expected.payload_base64)
    expect(createHash('sha256').update(payload).digest('hex')).toBe(fixture.expected.payload_sha256)
    expect(proof.signature).toBe(fixture.expected.signature)
    expect(verify(null, payload, key, Buffer.from(proof.signature, 'base64url'))).toBe(true)
    const request = { version: 1, type: 'request', request_id: ids[0], ...fixture.request }
    const response = { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_preparation', result: fixture.result }
    for (const frame of [request, response]) {
      const encoded = encodeHostControlFrame(JSON.parse(JSON.stringify(frame)) as HostControlFrame)
      expect(JSON.parse(encodeHostControlFrame(decodeHostControlFrame(encoded)))).toEqual(frame)
    }
  }
})

it('rejects invalid selectors and unrecognized stages before any authority or Source read', () => {
  const valid = child(rawProof(), 'target')
  for (const invalid of [null, [], '', {}, { ...valid, operation: 'other' }, { ...valid, extra: true },
    { ...valid, expires_at: 0 }, { ...valid, expires_at: -1 }, { ...valid, expires_at: '1' },
    { ...valid, binding_generation: 1 }, { ...valid, binding_generation: '9223372036854775808' },
    { ...valid, binding_id: 'wrong' }, { ...valid, computer_id: '../computer' },
    { ...valid, slark_audience: 'http://slark.example.test' }, { ...valid, slark_audience: 'https://slark.example.test/path' },
    { ...valid, slark_audience: 'https://a:b@slark.example.test' },
    { ...valid, slark_audience: 'https://[' }, { ...valid, expected_profile_id: 'wrong' },
    { ...valid, bot_id: 'has space' }, { ...valid, room_id: '..' }, { ...valid, workspace_id: 'wrong' },
    { ...valid, member_set_digest: 'A'.repeat(64) }, { ...valid, challenge_nonce: 'A'.repeat(42) },
    { ...valid, challenge_nonce: 'A'.repeat(42) + 'B' }, { ...valid, challenge_nonce: 1 },
  ]) expect(() => parseHostNativeRoomPreparationTarget(invalid)).toThrow()
  let touched = 0
  expect(() => parseHostNativeRoomPreparationTarget({ ...valid, get operation() { touched++; return 'prepare_source' } })).toThrow()
  expect(() => parseHostNativeRoomPreparationTarget({ ...valid, get room_id() { touched++; return 'room' } })).toThrow()
  expect(() => parseHostNativeRoomPreparationTarget(Object.defineProperty({}, 'operation', { value: 'prepare_source' }))).toThrow()
  expect(touched).toBe(0)
})

it('binds original descriptors, revisions, group versions and Slark audience in each target', () => {
  for (const index of [1, 2, 3]) {
    const original = child(rawProof(index), 'target')
    for (const change of [
      { workspace_id: ids[0] },
      ...(index === 1 ? [{ slark_audience: 'https://other.example.test' }] : []),
    ]) expect(() => parseHostNativeRoomPreparationTarget({ ...original, ...change })).toThrow()
  }
  const known = child(rawProof(3), 'target'), originalSource = child(known, 'expected_source')
  for (const change of [{ source_revision: '2' }, { extra: true }, { workspace_id: ids[0] }])
    expect(() => parseHostNativeRoomPreparationTarget({ ...known, expected_source: { ...originalSource, ...change } })).toThrow()
  const sourced = child(rawProof(1), 'target'), sourceChallenge = child(sourced, 'source_challenge')
  for (const change of [{ source_revision: '2' }, { host_epoch: 1 }, { extra: true }])
    expect(() => parseHostNativeRoomPreparationTarget({ ...sourced, source_challenge: { ...sourceChallenge, ...change } })).toThrow()
  const activation = child(rawProof(2), 'target'), fence = child(activation, 'activation_challenge')
  for (const change of [{ group_version: 2 }, { session_id: 'different' }, { audience: 'https://other.example.test' }, { extra: true }])
    expect(() => parseHostNativeRoomPreparationTarget({ ...activation, activation_challenge: { ...fence, ...change } })).toThrow()
})

it('requires the actual observed participant, Profile, Source and signed artifact identity to agree', () => {
  for (const change of [{ schema_version: 2 }, { purpose: 'native_room_projection' }, { extra: true },
    { host_profile_id: ids[0] }, { issued_at: Number.MAX_SAFE_INTEGER }, { authority_binding_version: 0 },
    { signature: 'A'.repeat(85) }, { installation_public_key: 'bad' }])
    expect(() => parseHostNativeRoomPreparationProof({ ...rawProof(), ...change })).toThrow()
  for (const [key, value] of Object.entries({ bot_id: 'other-bot', room_id: 'other-room', workspace_id: ids[0],
    member_set_digest: 'c'.repeat(64) })) {
    const raw = rawProof()
    Object.assign(child(raw, 'observation'), { [key]: value })
    expect(() => parseHostNativeRoomPreparationProof(raw), key).toThrow()
  }
  for (const index of [0, 1, 2]) {
    const raw = rawProof(index)
    Object.assign(child(raw, 'output'), { operation: 'unknown' })
    expect(() => parseHostNativeRoomPreparationProof(raw)).toThrow()
    const wrong = rawProof(index)
    wrong.output = rawProof((index + 1) % 3).output
    expect(() => parseHostNativeRoomPreparationProof(wrong)).toThrow()
  }
  const raw = rawProof(3)
  Object.assign(child(child(raw, 'target'), 'expected_source'), { snapshot_digest: 'c'.repeat(64) })
  expect(() => parseHostNativeRoomPreparationProof(raw)).toThrow()
})

it('rejects each old artifact when current Host identity or Account fields differ', () => {
  for (const index of [0, 1, 2]) {
    const artifactName = index === 0 ? 'native_room_assertion' : index === 1 ? 'source_assertion' : 'activation_assertion'
    for (const [key, value] of Object.entries({ installation_id: otherId, installation_public_key: 'A'.repeat(43),
      host_instance_id: otherId, process_nonce: 'B'.repeat(42) + 'A' })) {
      const raw = rawProof(index)
      Object.assign(child(child(raw, 'output'), artifactName), { [key]: value })
      expect(() => parseHostNativeRoomPreparationProof(raw), `${index}/${key}`).toThrow()
    }
  }
  for (const [key, value] of Object.entries({ authority_environment_id: ids[0], account_binding_handle: 'other-binding',
    authority_binding_version: 2, account_issuer: 'https://other.example.test', account_subject: ids[0],
    issued_at: 1 })) {
    const raw = rawProof()
    Object.assign(child(child(raw, 'output'), 'native_room_assertion'), { [key]: value })
    expect(() => parseHostNativeRoomPreparationProof(raw), key).toThrow()
  }
  for (const index of [1, 2]) {
    const artifactName = index === 1 ? 'source_assertion' : 'activation_assertion'
    for (const [key, value] of Object.entries({ environment_id: ids[0], account_issuer: 'https://other.example.test',
      account_subject: ids[0], audience: 'https://other.example.test', request_id: ids[0], session_id: 'other-session' })) {
      const raw = rawProof(index)
      Object.assign(child(child(child(raw, 'output'), artifactName), 'challenge'), { [key]: value })
      expect(() => parseHostNativeRoomPreparationProof(raw), `${index}/${key}`).toThrow()
    }
  }
})

it('keeps returned data detached and rejects extra fields on definite failure outcomes', () => {
  const raw = rawProof(), parsed = parseHostNativeRoomPreparationProof(raw)
  Object.assign(child(raw, 'target'), { computer_id: 'changed-after-read' })
  expect(parsed.target.computer_id).not.toBe('changed-after-read')
  expect(parseHostNativeRoomPreparationOutcome({ state: 'prepared', proof: parsed })).toEqual({ state: 'prepared', proof: parsed })
  for (const value of [null, [], {}, { state: 'unknown' }, { state: 'not_prepared', proof: parsed },
    { state: 'prepared', proof: parsed, extra: true }]) expect(() => parseHostNativeRoomPreparationOutcome(value)).toThrow()
})

it('bounds the complete escaped frame and rejects invalid raw UTF8 or oversized snapshots', () => {
  const original = rawProof()
  const output = child(original, 'output'), capsule = child(output, 'source_snapshot')
  const json = capsule.snapshot_json as string
  const frame = { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_preparation',
    result: { outcome: { state: 'prepared', proof: original } } }
  const encoded = encodeHostControlFrame(JSON.parse(JSON.stringify(frame)) as HostControlFrame)
  const padding = 49_152 - (Buffer.byteLength(encoded, 'utf8') - 1)
  expect(padding).toBeGreaterThan(0)
  capsule.snapshot_json = json + ' '.repeat(padding)
  const exact = encodeHostControlFrame(JSON.parse(JSON.stringify(frame)) as HostControlFrame)
  expect(Buffer.byteLength(exact, 'utf8') - 1).toBe(49_152)
  expect(decodeHostControlFrame(exact).type).toBe('result')
  capsule.snapshot_json = String(capsule.snapshot_json) + ' '
  expect(() => encodeHostControlFrame(JSON.parse(JSON.stringify(frame)) as HostControlFrame)).toThrow()
  const proofBytes = Buffer.byteLength(JSON.stringify(original), 'utf8')
  capsule.snapshot_json = String(capsule.snapshot_json) + ' '.repeat(49_153 - proofBytes)
  expect(() => parseHostNativeRoomPreparationProof(original)).toThrow()
  for (const invalid of [null, '\ud800', json + ' '.repeat(49_153)]) {
    const raw = rawProof()
    child(child(raw, 'output'), 'source_snapshot').snapshot_json = invalid
    expect(() => parseHostNativeRoomPreparationProof(raw)).toThrow()
  }
})

it('covers all Source and activation descriptor comparisons without replacing original identities', () => {
  const raw = rawProof()
  const source = child(child(child(raw, 'output'), 'native_room_assertion'), 'binding')
  child(source, 'source').session_id = 'another-original-session'
  expect(() => parseHostNativeRoomPreparationProof(raw)).toThrow()
  const changedSnapshot = rawProof()
  child(child(child(changedSnapshot, 'output'), 'source_snapshot'), 'descriptor').snapshot_digest = 'c'.repeat(64)
  expect(() => parseHostNativeRoomPreparationProof(changedSnapshot)).toThrow()
  for (const index of [1, 2]) {
    const changed = rawProof(index)
    child(child(changed, 'observation'), 'source').snapshot_digest = 'c'.repeat(64)
    expect(() => parseHostNativeRoomPreparationProof(changed)).toThrow()
  }
})

it('invalidates an original signature after valid selector, artifact-signature or raw-snapshot changes', () => {
  const key = createPublicKey(golden.key.public_key_spki_pem)
  const original = parseHostNativeRoomPreparationProof(rawProof())
  const signature = Buffer.from(original.signature, 'base64url')
  for (const change of [{ binding_id: otherId }, { binding_generation: '9007199254740995' },
    { computer_id: 'another-computer' }, { slark_audience: 'https://another.example.test' },
    { challenge_nonce: 'A'.repeat(43) }]) {
    const raw = rawProof()
    Object.assign(child(raw, 'target'), change)
    const changed = parseHostNativeRoomPreparationProof(raw)
    expect(verify(null, encodeHostNativeRoomPreparationProofPayload(changed), key, signature)).toBe(false)
  }
  const replacedArtifact = rawProof()
  child(child(replacedArtifact, 'output'), 'native_room_assertion').signature = 'A'.repeat(86)
  const replaced = parseHostNativeRoomPreparationProof(replacedArtifact)
  expect(verify(null, encodeHostNativeRoomPreparationProofPayload(replaced), key, signature)).toBe(false)
  const padded = rawProof()
  const capsule = child(child(padded, 'output'), 'source_snapshot')
  capsule.snapshot_json = String(capsule.snapshot_json) + ' '
  expect(verify(null, encodeHostNativeRoomPreparationProofPayload(parseHostNativeRoomPreparationProof(padded)), key, signature)).toBe(false)
  const outerSignature = rawProof()
  outerSignature.signature = 'A'.repeat(86)
  expect(encodeHostNativeRoomPreparationProofPayload(parseHostNativeRoomPreparationProof(outerSignature)))
    .toEqual(encodeHostNativeRoomPreparationProofPayload(original))
})
