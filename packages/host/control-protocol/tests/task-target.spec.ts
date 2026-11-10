import { readFileSync } from 'node:fs'
import { createHash, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parseHostTaskTargetPrepareDirective, parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective,
  hostTaskTargetPrepareTuple, hostTaskTargetDescriptorTuple, hostTaskReadyAdmissionTuple,
  encodeHostTaskTargetPrepareDirective, encodeHostTaskTargetDescriptor, encodeHostTaskReadyAdmissionDirective,
  hostTaskTargetProviderDigest, hostTaskTargetDescriptorDigest, hostTaskStepPayloadDigest,
  parseHostTaskReadyAdmissionInput,
  parseHostTaskTargetConsumeChallenge, hostTaskTargetConsumeChallengeTuple, encodeHostTaskTargetConsumeChallenge,
  parseHostTaskTargetConsumeReceipt, hostTaskTargetConsumeReceiptTuple, encodeHostTaskTargetConsumeReceipt,
  parseHostTaskTargetObserveDirective, hostTaskTargetObserveTuple, encodeHostTaskTargetObserveDirective,
  parseHostTaskTargetObservation, hostTaskTargetObservationTuple, encodeHostTaskTargetObservation,
  parseHostTaskTargetStepBody, hostTaskTargetConsumeReceiptDigest,
} from '../src/task-target.ts'

