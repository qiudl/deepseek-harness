import { readFileSync } from 'node:fs'
import { createPublicKey } from 'node:crypto'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { parseHostNativeRoomRetirementCommand, parseHostNativeRoomRetirementTarget, parseHostNativeRoomRetirementReply, parseHostNativeRoomRetirementProof, encodeHostNativeRoomRetirementProofPayload } from '../src/bound-bot-rooms.ts'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'

const ids = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004']
const join = { operation: 'join', room_id: 'room-1', group_id: ids[0], member_id: ids[1],
  cycle: 1, project_id: 'project', agent_id: 'my-twin', name: 'My twin' }
const target = { challenge_nonce: 'A'.repeat(43), expires_at: 2000, binding_id: ids[0],
  binding_generation: '9007199254740993', join_command_request_id: ids[2], join_command: join,
  leave_command_request_id: ids[3],
  leave_command: { operation: 'leave', room_id: join.room_id, member_id: join.member_id, cycle: join.cycle } }
const authority = { host_profile_id: ids[2], authority_environment_id: ids[3], account_binding_handle: 'binding-1',
  authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: ids[1],
  installation_id: ids[2], installation_public_key: 'A'.repeat(43), host_instance_id: ids[3],
  process_nonce: 'A'.repeat(43), issued_at: 1000, signature: 'A'.repeat(86) }
