/** Cross-runtime wire bytes are pinned independently from either encoder. */
import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseHostRootAuthorityAssertion, parseHostRootAuthorityChallenge, encodeHostRootAuthorityPayload } from '../src/root-authority.ts'
const vector = JSON.parse(readFileSync(new URL('./fixtures/root-authority-v1.json', import.meta.url), 'utf8')) as {
  assertion: { challenge: Record<string, unknown> }
  payload: string
}
it('matches the Slark root signature vector exactly and freezes detached fields', () => {
  const assertion = parseHostRootAuthorityAssertion(vector.assertion)
  expect(encodeHostRootAuthorityPayload(assertion).toString('utf8')).toBe(vector.payload)
  expect(Object.isFrozen(assertion.challenge.source_challenge)).toBe(true)
  expect(assertion).not.toBe(vector.assertion)
})
it('rejects downgraded Source proofs, root changes in syntax and accessor metadata', () => {
  const c = vector.assertion.challenge
  expect(() => parseHostRootAuthorityAssertion({ ...vector.assertion, challenge: c.source_challenge })).toThrow()
  for (const change of [{ schema_version: 2 }, { namespace_id: 'other' }, { root_task_id: 'forged' },
    { root_trace_id: '0'.repeat(32) }, { command_id: '../bad' }, { payload_digest: 'bad' }, { extra: 'field' }]) {
    expect(() => parseHostRootAuthorityChallenge({ ...c, ...change })).toThrow()
  }
  let reads = 0
  const dirty = { ...c }
  Object.defineProperty(dirty, 'root_trace_id', { enumerable: true, get() { reads++; return c.root_trace_id } })
  expect(() => parseHostRootAuthorityChallenge(dirty)).toThrow()
  expect(reads).toBe(0)
})
it('roundtrips root request/result frames with exact payloads and rejects source downgrade', async () => {
  const { decodeHostControlFrame, encodeHostControlFrame } = await import('../src/index.ts')
  const proof = parseHostRootAuthorityAssertion(vector.assertion), c = proof.challenge.source_challenge
  const request = { version: 1, type: 'request', request_id: c.request_id, method: 'profile.root_authority', params: {
    client_instance_id: c.request_id, host_instance_id: proof.host_instance_id, process_nonce: proof.process_nonce,
    jti: c.workspace_id, issued_at: 1000, expires_at: 2000, account_binding_handle: 'binding:test', authority_binding_version: 1,
    challenge: proof.challenge,
  } }
  const result = { version: 1, type: 'result', request_id: c.request_id, method: request.method, result: proof }
  for (const frame of [request, result]) expect(decodeHostControlFrame(encodeHostControlFrame(frame as never))).toEqual(frame)
  expect(() => encodeHostControlFrame({ ...request, params: { ...request.params, challenge: c } } as never)).toThrow()
})
