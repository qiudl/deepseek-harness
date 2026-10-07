import { expect, it } from 'vitest'
import {
  parseHostSourceAuthorityChallenge,
  parseHostSourceAuthorityAssertion,
  encodeHostSourceAuthorityPayload,
  decodeHostControlFrame,
  encodeHostControlFrame,
} from '../src/index.ts'
const challenge = () => ({
  request_id: '10000000-0000-4000-8000-000000000001',
  challenge_nonce: 'A'.repeat(43),
  expires_at: 2000,
  audience: 'https://slark.example.test',
  environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test',
  account_subject: '30000000-0000-4000-8000-000000000003',
  workspace_id: '40000000-0000-4000-8000-000000000004',
  session_id: 'source-session',
  source_message_id: 'message-1', source_revision: '1', snapshot_digest: 'a'.repeat(64), host_epoch: '1',
})
const proof = () => ({
  schema_version: 1,
  challenge: challenge(),
  installation_id: '50000000-0000-4000-8000-000000000005',
  installation_public_key: 'A'.repeat(43),
  host_instance_id: '60000000-0000-4000-8000-000000000006',
  process_nonce: 'A'.repeat(43),
  signature: 'A'.repeat(86),
})
it('uses a separate fixed signing domain and a canonical tuple shared with Slark', () => {
  const p = parseHostSourceAuthorityAssertion(proof())
  expect(encodeHostSourceAuthorityPayload(p).toString()).toBe(
    'dsh-collaboration-source-authority/v1\0' +
      JSON.stringify([
        1,
        ...Object.values(challenge()),
        p.installation_id,
        p.installation_public_key,
        p.host_instance_id,
        p.process_nonce,
      ]),
  )
  expect(Object.isFrozen(p.challenge)).toBe(true)
})
it('roundtrips the signed private request/result and rejects Source or credential fields', () => {
  const request = {
    version: 1,
    type: 'request',
    request_id: challenge().request_id,
    method: 'profile.source_authority',
    params: {
      client_instance_id: challenge().request_id,
      host_instance_id: proof().host_instance_id,
      process_nonce: 'A'.repeat(43),
      jti: challenge().workspace_id,
      issued_at: 1000,
      expires_at: 2000,
      account_binding_handle: 'binding:test',
      authority_binding_version: 1,
      challenge: challenge(),
    },
  }
  const result = { version: 1, type: 'result', request_id: request.request_id, method: request.method, result: proof() }
  for (const frame of [request, result]) expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(() => parseHostSourceAuthorityChallenge({ ...challenge(), source_digest: 'forged' })).toThrow()
  expect(() => parseHostSourceAuthorityAssertion({ ...proof(), source_snapshot: {} })).toThrow()
})
it('rejects unsafe targets and accessors without calling them', () => {
  for (const change of [
    { workspace_id: '/private' },
    { session_id: '' },
    { session_id: 'x'.repeat(257) },
    { session_id: '中'.repeat(86) },
    { session_id: '\ud800' },
    { source_message_id: '../bad' }, { source_revision: '0' }, { source_revision: '9223372036854775808' },
    { snapshot_digest: 'A'.repeat(64) }, { host_epoch: '01' },
  ])
    expect(() => parseHostSourceAuthorityChallenge({ ...challenge(), ...change })).toThrow()
  let reads = 0
  const c = { ...challenge() }
  Object.defineProperty(c, 'session_id', {
    enumerable: true,
    get: () => {
      reads++
      return 'source-session'
    },
  })
  expect(() => parseHostSourceAuthorityChallenge(c)).toThrow()
  expect(reads).toBe(0)
})
