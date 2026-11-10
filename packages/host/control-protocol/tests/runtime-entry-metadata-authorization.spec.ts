/** Grammar/signature vectors only; these controlled keys never grant a real dispatch. */
import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { parseRuntimeEntryConsumerGrantMetadata, parseRuntimeEntryMetadataAuthorization,
  encodeRuntimeEntryMetadataAuthorization, type RuntimeEntryMetadataAuthorization } from '../src/runtime-entry-metadata-authorization.ts'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/runtime-entry-metadata-authorization-v1.json', import.meta.url), 'utf8')) as {
  value: RuntimeEntryMetadataAuthorization
  expected: string
}
const copy = () => structuredClone(fixture.value)
it('matches the independently constructed literal tuple and real Ed25519 signature while excluding only its own signature', () => {
  expect(encodeRuntimeEntryMetadataAuthorization(fixture.value)).toBe(fixture.expected)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(fixture.expected), privateKey).toString('base64url')
  const signed = parseRuntimeEntryMetadataAuthorization({ ...fixture.value, signature })
  expect(verify(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization(signed)), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
  expect(verify(null, Buffer.from(encodeRuntimeEntryMetadataAuthorization({ ...signed, accountBindingVersion: 2 })),
    publicKey, Buffer.from(signature, 'base64url'))).toBe(false)
  expect(Object.isFrozen(signed.metadata.consumerGrantMetadata)).toBe(true)
  expect(encodeRuntimeEntryMetadataAuthorization(Object.fromEntries(Object.entries(signed).reverse()))).toBe(fixture.expected)
})
it('allows metadata-only retained inspection after the original grant deadline without recreating dispatch', () => {
  const a = fixture.value
  const historical = parseRuntimeEntryMetadataAuthorization({ ...a, issuedAt: a.metadata.binding.grantExpiresAt + 1,
    expiresAt: a.metadata.binding.grantExpiresAt + 15001, metadata: { ...a.metadata, dispatchGranted: false, taskRef: null } })
  expect(historical.metadata.dispatchGranted).toBe(false)
  expect(historical.metadata.consumerGrantMetadata).toEqual(a.metadata.consumerGrantMetadata)
  expect(encodeRuntimeEntryMetadataAuthorization(historical)).not.toBe(fixture.expected)
})
it.each(['schemaVersion', 'purpose', 'issuer', 'keyId', 'authorityEnvironmentId', 'accountIssuer', 'accountSubject',
  'accountBindingId', 'accountBindingVersion', 'peer', 'requestId', 'issuedAt', 'expiresAt', 'metadata', 'signature'] as const)(
  'rejects absent/nondata/unknown top-level field %s without invoking it', (key) => {
    const invalid = Object.fromEntries(Object.entries(copy()).filter(([field]) => field !== key))
    expect(() => parseRuntimeEntryMetadataAuthorization(invalid)).toThrow()
    let reads = 0
    Object.defineProperty(invalid, key, { enumerable: true, get: () => { reads++; throw Error('not data') } })
    expect(() => parseRuntimeEntryMetadataAuthorization(invalid)).toThrow()
    expect(reads).toBe(0)
    expect(() => parseRuntimeEntryMetadataAuthorization({ ...fixture.value, [Symbol('extra')]: 1 })).toThrow()
  })
