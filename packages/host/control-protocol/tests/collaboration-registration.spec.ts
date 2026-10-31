import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame, encodeHostCollaborationRegistrationSignaturePayload,
  parseHostCollaborationRegistrationAssertion, parseHostCollaborationRegistrationChallenge } from '../src/index.ts'

const challenge = () => ({ registration_request_id: '10000000-0000-4000-8000-000000000001',
  challenge_id: '20000000-0000-4000-8000-000000000002', challenge_nonce: 'A'.repeat(43), expires_at: 2000,
  audience: 'https://slark.example.test', environment_id: '30000000-0000-4000-8000-000000000003',
  account_issuer: 'https://accounts.example.test', account_subject: '40000000-0000-4000-8000-000000000004' })
const assertion = () => ({ schema_version: 2, challenge: challenge(), installation_id: '50000000-0000-4000-8000-000000000005',
  installation_public_key: 'A'.repeat(43), host_instance_id: '60000000-0000-4000-8000-000000000006', process_nonce: 'A'.repeat(43), signature: 'A'.repeat(86) })

it('uses the fixed domain and tuple shared by the Slark verifier, excluding the signature', () => {
  const result = parseHostCollaborationRegistrationAssertion(assertion())
  const expected = 'dsh-collaboration-host-registration/v2\0'+JSON.stringify([2,
    '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'A'.repeat(43), 2000,
    'https://slark.example.test', '30000000-0000-4000-8000-000000000003', 'https://accounts.example.test',
    '40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000005', 'A'.repeat(43),
    '60000000-0000-4000-8000-000000000006', 'A'.repeat(43)])
  expect(encodeHostCollaborationRegistrationSignaturePayload(result).toString('utf8')).toBe(expected)
  expect(Object.isFrozen(result.challenge)).toBe(true)
})
it('roundtrips exact Host request and signed result fields', () => {
  const request = { version: 1, type: 'request', request_id: '10000000-0000-4000-8000-000000000001',
    method: 'profile.collaboration_registration', params: {
      client_instance_id: '10000000-0000-4000-8000-000000000001', host_instance_id: assertion().host_instance_id,
      process_nonce: 'A'.repeat(43), jti: '20000000-0000-4000-8000-000000000002', issued_at: 1000, expires_at: 2000,
      account_binding_handle: 'binding:registration', authority_binding_version: 1, challenge: challenge(),
    } }
  const result = { version: 1, type: 'result', request_id: request.request_id, method: request.method, result: assertion() }
  for (const frame of [request, result]) expect(encodeHostControlFrame(decodeHostControlFrame(JSON.stringify(frame)+'\n'))).toBe(JSON.stringify(frame)+'\n')
  expect(() => decodeHostControlFrame(JSON.stringify({ ...request, params: { ...request.params, owner_user_id: 'forged' } })+'\n')).toThrow()
})
it('rejects noncanonical identity, nonce, audience, expiry, secrets and hidden data without invoking getters', () => {
  for (const change of [{ challenge_nonce: 'A'.repeat(42)+'B' }, { account_subject: 'owner' },
    { audience: 'https://slark.example.test/' }, { audience: 'http://slark.example.test' }, { expires_at: 0 },
    { expires_at: Number.MAX_SAFE_INTEGER+1 }, { owner_user_id: 'forged' }]) {
    expect(()=>parseHostCollaborationRegistrationChallenge({ ...challenge(), ...change })).toThrow()
  }
  for (const change of [{ api_key: 'secret' }, { signature: 'A'.repeat(85)+'B' }, { schema_version: 1 }]) {
    expect(()=>parseHostCollaborationRegistrationAssertion({ ...assertion(), ...change })).toThrow()
  }
  let reads = 0; const value=assertion()
  Object.defineProperty(value.challenge,'account_subject',{ enumerable:true,get(){ reads++;return challenge().account_subject } })
  expect(()=>parseHostCollaborationRegistrationAssertion(value)).toThrow(); expect(reads).toBe(0)
  const hidden=assertion();Object.defineProperty(hidden,'private',{ value:'secret' })
  expect(()=>parseHostCollaborationRegistrationAssertion(hidden)).toThrow()
})

it('refuses inherited or symbolic registration fields and a Host masquerading as its installation', () => {
  const nullPrototype = challenge()
  Object.setPrototypeOf(nullPrototype, null)
  for (const value of [nullPrototype, { ...challenge(), [Symbol('private')]: true }])
    expect(() => parseHostCollaborationRegistrationChallenge(value)).toThrow()
  expect(() => parseHostCollaborationRegistrationAssertion({ ...assertion(), host_instance_id: assertion().installation_id })).toThrow()
})