const params = { client_instance_id: ids[0], host_instance_id: ids[1], process_nonce: 'A'.repeat(43),
  jti: ids[2], issued_at: 1000, expires_at: 2000, authority_environment_id: ids[3],
  account_binding_handle: 'binding-1', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.test', account_subject: ids[1] }

it('negotiates a retirement request retaining both exact original commands', () => {
  const frame = { version: 1, type: 'request', request_id: ids[0], method: 'profile.native_room_retirement',
    params: { ...params, target } }
  expect(JSON.parse(encodeHostControlFrame(decodeHostControlFrame(JSON.stringify(frame) + '\n')))).toEqual(frame)
})

it('returns a separately typed durable left proof at sequence zero', () => {
  const proof = { schema_version: 1, purpose: 'native_room_retirement', target,
    reply: { state: 'left', left_room_seq: 0 }, ...authority }
  const frame = { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_retirement', result: { proof } }
  expect(JSON.parse(encodeHostControlFrame(decodeHostControlFrame(JSON.stringify(frame) + '\n')))).toEqual(frame)
})

const rawProof = () => ({ schema_version: 1, purpose: 'native_room_retirement', target: structuredClone(target),
  reply: { state: 'left', left_room_seq: 0 }, ...authority })

it('retains only an exact join identity and rejects cross-cycle command pairs', () => {
  expect(parseHostNativeRoomRetirementCommand(join)).toEqual(join)
  expect(() => parseHostNativeRoomRetirementCommand(target.leave_command)).toThrow()
  const parsed = parseHostNativeRoomRetirementTarget(target)
  expect(parsed.binding_generation).toBe('9007199254740993')
  for (const invalid of [
    { ...target, leave_command: join }, { ...target, join_command: target.leave_command },
    { ...target, join_command_request_id: target.leave_command_request_id },
    { ...target, join_command_request_id: 'invalid' }, { ...target, leave_command_request_id: 'invalid' },
    { ...target, leave_command: { ...target.leave_command, room_id: 'other' } },
    { ...target, leave_command: { ...target.leave_command, member_id: ids[0] } },
    { ...target, leave_command: { ...target.leave_command, cycle: 2 } },
    { ...target, profile_id: ids[2] }, { ...target, binding_generation: 1 },
    { ...target, join_command: { ...join, name: '\ud800' } },
  ]) expect(() => parseHostNativeRoomRetirementTarget(invalid), JSON.stringify(invalid)).toThrow()
  const input = structuredClone(target)
  const detached = parseHostNativeRoomRetirementTarget(input)
  input.join_command.name = 'changed'
  expect(detached.join_command.name).toBe('My twin')
})

it('accepts durable nonnegative safe boundaries and keeps inability to retire explicit', () => {
  for (const left_room_seq of [0, 1, Number.MAX_SAFE_INTEGER])
    expect(parseHostNativeRoomRetirementReply({ state: 'left', left_room_seq })).toEqual({ state: 'left', left_room_seq })
  for (const state of ['upgrade_required', 'unavailable', 'invalid', 'conflict'])
    expect(parseHostNativeRoomRetirementReply({ state })).toEqual({ state })
  for (const left_room_seq of [-1, '0', null, false, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    expect(() => parseHostNativeRoomRetirementReply({ state: 'left', left_room_seq })).toThrow()
  for (const invalid of [null, {}, [], 'left', { state: 'joined', joined_room_seq: 0 },
    { state: 'unavailable', private: true }, { state: 'left', left_room_seq: 0, private: true }])
    expect(() => parseHostNativeRoomRetirementReply(invalid)).toThrow()
  let touched = 0
  expect(() => parseHostNativeRoomRetirementReply({ get state() { touched++; return 'left' } })).toThrow()
  expect(() => parseHostNativeRoomRetirementReply(Object.defineProperty({}, 'state', { value: 'left' }))).toThrow()
  expect(() => parseHostNativeRoomRetirementTarget({ ...target, get join_command() { touched++; return join } })).toThrow()
  expect(touched).toBe(0)
})

it('only independent successful retirement proofs can certify a closed original cycle', () => {
  const parsed = parseHostNativeRoomRetirementProof(rawProof())
  expect(parsed.reply).toEqual({ state: 'left', left_room_seq: 0 })
  for (const invalid of [{ ...rawProof(), schema_version: 2 }, { ...rawProof(), purpose: 'native_room_projection' },
    { ...rawProof(), reply: { state: 'unavailable' } }, { ...rawProof(), issued_at: 2001 },
    { ...rawProof(), extra: true }, { ...rawProof(), reply: { state: 'joined', joined_room_seq: 0 } }])
    expect(() => parseHostNativeRoomRetirementProof(invalid)).toThrow()
})

it('pins the independent signature domain and exact ordered original-command bytes', () => {
  const proof = parseHostNativeRoomRetirementProof(rawProof())
  const expected = Buffer.from('dsh-native-room-retirement/v1\0' + JSON.stringify([1, 'native_room_retirement',
    [target.challenge_nonce, target.expires_at, target.binding_id, target.binding_generation,
      target.join_command_request_id, ['join', join.room_id, join.group_id, join.member_id, join.cycle, join.project_id, join.agent_id, join.name],
      target.leave_command_request_id, ['leave', join.room_id, join.member_id, join.cycle]],
    ['left', 0], [authority.host_profile_id, authority.authority_environment_id, authority.account_binding_handle,
      authority.authority_binding_version, authority.account_issuer, authority.account_subject, authority.installation_id,
      authority.installation_public_key, authority.host_instance_id, authority.process_nonce, authority.issued_at]]), 'utf8')
  const bytes = encodeHostNativeRoomRetirementProofPayload(proof)
  expect(bytes).toEqual(expected)
  expect(bytes.includes(0)).toBe(true)
  expect(bytes.includes(Buffer.from('native-room-projection'))).toBe(false)
  const keys = generateKeyPairSync('ed25519'), signature = sign(null, bytes, keys.privateKey)
  expect(verify(null, bytes, keys.publicKey, signature)).toBe(true)
  for (const changed of [
    { ...proof, target: { ...proof.target, join_command_request_id: ids[0] } },
    { ...proof, target: { ...proof.target, leave_command_request_id: ids[0] } },
    { ...proof, target: { ...proof.target, binding_generation: '9007199254740994' } },
    { ...proof, target: { ...proof.target, join_command: { ...proof.target.join_command, name: 'Other name' } } },
    { ...proof, reply: { state: 'left', left_room_seq: 1 } }, { ...proof, host_profile_id: ids[0] },
  ]) {
    const altered = encodeHostNativeRoomRetirementProofPayload(parseHostNativeRoomRetirementProof(changed))
    expect(verify(null, altered, keys.publicKey, signature)).toBe(false)
  }
  expect(encodeHostNativeRoomRetirementProofPayload(parseHostNativeRoomRetirementProof({ ...proof, signature: 'C'.repeat(85) + 'A' }))).toEqual(bytes)
})

it('rejects frame extras and never smuggles retirement through ordinary projection results', () => {
  const request = { version: 1, type: 'request', request_id: ids[0], method: 'profile.native_room_retirement', params: { ...params, target } }
  expect(() => decodeHostControlFrame(JSON.stringify({ ...request, params: { ...request.params, profile_id: ids[0] } }) + '\n')).toThrow()
  const result = { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_retirement', result: { proof: rawProof() } }
  expect(() => decodeHostControlFrame(JSON.stringify({ ...result, result: { ...result.result, reply: {} } }) + '\n')).toThrow()
  expect(() => decodeHostControlFrame(JSON.stringify({ ...result, method: 'profile.native_room_projection' }) + '\n')).toThrow()
})

it('verifies the shared deterministic Host/Slark retirement signature fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-room-retirement-v1.json', import.meta.url), 'utf8')) as {
    public_key: string
    payload_base64url: string
    proof: unknown
  }
  const proof = parseHostNativeRoomRetirementProof(fixture.proof)
  const bytes = encodeHostNativeRoomRetirementProofPayload(proof)
  expect(bytes.toString('base64url')).toBe(fixture.payload_base64url)
  const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(fixture.public_key, 'base64url'),
  ]) })
  expect(verify(null, bytes, key, Buffer.from(proof.signature, 'base64url'))).toBe(true)
})
