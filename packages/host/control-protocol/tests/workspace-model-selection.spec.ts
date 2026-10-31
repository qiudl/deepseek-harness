import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const target = { workspace_id: randomUUID(), session_id: 'session-1' }
const selection = { ...target, provider: 'deepseek', model: 'chat', reasoning_effort: 'high' }
const request = () => ({ version: 1, type: 'request', request_id: randomUUID(),
  method: 'profile.workspace_model_selection', params: {
    client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
    jti: randomUUID(), issued_at: 1000, expires_at: 2000,
    authority_environment_id: randomUUID(), account_binding_handle: 'binding:selection',
    authority_binding_version: 1, ...target,
  } })
const result = (value: object) => ({ version: 1, type: 'result', request_id: randomUUID(),
  method: 'profile.workspace_model_selection', result: value })
const decode = (value: object) => decodeHostControlFrame(`${JSON.stringify(value)}\n`)

describe('Host workspace model selection wire', () => {
  it('round-trips the account-bound target and minimum selection fields', () => {
    for (const frame of [request(), result(selection), result({ ...target, provider: 'p', model: 'm' })]) {
      expect(encodeHostControlFrame(decode(frame))).toBe(`${JSON.stringify(frame)}\n`)
    }
  })

  it('rejects paths, invalid identities, caller-selected models and extra authority', () => {
    const frame = request()
    for (const params of [
      { ...frame.params, workspace_id: '/private/workspace' }, { ...frame.params, session_id: '' },
      { ...frame.params, session_id: 'x'.repeat(257) }, { ...frame.params, profile_id: randomUUID() },
      { ...frame.params, provider: 'p' }, { ...frame.params, account_subject: 'other' },
    ]) expect(() => decode({ ...frame, params })).toThrow()
  })

  it('rejects secret fields and measures model identities and effort in UTF-8 bytes', () => {
    for (const value of [
      { ...selection, api_key: 'secret' }, { ...selection, cwd: '/private' },
      { ...selection, provider: ' ' }, { ...selection, model: '中'.repeat(86) },
      { ...selection, reasoning_effort: '中'.repeat(43) },
      { ...selection, reasoning_effort: '' },
    ]) expect(() => decode(result(value))).toThrow()
  })
})
