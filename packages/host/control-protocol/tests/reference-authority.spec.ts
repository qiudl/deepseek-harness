import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame, encodeHostSourceAuthorityPayload,
  parseHostSourceAuthorityAssertion, parseHostReferenceAuthorityChallenge,
  parseHostReferenceAuthorityAssertion, parseHostCollaborationReferenceGrant,
  parseHostCollaborationReferenceTarget,
  encodeHostReferenceAuthorityPayload } from '../src/index.ts'

const challenge = () => ({ request_id: '10000000-0000-4000-8000-000000000001', challenge_nonce: 'A'.repeat(43),
  expires_at: 2000, audience: 'https://slark.example.test', environment_id: '20000000-0000-4000-8000-000000000002',
  account_issuer: 'https://accounts.example.test', account_subject: '30000000-0000-4000-8000-000000000003',
  workspace_id: '40000000-0000-4000-8000-000000000004', session_id: 'source-session', source_message_id: 'message-1',
  source_revision: '1', snapshot_digest: 'a'.repeat(64), host_epoch: '1', reference_request_digest: 'b'.repeat(64) })
const proof = () => ({ schema_version: 1, challenge: challenge(), installation_id: '50000000-0000-4000-8000-000000000005',
  installation_public_key: 'A'.repeat(43), host_instance_id: '60000000-0000-4000-8000-000000000006',
  process_nonce: 'A'.repeat(43), signature: 'A'.repeat(86) })
const grant = () => ({ workspace_id: challenge().workspace_id, session_id: challenge().session_id,
  source_message_id: 'message-1', source_revision: '1', snapshot_digest: 'a'.repeat(64), reference_request_digest: 'b'.repeat(64) })

it('parses an exact private reference grant target without accepting a caller snapshot or body', () => {
  const { snapshot_digest: _digest, ...target } = grant()
  expect(parseHostCollaborationReferenceTarget(target)).toEqual(target)
  for (const value of [grant(), { ...target, reference_request_digest: 'B'.repeat(64) }, { ...target, content: 'secret' }])
    expect(() => parseHostCollaborationReferenceTarget(value)).toThrow()
})

it('binds the complete request digest to a distinct fixed reference signature domain', () => {
  const value = parseHostReferenceAuthorityAssertion(proof())
  const { reference_request_digest, ...source } = challenge()
  const sourceBytes = encodeHostSourceAuthorityPayload(parseHostSourceAuthorityAssertion({ ...proof(), challenge: source }))
  expect(encodeHostReferenceAuthorityPayload(value).toString()).toBe('dsh-collaboration-reference-authority/v1\0'
    + JSON.stringify([1, sourceBytes.toString(), reference_request_digest]))
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.challenge)).toBe(true)
  expect(encodeHostReferenceAuthorityPayload({ ...value, signature: 'B'.repeat(85) + 'A' } as never)).toEqual(encodeHostReferenceAuthorityPayload(value))
})
it('roundtrips only the authenticated reference request and installation-signed result', () => {
  const request = { version: 1, type: 'request', request_id: challenge().request_id, method: 'profile.reference_authority',
    params: { client_instance_id: challenge().request_id, host_instance_id: proof().host_instance_id, process_nonce: 'A'.repeat(43),
      jti: challenge().workspace_id, issued_at: 1000, expires_at: 2000, account_binding_handle: 'binding:test',
      authority_binding_version: 1, challenge: challenge() } }
  const result = { version: 1, type: 'result', request_id: request.request_id, method: request.method, result: proof() }
  for (const frame of [request, result]) expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  for (const extra of ['content', 'path', 'api_key']) expect(() => decodeHostControlFrame(JSON.stringify({ ...request,
    params: { ...request.params, [extra]: 'forged' } }) + '\n')).toThrow()
})
it('returns a detached exact Profile reference grant without granting access from its fields', () => {
  const input = grant(), parsed = parseHostCollaborationReferenceGrant(input)
  expect(parsed).toEqual(input)
  input.reference_request_digest = 'c'.repeat(64)
  expect(parsed.reference_request_digest).toBe('b'.repeat(64))
  expect(Object.isFrozen(parsed)).toBe(true)
  for (const bad of [{ ...grant(), content: 'secret' }, { ...grant(), source_revision: '0' }, { ...grant(), reference_request_digest: 'B'.repeat(64) }])
    expect(() => parseHostCollaborationReferenceGrant(bad)).toThrow()
})
it('rejects absent, noncanonical and hidden request digests without reading accessors', () => {
  expect(parseHostReferenceAuthorityChallenge(challenge())).toEqual(challenge())
  for (const reference_request_digest of [undefined, '', 1, 'A'.repeat(64), 'a'.repeat(63)])
    expect(() => parseHostReferenceAuthorityChallenge({ ...challenge(), reference_request_digest })).toThrow()
  for (const source_revision of ['0', '01', '9223372036854775808'])
    expect(() => parseHostReferenceAuthorityChallenge({ ...challenge(), source_revision })).toThrow()
  for (const value of [null, [], Object.create(null), { ...challenge(), [Symbol('hidden')]: true }, { ...challenge(), unknown: true }])
    expect(() => parseHostReferenceAuthorityChallenge(value)).toThrow()
  let reads = 0
  const c = challenge()
  Object.defineProperty(c, 'reference_request_digest', { enumerable: true, get: () => { reads++; return 'b'.repeat(64) } })
  expect(() => parseHostReferenceAuthorityChallenge(c)).toThrow()
  expect(reads).toBe(0)
  const hidden = challenge()
  Object.defineProperty(hidden, 'private', { value: true })
  expect(() => parseHostReferenceAuthorityChallenge(hidden)).toThrow()
})
it('refuses Source-only proof, opaque content fields and invalid signature identities', () => {
  expect(parseHostReferenceAuthorityAssertion(proof()).challenge.reference_request_digest).toBe('b'.repeat(64))
  const { reference_request_digest: _digest, ...source } = challenge()
  for (const value of [{ ...proof(), challenge: source }, { ...proof(), content_handle: 'opaque' },
    { ...proof(), schema_version: 2 }, { ...proof(), signature: 'A'.repeat(85) + 'B' },
    { ...proof(), host_instance_id: proof().installation_id }]) expect(() => parseHostReferenceAuthorityAssertion(value)).toThrow()
  let reads = 0
  const value = proof()
  Object.defineProperty(value, 'challenge', { enumerable: true, get: () => { reads++; return challenge() } })
  expect(() => parseHostReferenceAuthorityAssertion(value)).toThrow()
  expect(reads).toBe(0)
})
