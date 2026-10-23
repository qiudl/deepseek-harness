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

it('round-trips V2 epoch, issue, and ticketed witness frames while rejecting malformed tickets', () => {
  const { anchor_id: _anchor, ...common } = request.params
  const ticket = Buffer.alloc(32, 1).toString('base64url')
  const epoch = Buffer.alloc(32, 2).toString('base64url'), anchor_id = randomUUID()
  const base = { ...request, method: 'profile.skillhub_clock_v2',
    params: { ...common, command: { kind: 'issue', purpose: 'asset', active_asset_anchor_id: null } } }
  const witness = { ...base, params: { ...base.params,
    command: { kind: 'witness', anchor_id, epoch, ticket,
      command: { kind: 'compare_and_set', previous: null, next: value } } } }
  const result = { version: 1, type: 'result', request_id: request.request_id,
    method: base.method }
  for (const frame of [base, { ...base, params: { ...base.params,
    command: { kind: 'issue', purpose: 'work', active_asset_anchor_id: anchor_id } } },
  { ...base, params: { ...base.params, command: { kind: 'epoch' } } },
  witness, { ...witness, params: { ...witness.params,
    command: { ...witness.params.command, ticket: null, command: { kind: 'read' } } } },
  { ...result, result: { kind: 'epoch', epoch } },
  { ...result, result: { kind: 'issued', anchor_id, epoch, ticket } },
  { ...result, result: { kind: 'witness', anchor_id, epoch, value, applied: true } },
  { ...result, result: { kind: 'witness', anchor_id, epoch, value: null, applied: null } }])
    expect(decodeHostControlFrame(encodeHostControlFrame(decode(frame)))).toEqual(decode(frame))
  for (const command of [{ kind: 'issue', extra: true }, { kind: 'issue' },
    { kind: 'issue', purpose: 'other', active_asset_anchor_id: null },
    { kind: 'issue', purpose: 'asset', active_asset_anchor_id: anchor_id },
    { kind: 'issue', purpose: 'work', active_asset_anchor_id: null },
    { kind: 'issue', purpose: 'work', active_asset_anchor_id: 'bad' },
    { ...witness.params.command, ticket: 'bad' },
    { ...witness.params.command, epoch: 'bad' },
    { ...witness.params.command, anchor_id: 'bad' },
    { ...witness.params.command, command: { kind: 'read', extra: true } }])
    expect(() => decode({ ...base, params: { ...base.params, command } })).toThrow()
  expect(() => decode({ ...result, result: { kind: 'issued', anchor_id, epoch, ticket: 'bad' } })).toThrow()
  for (const binding_generation of [1, '0'])
    expect(() => decode({ ...base, params: { ...base.params, binding_generation } })).toThrow()
  expect(() => decode({ ...base, params: { ...base.params, command: { kind: 'other' } } })).toThrow()
  expect(() => decode({ ...result, result: { kind: 'witness', anchor_id, epoch,
    value, applied: 'yes' } })).toThrow()
  expect(() => decode({ ...result, result: { kind: 'other' } })).toThrow()
})
