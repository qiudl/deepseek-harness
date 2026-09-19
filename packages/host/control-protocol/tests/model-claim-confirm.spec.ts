import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const auth = () => ({
  client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
  jti: randomUUID(), issued_at: 1000, expires_at: 2000,
})
const confirm = () => ({ version: 1, type: 'request', request_id: randomUUID(),
  method: 'profile.model_claim_confirm', params: { ...auth(), view_lease_id: randomUUID(),
    lease_generation: 1, runtime_generation: 5, candidate_id: 'llm-deepseek:deepseek',
    source_digest: 'a'.repeat(64) } })
const apply = () => ({ version: 1, type: 'request', request_id: randomUUID(),
  method: 'profile.model_claim_apply', params: { ...auth(), confirmation: 'A'.repeat(43) } })
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('legacy model claim confirmation wire', () => {
  it('round-trips one-use confirmation and redacted committed result', () => {
    for (const value of [confirm(), apply(),
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_confirm',
        result: { confirmation: 'A'.repeat(43), operation_id: randomUUID(), expires_at: 61_000 } },
      { version: 1, type: 'result', request_id: randomUUID(), method: 'profile.model_claim_apply',
        result: { state: 'committed', cleanup_pending: false } },
    ]) expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
  })

  it('rejects paths, secrets, invalid selectors and malformed confirmation results', () => {
    const first = confirm()
    const second = apply()
    for (const params of [
      { ...first.params, source_path: '/Users/person/.dsh' },
      { ...first.params, candidate_id: '../provider' },
      { ...first.params, source_digest: 'changed' },
      { ...first.params, view_lease_id: 'invalid' },
    ]) expect(() => decode({ ...first, params })).toThrow()
    expect(() => decode({ ...second, params: { ...second.params, credential: 'secret' } })).toThrow()
    expect(() => decode({ ...second, params: { ...second.params, confirmation: 'short' } })).toThrow()
    const result = { version: 1, type: 'result', request_id: randomUUID(),
      method: 'profile.model_claim_confirm' }
    expect(() => decode({ ...result, result: { confirmation: 'A'.repeat(43),
      operation_id: randomUUID(), expires_at: -1 } })).toThrow()
    expect(() => decode({ ...result, result: { confirmation: 'A'.repeat(43),
      operation_id: 'bad', expires_at: 61_000 } })).toThrow()
    const outcome = { ...result, method: 'profile.model_claim_apply' }
    expect(() => decode({ ...outcome, result: { state: 'restored', cleanup_pending: false } })).toThrow()
    expect(() => decode({ ...outcome, result: { state: 'committed', cleanup_pending: 'false' } })).toThrow()
  })
})
