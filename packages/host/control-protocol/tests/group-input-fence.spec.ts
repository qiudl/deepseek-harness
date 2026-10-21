import { expect, it } from 'vitest'
import {
  decodeHostControlFrame, encodeHostControlFrame,
  encodeHostGroupInputFencePayload, parseHostGroupInputFenceAssertion,
  parseHostGroupInputFenceChallenge,
  parseHostGroupInputFenceValue,
} from '../src/index.ts'

const challenge = () => ({
  request_id: '10000000-0000-4000-8000-000000000001',
  challenge_nonce: 'A'.repeat(43), expires_at: 2000,
  audience: 'https://slark.example.test',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test',
  account_subject: '30000000-0000-4000-8000-000000000003',
  workspace_id: '40000000-0000-4000-8000-000000000004',
  session_id: 'source-session',
  group_id: '70000000-0000-4000-8000-000000000007', group_version: 1,
})
const assertion = () => ({
  schema_version: 1, challenge: challenge(),
  installation_id: '50000000-0000-4000-8000-000000000005',
  installation_public_key: 'A'.repeat(43),
  host_instance_id: '60000000-0000-4000-8000-000000000006',
  process_nonce: 'A'.repeat(43), signature: 'A'.repeat(86),
})

it('signs the exact original Session, prepared group and version in a separate domain', () => {
  const value = parseHostGroupInputFenceAssertion(assertion())
  expect(encodeHostGroupInputFencePayload(value).toString()).toBe(
    'dsh-group-input-fence/v1\0' + JSON.stringify([
      1, ...Object.values(challenge()), value.installation_id,
      value.installation_public_key, value.host_instance_id, value.process_nonce,
    ]),
  )
  for (const change of [{ group_id: '80000000-0000-4000-8000-000000000008' }, { group_version: 2 }]) {
    const altered = parseHostGroupInputFenceAssertion({ ...assertion(), challenge: { ...challenge(), ...change } })
    expect(encodeHostGroupInputFencePayload(altered).equals(encodeHostGroupInputFencePayload(value))).toBe(false)
  }
})

it('rejects malformed or additional group authority fields', () => {
  for (const change of [{ group_id: 'invalid' }, { group_version: 0 },
    { group_version: 1.5 }, { group_version: Number.MAX_SAFE_INTEGER + 1 }, { extra: 'browser' }]) {
    expect(() => parseHostGroupInputFenceChallenge({ ...challenge(), ...change })).toThrow()
  }
  expect(() => parseHostGroupInputFenceAssertion({ ...assertion(), schema_version: 2 })).toThrow()
  expect(() => parseHostGroupInputFenceAssertion({ ...assertion(), group_version: 2 })).toThrow()
  const value = { workspace_id: challenge().workspace_id, session_id: challenge().session_id,
    group_id: challenge().group_id, group_version: 1 }
  expect(parseHostGroupInputFenceValue(value)).toEqual(value)
  expect(() => parseHostGroupInputFenceValue({ ...value, group_version: 0 })).toThrow()
  expect(() => parseHostGroupInputFenceValue({ ...value, extra: true })).toThrow()
})

it('roundtrips only an Account-bound private request and signed acknowledgement', () => {
  const request = { version: 1, type: 'request', request_id: challenge().request_id,
    method: 'profile.group_input_fence', params: {
      client_instance_id: challenge().request_id, host_instance_id: assertion().host_instance_id,
      process_nonce: 'A'.repeat(43), jti: challenge().workspace_id,
      issued_at: 1000, expires_at: 2000,
      account_binding_handle: 'binding:test', authority_binding_version: 1,
      challenge: challenge(),
    } }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: assertion() }
  for (const frame of [request, result]) {
    expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  }
  expect(() => encodeHostControlFrame({ ...request,
    params: { ...request.params, group_id: challenge().group_id } } as never)).toThrow()
})
