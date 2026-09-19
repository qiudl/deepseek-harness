import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const auth = () => ({ client_instance_id: randomUUID(), host_instance_id: randomUUID(),
  process_nonce: 'A'.repeat(43), jti: randomUUID(), issued_at: 1000, expires_at: 2000 })
const request = () => ({ version: 1, type: 'request', request_id: randomUUID(),
  method: 'profile.model_text', params: { ...auth(), authority_environment_id: randomUUID(),
    account_binding_handle: 'binding:model-text', authority_binding_version: 1, text: 'hello' } })
const result = (value: object) => ({ version: 1, type: 'result', request_id: randomUUID(),
  method: 'profile.model_text', result: value })
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('personal text model control wire', () => {
  it('round-trips bounded text and classified outcomes without credentials', () => {
    for (const value of [request(), result({ state: 'complete', provider: 'deepseek', model: 'chat', text: 'answer' }),
      result({ state: 'rejected', code: 'missing_credential' }),
      result({ state: 'rejected', code: 'timeout' })]) {
      expect(encodeHostControlFrame(decode(value))).toBe(`${JSON.stringify(value)}\n`)
    }
  })

  it('rejects oversized, empty or extra request fields', () => {
    const base = request()
    for (const params of [{ ...base.params, text: '' }, { ...base.params, text: 'x'.repeat(8193) },
      { ...base.params, api_key: 'secret' },
      { ...base.params, view_lease_id: randomUUID() }]) expect(() => decode({ ...base, params })).toThrow()
  })

  it('rejects secret-bearing or oversized results and unknown failures', () => {
    for (const value of [result({ state: 'complete', provider: 'p', model: 'm', text: 'a', key: 'secret' }),
      result({ state: 'complete', provider: 'p', model: 'm', text: 'x'.repeat(16385) }),
      result({ state: 'rejected', code: 'raw_provider_error' })]) expect(() => decode(value)).toThrow()
  })
})
