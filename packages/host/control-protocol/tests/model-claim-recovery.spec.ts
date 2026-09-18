import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const candidateId = 'llm-deepseek:deepseek'
const proof = () => ({
  client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
  jti: randomUUID(), issued_at: 1000, expires_at: 2000,
  account_access_token: 'header.payload.signature', account_issuer: 'https://accounts.example.test',
  account_subject: 'person', authority_environment_id: randomUUID(),
  account_binding_handle: 'binding:person', authority_binding_version: 1,
  profile_key_handle: 'keychain:person', profile_unlock_material: 'A'.repeat(43),
  candidate_id: candidateId,
})
const request = (method: 'profile.model_claim_recovery_status' | 'profile.model_claim_restore') => ({
  version: 1, type: 'request', request_id: randomUUID(), method,
  params: { ...proof(), ...(method === 'profile.model_claim_restore' ? { operation_id: randomUUID() } : {}) },
})
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('same-Account model claim recovery wire', () => {
  it('round-trips token and vault proof requests without adding a view lease', () => {
    for (const method of ['profile.model_claim_recovery_status', 'profile.model_claim_restore'] as const) {
      const value = request(method)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
      expect(value.params).not.toHaveProperty('view_lease_id')
    }
  })

  it('round-trips only redacted owned receipts and restore outcomes', () => {
    for (const value of [
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_recovery_status',
        result: { state: 'unclaimed' } },
      ...(['pending', 'committed', 'restored'] as const).map(state => ({
        version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_recovery_status',
        result: { state, candidate_id: candidateId, operation_id: randomUUID(), source_digest: 'a'.repeat(64) },
      })),
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_restore',
        result: { state: 'restored', cleanup_pending: false } },
    ]) expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  })

  it('rejects path, secret, wrong operation and malformed status fields', () => {
    const status = request('profile.model_claim_recovery_status')
    const restore = request('profile.model_claim_restore')
    expect(() => decode({ ...status, params: { ...status.params, source_path: '/home/person/.dsh' } })).toThrow()
    expect(() => decode({ ...status, params: { ...status.params, candidate_id: '../provider' } })).toThrow()
    expect(() => decode({ ...status, params: { ...status.params, account_access_token: '' } })).toThrow()
    expect(() => decode({ ...restore, params: { ...restore.params, operation_id: 'other' } })).toThrow()
    const base = { version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.model_claim_recovery_status' }
    expect(() => decode({ ...base, result: { state: 'unclaimed', operation_id: randomUUID() } })).toThrow()
    expect(() => decode({ ...base, result: { state: 'pending', candidate_id: candidateId,
      operation_id: randomUUID(), source_digest: 'bad' } })).toThrow()
    expect(() => decode({ ...base, result: { state: 'unknown', candidate_id: candidateId,
      operation_id: randomUUID(), source_digest: 'a'.repeat(64) } })).toThrow()
    expect(() => decode({ ...base, result: { state: 'pending', candidate_id: candidateId,
      operation_id: randomUUID(), source_digest: 'a'.repeat(64), credential: 'secret' } })).toThrow()
    const restored = { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_restore' }
    expect(() => decode({ ...restored, result: { state: 'restored', cleanup_pending: 'false' } })).toThrow()
    expect(() => decode({ ...restored, result: { state: 'committed', cleanup_pending: false } })).toThrow()
  })
})
