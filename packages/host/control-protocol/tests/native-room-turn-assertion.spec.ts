import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostNativeRoomTurnAssertionPayload,
  parseHostNativeRoomTurnAssertion } from '../src/native-room-turn-assertion.ts'

const assertion = { schema_version: 1, after_seq: 0,
  selection: { state: 'turns', room_id: 'room_1',
    group_id: '11111111-1111-4111-8111-111111111111',
    member_id: '22222222-2222-4222-8222-222222222222', cycle: 1,
    next_seq: 6, turns: [{ turn_id: '33333333-3333-5333-8333-333333333333',
      trigger_room_seq: 6, turn_order: 2 }] },
  authority_environment_id: '44444444-4444-4444-8444-444444444444',
  account_binding_handle: 'binding:bot', authority_binding_version: 1,
  account_issuer: 'https://accounts.example.test',
  account_subject: '55555555-5555-4555-8555-555555555555',
  installation_id: '66666666-6666-4666-8666-666666666666',
  installation_public_key: 'A'.repeat(43),
  host_instance_id: '77777777-7777-4777-8777-777777777777',
  process_nonce: 'B'.repeat(43), issued_at: 1000, signature: 'A'.repeat(86),
} as const

it('signs the exact native turn page and rejects changed coordinates', () => {
  const parsed = parseHostNativeRoomTurnAssertion(assertion)
  const bytes = encodeHostNativeRoomTurnAssertionPayload(parsed)
  expect(bytes.toString('utf8')).toContain('dsh-native-room-turns/v1\0')
  expect(encodeHostNativeRoomTurnAssertionPayload({ ...parsed,
    signature: 'B'.repeat(86) })).toEqual(bytes)
  const keys = generateKeyPairSync('ed25519')
  const signature = sign(null, bytes, keys.privateKey)
  expect(verify(null, bytes, keys.publicKey, signature)).toBe(true)
  const changed = parseHostNativeRoomTurnAssertion({ ...assertion,
    selection: { ...assertion.selection,
      turns: [{ ...assertion.selection.turns[0], turn_order: 3 }] } })
  expect(verify(null, encodeHostNativeRoomTurnAssertionPayload(changed),
    keys.publicKey, signature)).toBe(false)
  const wrongMember = parseHostNativeRoomTurnAssertion({ ...assertion,
    selection: { ...assertion.selection, member_id: assertion.selection.group_id } })
  expect(verify(null, encodeHostNativeRoomTurnAssertionPayload(wrongMember),
    keys.publicKey, signature)).toBe(false)
  expect(() => parseHostNativeRoomTurnAssertion({ ...assertion,
    selection: { ...assertion.selection, next_seq: 5 } }))
    .toThrow('native_room_turn_assertion_invalid')
  expect(() => parseHostNativeRoomTurnAssertion({ ...assertion, after_seq: 6 }))
    .toThrow('native_room_turn_assertion_invalid')
  expect(() => parseHostNativeRoomTurnAssertion({ ...assertion, private_context: 'secret' }))
    .toThrow('native_room_turn_assertion_invalid')
})
