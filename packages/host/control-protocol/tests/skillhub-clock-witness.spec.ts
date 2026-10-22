import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'

const request = { version: 1, type: 'request', request_id: randomUUID(),
  method: 'profile.skillhub_clock_witness', params: {
    client_instance_id: randomUUID(), host_instance_id: randomUUID(), process_nonce: 'A'.repeat(43),
    jti: randomUUID(), issued_at: 1000, expires_at: 2000,
    profile_selector: `${'A'.repeat(43)}.${'A'.repeat(86)}`,
    profile_id: randomUUID(), binding_generation: '1', host_key_id: 'a'.repeat(64),
    anchor_id: randomUUID(), command: { kind: 'read' },
  } }
const value = { revision: '0', digest: 'a'.repeat(64) }
const decode = (frame: object) => decodeHostControlFrame(JSON.stringify(frame) + '\n')

it('round-trips exact read and CAS frames with bounded revisions and hashes', () => {
  const cas = { ...request, params: { ...request.params,
    command: { kind: 'compare_and_set', previous: null, next: value } } }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: request.method, result: { anchor_id: request.params.anchor_id, value: null, applied: null } }
  for (const frame of [request, cas, { ...cas, params: { ...cas.params,
    command: { ...cas.params.command, previous: value } } }, result,
  { ...result, result: { ...result.result, value, applied: true } },
  { ...result, result: { ...result.result, value, applied: false } }])
    expect(decodeHostControlFrame(encodeHostControlFrame(decode(frame)))).toEqual(decode(frame))
  for (const change of [{ extra: true }, { binding_generation: '0' }, { binding_generation: 1 }, { anchor_id: 'bad' },
    { host_key_id: 'bad' }, { command: { kind: 'other' } },
    { command: { kind: 'read', extra: true } },
    { command: { kind: 'compare_and_set', previous: null, next: { ...value, revision: '-1' } } },
    { command: { kind: 'compare_and_set', previous: null, next: { ...value, revision: 1 } } },
    { command: { kind: 'compare_and_set', previous: null, next: { ...value, digest: 'bad' } } },
    { command: { kind: 'compare_and_set', previous: null, next: { ...value, extra: true } } }])
    expect(() => decode({ ...request, params: { ...request.params, ...change } })).toThrow()
  expect(() => decode({ ...result, result: { ...result.result, applied: 'true' } })).toThrow()
})
