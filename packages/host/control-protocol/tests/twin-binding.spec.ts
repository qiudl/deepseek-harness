import { twinBindingFixture } from './twin-binding-fixture.ts'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'
import { parseHostTwinBindingInput, parseHostTwinBindingDirective, parseHostTwinBindingAck,
  encodeHostTwinBindingDirective, encodeHostTwinBindingAck, hostTwinBindingAckDigest,
  parseHostTwinBindingResult } from '../src/twin-binding.ts'

const v = twinBindingFixture()
const input = () => ({ directive: structuredClone(v.directive),
  command: { operation: 'confirm', requestId: v.requestId, offer: structuredClone(v.offer) } })

it('matches independent Python directive, Ack and signed-Ack digest vectors', () => {
  expect(parseHostTwinBindingInput(input())).toEqual(input())
  expect(encodeHostTwinBindingDirective(v.directive)).toBe(v.expected.directivePayload)
  expect(encodeHostTwinBindingAck(v.ack)).toBe(v.expected.ackPayload)
  expect(hostTwinBindingAckDigest(v.ack)).toBe(v.expected.ackDigest)
  expect(parseHostTwinBindingAck(v.ack)).toEqual(v.ack)
  expect(hostTwinBindingAckDigest({ ...v.ack, signature: Buffer.alloc(64, 1).toString('base64url') }))
    .not.toBe(v.expected.ackDigest)
})

it('permits read-only recovery without accepting a new offer or another payload', () => {
  const directive = { ...v.directive, purpose: 'twin_binding_receipt' }
  const command = { operation: 'receipt', requestId: v.requestId, bindingId: directive.bindingId,
    bindingGeneration: directive.bindingGeneration, scopeDigest: directive.scopeDigest, payloadDigest: directive.payloadDigest }
  expect(parseHostTwinBindingInput({ directive, command })).toEqual({ directive, command })
  for (const bad of [{ ...command, payloadDigest: 'a'.repeat(64) }, { ...command, offer: v.offer },
    { ...command, operation: 'confirm' }, { ...command, bindingId: v.ack.hostProfileId },
    { ...command, bindingGeneration: '2' }, { ...command, scopeDigest: 'b'.repeat(64) }])
    expect(() => parseHostTwinBindingInput({ directive, command: bad })).toThrow('invalid_twin_binding_request')
})

it('rejects wrong purposes, ambiguous keys, oversized versions and invalid signing metadata', () => {
  for (const patch of [
    { purpose: 'memory_read' }, { schemaVersion: 2 }, { private_key: 'secret' },
    { issuer: 'https://colorbuyai.com/' }, { issuer: 'https://user:pass@colorbuyai.com' },
    { keyId: 'other-key' }, { accountIssuer: 'https://attacker.example' },
    { accountBindingVersion: 0 }, { issuedAt: -1 }, { expiresAt: 1000 }, { expiresAt: 31001 },
    { bindingGeneration: '9223372036854775808' }, { scopeVersion: '01' },
    { signature: 'A' }, { signature: 'B'.repeat(86) },
    { peer: { ...v.directive.peer, publicKey: 'B'.repeat(43) } },
    { peer: { ...v.directive.peer, installationId: '../path' } },
  ]) expect(() => parseHostTwinBindingDirective({ ...v.directive, ...patch })).toThrow('invalid_twin_binding_request')
  for (const patch of [{ purpose: 'active' }, { durableAt: -1 }, { private_chat: 'secret' }])
    expect(() => parseHostTwinBindingAck({ ...v.ack, ...patch })).toThrow()
  for (const patch of [
    { requestId: v.ack.hostProfileId }, { bindingId: v.ack.hostProfileId }, { bindingGeneration: '2' },
    { scopeVersion: '2' }, { scopeDigest: 'a'.repeat(64) }, { payloadDigest: 'b'.repeat(64) },
  ]) expect(() => parseHostTwinBindingInput({ ...input(), directive: { ...v.directive, ...patch } })).toThrow()
  const command = input().command
  expect(() => parseHostTwinBindingInput({ directive: v.directive, command: { ...command, operation: 'receipt' } })).toThrow()
})

it('returns acknowledged or explicit missing and never accepts an active state', () => {
  expect(parseHostTwinBindingResult({ state: 'acknowledged', ack: v.ack }))
    .toEqual({ state: 'acknowledged', ack: v.ack })
  expect(parseHostTwinBindingResult({ state: 'missing' })).toEqual({ state: 'missing' })
  for (const bad of [null, { state: 'active', ack: v.ack }, { state: 'missing', ack: v.ack },
    { state: 'acknowledged', ack: { ...v.ack, secret: true } }])
    expect(() => parseHostTwinBindingResult(bad)).toThrow('invalid_twin_binding_request')
})

it('roundtrips the strict Account-bound frames and rejects extra inputs or active responses', () => {
  const d = v.directive
  const request = { version: 1, type: 'request', request_id: v.requestId, method: 'profile.twin_binding',
    params: { client_instance_id: v.requestId, host_instance_id: d.peer.hostInstanceId,
      process_nonce: d.peer.processNonce, jti: d.peer.installationId, issued_at: 1000, expires_at: 2000,
      authority_environment_id: d.authorityEnvironmentId, account_binding_handle: d.accountBindingId,
      authority_binding_version: d.accountBindingVersion, account_issuer: d.accountIssuer,
      account_subject: d.accountSubject, input: input() } }
  const result = { version: 1, type: 'result', request_id: v.requestId, method: request.method,
    result: { state: 'acknowledged', ack: v.ack } }
  for (const frame of [request, result]) {
    expect(encodeHostControlFrame(decodeHostControlFrame(JSON.stringify(frame) + '\n'))).toBe(JSON.stringify(frame) + '\n')
  }
  expect(() => decodeHostControlFrame(JSON.stringify({ ...request, params: { ...request.params, profile_id: v.ack.hostProfileId } }) + '\n')).toThrow()
  expect(() => decodeHostControlFrame(JSON.stringify({ ...result, result: { state: 'active', ack: v.ack } }) + '\n')).toThrow()
})