function dictionary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid literal dictionary')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('invalid literal text')
  return value
}
const literal = dictionary(JSON.parse(readFileSync(new URL('./fixtures/task-target-v1.json', import.meta.url), 'utf8')))
const provider = dictionary(literal.provider), keys = dictionary(literal.publicKeys), body = dictionary(literal.canonicalStepBody)
const fixture = {
  prepare: parseHostTaskTargetPrepareDirective(literal.prepare), descriptor: parseHostTaskTargetDescriptor(literal.descriptor),
  ready: parseHostTaskReadyAdmissionDirective(literal.ready),
  consumeChallenge: parseHostTaskTargetConsumeChallenge(literal.consumeChallenge),
  consumeReceipt: parseHostTaskTargetConsumeReceipt(literal.consumeReceipt),
  observeRequest: parseHostTaskTargetObserveDirective(literal.observeRequest),
  observation: parseHostTaskTargetObservation(literal.observation),
  tuples: dictionary(literal.tuples), preimages: dictionary(literal.preimages), preimageSha256: dictionary(literal.preimageSha256),
  publicKeys: { host: text(keys.host), cloud: text(keys.cloud) },
  provider: { implementationDigest: text(provider.implementationDigest), compositionDigest: text(provider.compositionDigest),
    digest: text(provider.digest) },
  canonicalStepBody: { bytes: text(body.bytes), sha256: text(body.sha256) },
  signedConsumeReceiptDigest: text(literal.signedConsumeReceiptDigest),
}
const clone = structuredClone
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe('original Slark step paired target protocol', () => {
  const cases = [
    ['prepare', parseHostTaskTargetPrepareDirective, hostTaskTargetPrepareTuple, encodeHostTaskTargetPrepareDirective, 'cloud'],
    ['descriptor', parseHostTaskTargetDescriptor, hostTaskTargetDescriptorTuple, encodeHostTaskTargetDescriptor, 'host'],
    ['ready', parseHostTaskReadyAdmissionDirective, hostTaskReadyAdmissionTuple, encodeHostTaskReadyAdmissionDirective, 'cloud'],
    ['consumeChallenge', parseHostTaskTargetConsumeChallenge, hostTaskTargetConsumeChallengeTuple, encodeHostTaskTargetConsumeChallenge, 'host'],
    ['consumeReceipt', parseHostTaskTargetConsumeReceipt, hostTaskTargetConsumeReceiptTuple, encodeHostTaskTargetConsumeReceipt, 'cloud'],
    ['observeRequest', parseHostTaskTargetObserveDirective, hostTaskTargetObserveTuple, encodeHostTaskTargetObserveDirective, 'cloud'],
    ['observation', parseHostTaskTargetObservation, hostTaskTargetObservationTuple, encodeHostTaskTargetObservation, 'host'],
  ] as const
  for (const [kind, parse, tuple, encode, key] of cases) {
    it(`${kind} matches independent Source literal tuples, preimages and Ed25519 signature`, () => {
      expect(parse(fixture[kind])).toEqual(fixture[kind])
      expect(tuple(fixture[kind])).toEqual(fixture.tuples[kind])
      expect(encode(fixture[kind])).toBe(fixture.preimages[kind])
      expect(digest(encode(fixture[kind]))).toBe(fixture.preimageSha256[kind])
      expect(verify(null, Buffer.from(encode(fixture[kind])), fixture.publicKeys[key], Buffer.from(fixture[kind].signature, 'base64url'))).toBe(true)
    })
    it(`${kind} rejects unknown fields, inherited objects and accessors without evaluating them`, () => {
      const extra = { ...fixture[kind], verified: true }
      expect(() => parse(extra)).toThrow()
      expect(() => parse(Object.create(fixture[kind]))).toThrow()
      const accessor = clone(fixture[kind])
      let reads = 0
      Object.defineProperty(accessor, 'signature', { get: () => { reads++; return 'A'.repeat(86) }, enumerable: true })
      expect(() => parse(accessor)).toThrow()
      expect(reads).toBe(0)
      const symbol = clone(fixture[kind])
      Object.defineProperty(symbol, Symbol('permission'), { value: true })
      expect(() => parse(symbol)).toThrow()
    })
  }
  it('binds the actual provider digest and original descriptor independently', () => {
    expect(hostTaskTargetProviderDigest(fixture.provider.implementationDigest,
      fixture.provider.compositionDigest)).toBe(fixture.provider.digest)
    expect(hostTaskTargetDescriptorDigest(fixture.descriptor)).toBe(fixture.descriptor.descriptorDigest)
    const changed = { ...fixture.descriptor, target: { ...fixture.descriptor.target, sessionId: 'another-session' } }
    expect(() => parseHostTaskTargetDescriptor(changed)).toThrow()
  })
  it('keeps old logical step identity, actual new grant, body and target scope linked', () => {
    const row = fixture.ready
    const mutations = [
      { ...row, newSourceGrant: { ...row.newSourceGrant, invocationId: 'another-invocation' } },
      { ...row, newSourceGrant: { ...row.newSourceGrant, executionKey: 'another-execution' } },
      { ...row, newCoordinationEpoch: row.scope.expectedCoordinationEpoch },
      { ...row, newSourceGrant: { ...row.newSourceGrant, epoch: '99' } },
      { ...row, target: { ...row.target, botId: 'another-bot' } },
      { ...row, expiresAt: row.issuedAt + 15001 },
    ]
    for (const changed of mutations) expect(() => parseHostTaskReadyAdmissionDirective(changed)).toThrow()
  })
  it('hashes exact bounded UTF8 body bytes and refuses omission or replacement', () => {
    expect(hostTaskStepPayloadDigest('a'.repeat(16384))).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => hostTaskStepPayloadDigest('a'.repeat(16385))).toThrow()
    expect(() => hostTaskStepPayloadDigest('中'.repeat(5462))).toThrow()
    expect(() => hostTaskStepPayloadDigest('\ud800')).toThrow()
    expect(() => hostTaskStepPayloadDigest('')).toThrow()
    expect(() => parseHostTaskReadyAdmissionInput({ directive: fixture.ready, stepBody: 'substituted' })).toThrow()
  })
  it('preserves original permission ceilings and rejects noncanonical or widened body encodings', () => {
    const body = parseHostTaskTargetStepBody(fixture.canonicalStepBody.bytes)
    expect(JSON.stringify(body)).toBe(fixture.canonicalStepBody.bytes)
    expect(hostTaskStepPayloadDigest(fixture.canonicalStepBody.bytes)).toBe(fixture.canonicalStepBody.sha256)
    expect(() => parseHostTaskTargetStepBody(fixture.canonicalStepBody.bytes + '\n')).toThrow()
    const changed = clone(body)
    const value = { ...changed, permissions: { ...changed.permissions, filesystem: 'read-only', networkAccess: true } }
    expect(() => parseHostTaskTargetStepBody(JSON.stringify(value))).toThrow()
    expect(() => parseHostTaskTargetStepBody(JSON.stringify({ ...body, permissions: { ...body.permissions, verified: true } }))).toThrow()
  })
  it('matches the independent signed consume receipt digest without renewing its receipt', () => {
    expect(hostTaskTargetConsumeReceiptDigest(fixture.consumeReceipt)).toBe(fixture.signedConsumeReceiptDigest)
  })
})