it.each([
  { schemaVersion: 2 }, { purpose: 'project_operation_runtime_entry_observation' }, { issuer: '' }, { issuer: 'untrusted\nissuer' },
  { keyId: '../key' }, { authorityEnvironmentId: 'invalid' }, { accountIssuer: '\ud800' }, { accountSubject: 'owner' },
  { accountBindingId: '/caller/path' }, { accountBindingVersion: 0 }, { accountBindingVersion: 1.5 },
  { issuedAt: -1 }, { expiresAt: fixture.value.issuedAt }, { expiresAt: fixture.value.issuedAt + 120001 },
  { signature: '=' }, { signature: 'A' }, { signature: 'B'.repeat(86) },
  { metadata: { ...fixture.value.metadata, sourceKind: 'restricted' } },
  { metadata: { ...fixture.value.metadata, dispatchGranted: 'true' } },
  { metadata: { ...fixture.value.metadata, taskRef: '/' } },
  { metadata: { ...fixture.value.metadata, verified: true } },
  { peer: { ...fixture.value.peer, publicKey: 'B'.repeat(43) } },
  { peer: { ...fixture.value.peer, hostEpoch: '0' } },
  { peer: { ...fixture.value.peer, privateKey: 'forbidden' } },
])('rejects invalid grammar and bounded signature encoding %#', (patch) => {
  expect(() => parseRuntimeEntryMetadataAuthorization({ ...fixture.value, ...patch })).toThrow()
})
it('binds the exact original grant digest and rejects mutable tuple substitutions', () => {
  const original = fixture.value.metadata.consumerGrantMetadata
  expect(parseRuntimeEntryConsumerGrantMetadata(original)).toEqual(original)
  expect(() => parseRuntimeEntryConsumerGrantMetadata({ ...original, expectedEventCount: -1 })).toThrow()
  expect(() => parseRuntimeEntryConsumerGrantMetadata({ ...original, grantExpiresAt: original.grantIssuedAt })).toThrow()
  expect(() => parseRuntimeEntryConsumerGrantMetadata({ ...original, expectedEventCount: original.expectedEventCount + 1 })).toThrow()
  expect(() => parseRuntimeEntryConsumerGrantMetadata({ ...original, consumerGrantDigest: '0'.repeat(64) })).toThrow()
  const keys = ['namespaceId', 'consumerCommandId', 'consumerAttemptId', 'consumerStepGrantId', 'rootTaskId', 'rootTraceId',
    'executionCommandId', 'terminalDeliveryId', 'terminalResultDigest', 'sessionId', 'grantIssuedAt', 'grantExpiresAt'] as const
  for (const key of keys) {
    const grant = { ...original, [key]: typeof original[key] === 'number' ? original[key] + 1 :
      key === 'namespaceId' ? 'n2_' + 'f'.repeat(64) : key === 'rootTraceId' ? 'f'.repeat(32) :
        key === 'terminalResultDigest' ? 'f'.repeat(64) : key === 'sessionId' || key === 'terminalDeliveryId' ? 'different' :
          '10000000-0000-4000-8000-000000000099' }
    const tuple = [grant.namespaceId, grant.consumerCommandId, grant.commandDigest, grant.consumerAttemptId, grant.consumerStepGrantId,
      grant.rootTaskId, grant.rootTraceId, grant.executionCommandId, grant.terminalDeliveryId, grant.terminalResultDigest, grant.messageId,
      grant.sessionId, grant.expectedEventCount, grant.expectedLogDigest, grant.hostEpoch, grant.grantIssuedAt, grant.grantExpiresAt]
    const sealed = { ...grant, consumerGrantDigest: createHash('sha256')
      .update('slark.project-operation-runtime-entry-consumer-grant/v1\0' + JSON.stringify(tuple)).digest('hex') }
    const b = { ...fixture.value.metadata.binding, consumerGrantDigest: sealed.consumerGrantDigest }
    expect(() => parseRuntimeEntryMetadataAuthorization({ ...fixture.value,
      metadata: { ...fixture.value.metadata, binding: b, consumerGrantMetadata: sealed } })).toThrow()
  }
  expect(() => parseRuntimeEntryMetadataAuthorization({ ...fixture.value, authorityEnvironmentId:
    '10000000-0000-4000-8000-000000000099' })).toThrow()
  expect(() => parseRuntimeEntryMetadataAuthorization({ ...fixture.value, metadata: { ...fixture.value.metadata,
    binding: { ...fixture.value.metadata.binding, consumerGrantDigest: 'f'.repeat(64) } } })).toThrow()
})
