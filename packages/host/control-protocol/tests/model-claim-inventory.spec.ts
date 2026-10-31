import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const auth = () => ({
  client_instance_id: randomUUID(), host_instance_id: randomUUID(),
  process_nonce: 'A'.repeat(43), jti: randomUUID(), issued_at: 1000, expires_at: 2000,
})
const request = () => ({
  version: 1, type: 'request', request_id: randomUUID(), method: 'profile.model_claim_inventory',
  params: { ...auth(), view_lease_id: randomUUID(), lease_generation: 1, runtime_generation: 5 },
})
const candidate = { id: 'llm-deepseek:deepseek', provider: 'deepseek', kind: 'llm',
  credential: 'present', shared_credential: true }
const result = () => ({
  version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_inventory',
  result: {
    source_digest: 'a'.repeat(64), candidates: [candidate], unsupported_settings: 1,
    unassigned_credential_references: 2, unassigned_credential_records: 3,
  },
})
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('redacted model claim inventory wire', () => {
  it('round-trips Main lease requests and bounded candidate metadata', () => {
    for (const value of [request(), result(), { ...result(), result: {
      ...result().result, candidates: [{ id: 'llm-pi-ai:openai', provider: 'openai', kind: 'llm',
        credential: 'missing', shared_credential: false },
      { id: 'web-search-deepseek:deepseek', provider: 'deepseek', kind: 'web-search',
        credential: 'none', shared_credential: false }],
    } }]) expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  })

  it('rejects paths and credentials in requests or responses', () => {
    const validRequest = request()
    expect(() => decode({ ...validRequest, params: { ...validRequest.params, source_path: '/home/user/.dsh' } })).toThrow()
    expect(() => decode({ ...validRequest, params: { ...validRequest.params, lease_generation: 0 } })).toThrow()
    const validResult = result()
    expect(() => decode({ ...validResult, result: { ...validResult.result, api_key: 'secret' } })).toThrow()
    expect(() => decode({ ...validResult, result: { ...validResult.result,
      candidates: [{ ...candidate, credential_value: 'secret' }] } })).toThrow()
  })

  it('rejects ambiguous, oversized and malformed candidate inventories', () => {
    const valid = result()
    for (const candidates of [
      [candidate, candidate],
      Array.from({ length: 129 }, () => candidate),
      [{ ...candidate, id: '../path' }],
      [{ ...candidate, kind: 'web-search', provider: 'other', id: 'web-search-deepseek:deepseek' }],
      [{ ...candidate, provider: 'other' }],
      [{ ...candidate, credential: 'secret' }],
      [{ ...candidate, shared_credential: 'true' }],
      [null],
    ]) expect(() => decode({ ...valid, result: { ...valid.result, candidates } })).toThrow()
    expect(() => decode({ ...valid, result: { ...valid.result, source_digest: 'bad' } })).toThrow()
    expect(() => decode({ ...valid, result: { ...valid.result, unsupported_settings: -1 } })).toThrow()
  })
})
