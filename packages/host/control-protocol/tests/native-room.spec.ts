import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostNativeRoomSource, parseHostNativeRoomTarget } from '../src/index.ts'

const binding = { room_id: 'room_1', source: {
  workspace_id: '10000000-0000-4000-8000-000000000001',
  session_id: 'bridge_1', source_message_id: 'source_1', source_revision: '1',
} } as const

it('accepts only one existing room and a separate bounded Source', () => {
  expect(parseHostNativeRoomTarget({ room_id: binding.room_id })).toEqual({ room_id: binding.room_id })
  expect(parseHostNativeRoomSource(binding)).toEqual(binding)
  for (const target of [null, { room_id: '../room' }, { room_id: 'room 1' },
    { room_id: 'room_1', profile_id: 'private' }]) {
    expect(() => parseHostNativeRoomTarget(target)).toThrow()
  }
  for (const source of [{ ...binding, source: { ...binding.source, session_id: binding.room_id } },
    { ...binding, source: { ...binding.source, workspace_id: 'private' } },
    { ...binding, source: { ...binding.source, source_revision: '2' } },
    { ...binding, source: { ...binding.source, private_chat: 'secret' } },
    { ...binding, private_chat: 'secret' }]) {
    expect(() => parseHostNativeRoomSource(source)).toThrow()
  }
})

it('roundtrips Account-bound native room frames without private fields', () => {
  const request = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
    method: 'profile.native_room', params: {
      client_instance_id: '10000000-0000-4000-8000-000000000001',
      host_instance_id: '20000000-0000-4000-8000-000000000002', process_nonce: 'A'.repeat(43),
      jti: '30000000-0000-4000-8000-000000000003', issued_at: 1000, expires_at: 2000,
      authority_environment_id: '40000000-0000-4000-8000-000000000004',
      account_binding_handle: 'binding:bot', authority_binding_version: 1,
      account_issuer: 'https://accounts.example.test', account_subject: '50000000-0000-4000-8000-000000000005',
      room_id: binding.room_id,
    } }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: { binding } }
  for (const frame of [request, result]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(frame)}\n`)))
      .toBe(`${JSON.stringify(frame)}\n`)
  }
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...request,
    params: { ...request.params, profile_id: 'private' } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...result,
    result: { binding: { ...binding, source: { ...binding.source, private_chat: 'secret' } } } })}\n`)).toThrow()
})
