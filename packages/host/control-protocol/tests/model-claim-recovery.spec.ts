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
const request = (method: 'profile.model_claim_recovery_status' | 'profile.model_claim_restore'
  | 'profile.model_claim_retry') => ({
  version: 1, type: 'request', request_id: randomUUID(), method,
  params: { ...proof(), ...(method === 'profile.model_claim_recovery_status' ? {} : { operation_id: randomUUID() }),
    ...(method === 'profile.model_claim_retry' ? { source_digest: 'a'.repeat(64) } : {}) },
})
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('same-Account model claim recovery wire', () => {
  it('round-trips token and vault proof requests without adding a view lease', () => {
    const inventory = { version: 1, type: 'request', request_id: randomUUID(),
      method: 'profile.model_claim_recovery_inventory',
      params: (({ candidate_id: _candidate, ...rest }) => rest)(proof()) }
    expect(encodeHostControlFrame(decode(inventory))).toBe(`${JSON.stringify(inventory)}\n`)
    expect(() => decode({ ...inventory, params: { ...inventory.params, candidate_id: candidateId } })).toThrow()
    for (const method of ['profile.model_claim_recovery_status', 'profile.model_claim_restore',
      'profile.model_claim_retry'] as const) {
      const value = request(method)
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
      expect(value.params).not.toHaveProperty('view_lease_id')
    }
  })

  it('round-trips only redacted owned receipts and restore outcomes', () => {
    const inventory = { version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.model_claim_recovery_inventory',
      result: { receipts: [{ candidate_id: candidateId, operation_id: randomUUID(),
        source_digest: 'a'.repeat(64), state: 'pending' }] } }
    expect(encodeHostControlFrame(decode(inventory))).toBe(`${JSON.stringify(inventory)}\n`)
    expect(() => decode({ ...inventory, result: { receipts: [
      ...inventory.result.receipts, ...inventory.result.receipts,
    ] } })).toThrow()
    expect(() => decode({ ...inventory, result: { receipts: Array.from({ length: 129 },
      () => inventory.result.receipts[0]) } })).toThrow()
    expect(() => decode({ ...inventory, result: { receipts: [
      { ...inventory.result.receipts[0], secret: 'key' },
    ] } })).toThrow()
    for (const value of [
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_recovery_status',
        result: { state: 'unclaimed' } },
      ...(['pending', 'committed', 'restored'] as const).map(state => ({
        version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_recovery_status',
        result: { state, candidate_id: candidateId, operation_id: randomUUID(), source_digest: 'a'.repeat(64) },
      })),
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_restore',
        result: { state: 'restored', cleanup_pending: false } },
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_retry',
        result: { state: 'committed', cleanup_pending: false } },
    ]) expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  })

  it('rejects path, secret, wrong operation and malformed status fields', () => {
    const status = request('profile.model_claim_recovery_status')
    const restore = request('profile.model_claim_restore')
    const retry = request('profile.model_claim_retry')
    expect(() => decode({ ...status, params: { ...status.params, source_path: '/home/person/.dsh' } })).toThrow()
    expect(() => decode({ ...status, params: { ...status.params, candidate_id: '../provider' } })).toThrow()
    expect(() => decode({ ...status, params: { ...status.params, account_access_token: '' } })).toThrow()
    expect(() => decode({ ...restore, params: { ...restore.params, operation_id: 'other' } })).toThrow()
    expect(() => decode({ ...retry, params: { ...retry.params, source_digest: 'bad' } })).toThrow()
    expect(() => decode({ ...retry, params: { ...retry.params, source_path: '/home/person/.dsh' } })).toThrow()
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
    const committed = { ...restored, method: 'profile.model_claim_retry' }
    expect(() => decode({ ...committed, result: { state: 'restored', cleanup_pending: false } })).toThrow()
    expect(() => decode({ ...committed, result: { state: 'committed', cleanup_pending: 'false' } })).toThrow()
  })
})
