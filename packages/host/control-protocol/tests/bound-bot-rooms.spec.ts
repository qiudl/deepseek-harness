import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'
import { parseHostBoundBotRoomsTarget, parseHostBoundBotRoomsPage, parseHostBoundBotRoomsProof, parseHostBoundBotRoomsResult,
  parseHostBoundBotRoomsQuery, parseHostBoundBotRoomsRead,
  encodeHostBoundBotRoomsProofPayload, parseHostNativeRoomProjectionTarget,
  parseHostNativeRoomProjectionProof, encodeHostNativeRoomProjectionProofPayload } from '../src/bound-bot-rooms.ts'
const ids = ['10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004']
const target = () => ({ challenge_nonce: 'A'.repeat(43), expires_at: 2000, binding_id: ids[0], binding_generation: '9007199254740993', bot_id: 'operator', limit: 20, cursor: null })
const page = () => ({ state: 'page', bot_id: 'operator', workspace_id: ids[1], state_revision: 1,
  membership_snapshot: 'a'.repeat(64), items: [{ room_id: 'room-1', member_set_digest: 'b'.repeat(64) }], next_cursor: null })
const authority = () => ({ host_profile_id: ids[2], authority_environment_id: ids[3], account_binding_handle: 'binding-1', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.test', account_subject: ids[1], installation_id: ids[2], installation_public_key: 'A'.repeat(43), host_instance_id: ids[3], process_nonce: 'A'.repeat(43), issued_at: 1000, signature: 'A'.repeat(86) })
const proof = () => ({ schema_version: 1, purpose: 'bound_bot_rooms', target: target(), page: page(), ...authority() })
const join = () => ({ operation: 'join', room_id: 'room-1', group_id: ids[0], member_id: ids[1], cycle: 1, project_id: 'project', agent_id: 'my-twin', name: 'My twin' })
const projectionTarget = () => ({ challenge_nonce: 'A'.repeat(43), expires_at: 2000, binding_id: ids[0], binding_generation: '9007199254740993', command_request_id: ids[3], command: join() })
it('private query excludes Cloud authority and captures only explicit bounded plugin outcomes', () => {
  expect(parseHostBoundBotRoomsQuery({ bot_id: 'operator', limit: 1, cursor: null })).toEqual({ bot_id: 'operator', limit: 1, cursor: null })
  expect(() => parseHostBoundBotRoomsQuery(target())).toThrow()
  for (const limit of [null, '1', 0, 21, 1.5, NaN, Infinity]) expect(() => parseHostBoundBotRoomsQuery({ bot_id: 'operator', limit, cursor: null })).toThrow()
  expect(parseHostBoundBotRoomsRead(page())).toEqual(page())
  for (const state of ['bot_unavailable', 'snapshot_changed', 'upgrade_required', 'unavailable', 'invalid']) expect(parseHostBoundBotRoomsRead({ state })).toEqual({ state })
  let read = 0
  const hidden = Object.defineProperty({}, 'state', { value: 'unavailable' })
  for (const invalid of [null, 'page', {}, hidden, { state: 'other' }, { state: 'unavailable', private: true }, { get state() { read++; return 'page' } }]) expect(() => parseHostBoundBotRoomsRead(invalid)).toThrow()
  expect(read).toBe(0)
  expect(() => parseHostBoundBotRoomsResult(hidden)).toThrow()
})
it('strictly detaches a bounded page and preserves exact BIGINT selector generations', () => {
  const input = proof(), parsed = parseHostBoundBotRoomsProof(input)
  expect(parsed.target.binding_generation).toBe('9007199254740993')
  input.page.items[0]!.room_id = 'changed'
  expect(parsed.page.items[0]?.room_id).toBe('room-1')
  expect(parseHostBoundBotRoomsPage({ ...page(), items: [] }).items).toEqual([])
  for (const changed of [{ ...target(), binding_generation: 1 }, { ...target(), binding_generation: '9223372036854775808' }, { ...target(), limit: 21 }, { ...target(), cursor: '' }, { ...target(), profile_id: 'private' }]) expect(() => parseHostBoundBotRoomsTarget(changed)).toThrow()
})
it('rejects mismatched targets, noncanonical base64, unknown fields and invalid page ordering', () => {
  for (const changed of [
    { ...proof(), page: { ...page(), bot_id: 'another' } },
    { ...proof(), issued_at: 2001 }, { ...proof(), private_chat: 'secret' },
    { ...proof(), signature: 'B'.repeat(86) }, { ...proof(), installation_public_key: 'B'.repeat(43) },
    { ...proof(), page: { ...page(), items: [...page().items, ...page().items] } },
    { ...proof(), page: { ...page(), items: [{ room_id: 'z', member_set_digest: 'b'.repeat(64) }, ...page().items] } },
    { ...proof(), page: { ...page(), items: Array.from({ length: 21 }, (_, i) => ({ room_id: String(i), member_set_digest: 'b'.repeat(64) })) } },
    { ...proof(), page: { ...page(), next_cursor: 'x'.repeat(2049) } },
  ]) expect(() => parseHostBoundBotRoomsProof(changed)).toThrow()
})
it('wire capture invokes no input accessor and refuses sparse or decorated item arrays', () => {
  let calls = 0
  const hostile = { ...target(), get bot_id() { calls++; return 'operator' } }
  expect(() => parseHostBoundBotRoomsTarget(hostile)).toThrow(); expect(calls).toBe(0)
  const items = page().items
  Object.defineProperty(items, '0', { enumerable: true, get() { calls++; return page().items[0] } })
  expect(() => parseHostBoundBotRoomsPage({ ...page(), items })).toThrow(); expect(calls).toBe(0)
  expect(() => parseHostBoundBotRoomsPage({ ...page(), items: new Array(1) })).toThrow()
})
it('canonical Ed25519 payload binds exact nonce, page, Profile, peer and original selector', () => {
  const keys = generateKeyPairSync('ed25519'), parsed = parseHostBoundBotRoomsProof(proof()), bytes = encodeHostBoundBotRoomsProofPayload(parsed)
  const signature = sign(null, bytes, keys.privateKey)
  expect(verify(null, bytes, keys.publicKey, signature)).toBe(true)
  for (const changed of [
    { ...parsed, target: { ...parsed.target, binding_generation: '9007199254740994' } },
    { ...parsed, target: { ...parsed.target, challenge_nonce: 'C'.repeat(42) + 'A' } },
    { ...parsed, host_profile_id: ids[0] }, { ...parsed, host_instance_id: ids[0] },
    { ...parsed, page: { ...parsed.page, membership_snapshot: 'c'.repeat(64) } },
  ]) expect(verify(null, encodeHostBoundBotRoomsProofPayload(parseHostBoundBotRoomsProof(changed)), keys.publicKey, signature)).toBe(false)
  expect(encodeHostBoundBotRoomsProofPayload(parseHostBoundBotRoomsProof({ ...parsed, signature: 'C'.repeat(85) + 'A' }))).toEqual(bytes)
})
it('projection proofs contain only an original join/leave and its matching durable reply', () => {
  const input = { schema_version: 1, purpose: 'native_room_projection', target: projectionTarget(), reply: { state: 'joined', joined_room_seq: 0 }, ...authority() }
  const joined = parseHostNativeRoomProjectionProof(input)
  expect(joined.reply).toEqual({ state: 'joined', joined_room_seq: 0 })
  const { room_id, member_id, cycle } = join()
  const left = parseHostNativeRoomProjectionProof({ ...input, target: { ...projectionTarget(), command: { operation: 'leave', room_id, member_id, cycle } }, reply: { state: 'left', left_room_seq: 8 } })
  expect(left.target.command).not.toHaveProperty('group_id')
  expect(encodeHostNativeRoomProjectionProofPayload(left)).not.toEqual(encodeHostNativeRoomProjectionProofPayload(joined))
  for (const changed of [
    { ...projectionTarget(), command: { ...join(), operation: 'turns', after_seq: 0, limit: 1 } },
    { ...projectionTarget(), command: { operation: 'messages', room_id, member_id, cycle, after_seq: 0, limit: 1 } },
  ]) expect(() => parseHostNativeRoomProjectionTarget(changed)).toThrow()
  expect(() => parseHostNativeRoomProjectionProof({ ...input, reply: { state: 'left', left_room_seq: 8 } })).toThrow()
  expect(() => parseHostNativeRoomProjectionProof({ ...input, reply: { state: 'unavailable' } })).toThrow()
  expect(() => parseHostNativeRoomProjectionProof({ ...input, reply: { state: 'joined', joined_room_seq: -1 } })).toThrow()
})

it('all envelope and scalar authority boundaries reject malformed wire values without coercion', () => {
  const samples: unknown[] = [
    { ...proof(), schema_version: 2 }, { ...proof(), purpose: 'native_room_projection' },
    { ...proof(), host_profile_id: '../profile' }, { ...proof(), authority_environment_id: 'staging' },
    { ...proof(), account_binding_handle: '../binding' }, { ...proof(), authority_binding_version: 0 },
    { ...proof(), authority_binding_version: Number.MAX_SAFE_INTEGER + 1 }, { ...proof(), issued_at: -1 },
    { ...proof(), installation_id: 'invalid' }, { ...proof(), host_instance_id: 'invalid' },
    { ...proof(), account_subject: 'invalid' }, { ...proof(), process_nonce: '' },
    { ...proof(), signature: 'A'.repeat(85) }, { ...proof(), signature: '!'.repeat(86) },
    { ...proof(), installation_public_key: 'A'.repeat(42) },
    { ...proof(), account_issuer: 'http://accounts.example.test' },
    { ...proof(), account_issuer: 'https://user:password@accounts.example.test' },
    { ...proof(), account_issuer: 'https://accounts.example.test/path' },
    { ...proof(), target: { ...target(), expires_at: 0 } },
    { ...proof(), target: { ...target(), challenge_nonce: 'B'.repeat(43) } },
    { ...proof(), target: { ...target(), cursor: 'same' }, page: { ...page(), next_cursor: 'same' } },
    { ...proof(), target: { ...target(), limit: 1 }, page: { ...page(), items: [...page().items, { room_id: 'room-2', member_set_digest: 'a'.repeat(64) }] } },
    { ...proof(), page: { ...page(), state: 'unavailable' } },
  ]
  for (const sample of samples) expect(() => parseHostBoundBotRoomsProof(sample)).toThrow()
  for (const sample of [null, [], Object.create({}), { ...target(), [Symbol('private')]: 1 }]) expect(() => parseHostBoundBotRoomsTarget(sample)).toThrow()
})
it('original projection fields are signed and hostile commands cannot become native operations', () => {
  const raw = { schema_version: 1, purpose: 'native_room_projection', target: projectionTarget(), reply: { state: 'joined', joined_room_seq: 0 }, ...authority() }
  const parsed = parseHostNativeRoomProjectionProof(raw), keys = generateKeyPairSync('ed25519')
  const bytes = encodeHostNativeRoomProjectionProofPayload(parsed), signature = sign(null, bytes, keys.privateKey)
  const altered = parseHostNativeRoomProjectionProof({ ...raw, target: { ...projectionTarget(), command_request_id: ids[0] } })
  expect(verify(null, encodeHostNativeRoomProjectionProofPayload(altered), keys.publicKey, signature)).toBe(false)
  expect(() => parseHostNativeRoomProjectionProof({ ...raw, schema_version: 2 })).toThrow()
  expect(() => parseHostNativeRoomProjectionProof({ ...raw, purpose: 'bound_bot_rooms' })).toThrow()
  expect(() => parseHostNativeRoomProjectionProof({ ...raw, issued_at: 2001 })).toThrow()
  for (const command of [null, { ...join(), cycle: 0 }, { ...join(), name: '\ud800' }, { ...join(), operation: {} }, { ...join(), private: true }]) expect(() => parseHostNativeRoomProjectionTarget({ ...projectionTarget(), command })).toThrow()
  let touched = 0
  expect(() => parseHostNativeRoomProjectionTarget({ ...projectionTarget(), command: { ...join(), get operation() { touched++; return 'join' } } })).toThrow()
  expect(touched).toBe(0)
})
it('maximum escaped room IDs and legal cursor remain within the private page and frame budgets', () => {
  const maxPage = { ...page(), bot_id: 'a'.repeat(200), state_revision: Number.MAX_SAFE_INTEGER, items: Array.from({ length: 20 }, (_, i) => ({ room_id: '"'.repeat(253) + String(i).padStart(3, '0'), member_set_digest: 'a'.repeat(64) })), next_cursor: 'a'.repeat(2048) }
  const maxProof = parseHostBoundBotRoomsProof({ ...proof(), target: { ...target(), bot_id: maxPage.bot_id, cursor: 'b'.repeat(2048) }, page: maxPage })
  expect(Buffer.byteLength(JSON.stringify(maxProof.page))).toBeLessThan(16 * 1024)
  expect(Buffer.byteLength(JSON.stringify(maxProof))).toBeLessThan(64 * 1024)
})

it('non-page inventory outcomes remain explicit and cannot smuggle a proof or an empty page', () => {
  for (const state of ['bot_unavailable', 'snapshot_changed']) expect(parseHostBoundBotRoomsResult({ state })).toEqual({ state })
  expect(parseHostBoundBotRoomsResult({ state: 'page', proof: proof() })).toMatchObject({ state: 'page', proof: { target: target() } })
  for (const bad of [null, { state: 'missing' }, { state: 'bot_unavailable', proof: proof() }, { state: 'page' }]) expect(() => parseHostBoundBotRoomsResult(bad)).toThrow()
  let reads = 0
  expect(() => parseHostBoundBotRoomsResult({ get state() { reads++; return 'page' } })).toThrow(); expect(reads).toBe(0)
})
it('independent negotiated methods roundtrip exact frames and leave legacy native results strict', () => {
  const params = { client_instance_id: ids[0], host_instance_id: ids[1], process_nonce: 'A'.repeat(43), jti: ids[2], issued_at: 1000, expires_at: 2000,
    authority_environment_id: ids[3], account_binding_handle: 'binding-1', authority_binding_version: 1, account_issuer: 'https://accounts.example.test', account_subject: ids[1] }
  const projectionProof = { schema_version: 1, purpose: 'native_room_projection', target: projectionTarget(), reply: { state: 'joined', joined_room_seq: 0 }, ...authority() }
  const frames = [
    { version: 1, type: 'request', request_id: ids[0], method: 'profile.bound_bot_rooms', params: { ...params, target: target() } },
    { version: 1, type: 'result', request_id: ids[0], method: 'profile.bound_bot_rooms', result: { state: 'page', proof: proof() } },
    { version: 1, type: 'request', request_id: ids[0], method: 'profile.native_room_projection', params: { ...params, target: projectionTarget() } },
    { version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_projection', result: { proof: projectionProof } },
  ]
  for (const frame of frames) {
    const decoded = decodeHostControlFrame(JSON.stringify(frame) + '\n')
    expect(JSON.parse(encodeHostControlFrame(decoded))).toEqual(frame)
    if (frame.type === 'request') expect(() => decodeHostControlFrame(JSON.stringify({ ...frame, params: { ...frame.params, profile_id: 'private' } }) + '\n')).toThrow()
  }
  expect(() => decodeHostControlFrame(JSON.stringify({ version: 1, type: 'result', request_id: ids[0], method: 'profile.native_room_operation', result: { reply: { state: 'joined', joined_room_seq: 0 }, projection_assertion: projectionProof } }) + '\n')).toThrow()
  expect(() => decodeHostControlFrame(JSON.stringify(frames[0]) + ' '.repeat(64 * 1024) + '\n')).toThrow()
})
