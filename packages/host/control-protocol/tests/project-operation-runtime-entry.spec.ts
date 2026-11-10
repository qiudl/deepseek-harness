/** REQ-20261031-0006 / Task26692: paired grammar/preimage vectors, never writer/Right authority. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { test } from 'node:test'
import * as c from '../src/project-operation-runtime-entry.js'
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/project-operation-runtime-entry-v1.json', import.meta.url),
    'utf8',
  ),
) as {
  values: {
    binding: c.RuntimeEntryBinding
    receipt: c.RuntimeEntryReceipt
    manifest: c.RuntimeEntryManifest
    observation: c.RuntimeEntryObservation
    attribution: c.RuntimeEntryAttribution
  }
  expected: Record<'binding' | 'receipt' | 'manifest' | 'observation' | 'attribution' | 'sourceEventMapping', string>
}
const parsers = {
  binding: c.parseRuntimeEntryBinding,
  receipt: c.parseRuntimeEntryReceipt,
  manifest: c.parseRuntimeEntryManifest,
  observation: c.parseRuntimeEntryObservation,
  attribution: c.parseRuntimeEntryAttribution,
}
const encoders = {
  binding: c.encodeRuntimeEntryBinding,
  receipt: c.encodeRuntimeEntryReceipt,
  manifest: c.encodeRuntimeEntryManifest,
  observation: c.encodeRuntimeEntryObservation,
  attribution: c.encodeRuntimeEntryAttribution,
}
for (const key of Object.keys(parsers) as (keyof typeof parsers)[])
  void test('fixed canonical tuple/domain ' + key, () => {
    const value = fixture.values[key]
    assert.equal(encoders[key](value), fixture.expected[key])
    assert(Object.isFrozen(parsers[key](value)))
    const reordered = Object.fromEntries(Object.entries(value).reverse())
    assert.equal(encoders[key](reordered), fixture.expected[key])
    assert.throws(() => parsers[key]({ ...value, verified: true }))
    assert.throws(() => parsers[key]({ ...value, extra: undefined }))
    let reads = 0
    const getter = { ...value }
    const firstKey = Object.keys(value)[0]
    assert(firstKey !== undefined)
    Object.defineProperty(getter, firstKey, {
      enumerable: true,
      get() {
        reads++
        return 1
      },
    })
    assert.throws(() => parsers[key](getter))
    assert.equal(reads, 0)
  })
void test('exact signature preimages bind purpose, original identities and receipt but exclude only their own signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  for (const [key, encoder] of [
    ['observation', c.encodeRuntimeEntryObservation],
    ['attribution', c.encodeRuntimeEntryAttribution],
  ] as const) {
    const original = fixture.values[key],
      signature = sign(null, Buffer.from(encoder(original)), privateKey).toString('base64url')
    assert.equal(encoder({ ...original, signature }), encoder(original))
    assert(
      verify(
        null,
        Buffer.from(encoder({ ...original, signature })),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    )
    assert(
      !verify(
        null,
        Buffer.from(
          encoder({ ...original, accountBindingVersion: original.accountBindingVersion + 1 }),
        ),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    )
  }
  assert.throws(() => c.parseRuntimeEntryObservation(fixture.values.attribution))
  assert.throws(() => c.parseRuntimeEntryAttribution(fixture.values.observation))
  assert.throws(() =>
    c.parseRuntimeEntryObservation({
      ...fixture.values.observation,
      purpose: 'project_operation_origin_observation',
    }),
  )
})
void test('scope/time/version/key bounds cannot be widened or truncated', () => {
  const b = fixture.values.binding,
    o = fixture.values.observation,
    r = fixture.values.receipt
  for (const value of [
    { ...b, bindingGeneration: '01' },
    { ...b, bindingGeneration: '9223372036854775808' },
    { ...b, rootTraceId: '0'.repeat(32) },
    { ...b, namespaceId: 'other' },
    { ...b, sessionId: 'different' },
    { ...b, originalExecutorRef: { ...b.originalExecutorRef, invocationId: 'different' } },
  ])
    assert.throws(() => c.parseRuntimeEntryBinding(value))
  assert.throws(() => c.parseRuntimeEntryReceipt({ ...r, entryEffectAt: b.grantExpiresAt }))
  for (const value of [
    { ...o, expiresAt: o.issuedAt + 15001 },
    { ...o, issuedAt: r.entryEffectAt - 1, expiresAt: r.entryEffectAt + 100 },
    { ...o, peer: { ...o.peer, hostEpoch: '0' } },
    { ...o, peer: { ...o.peer, publicKey: 'A'.repeat(42) + 'B' } },
    { ...o, nonce: 'a'.repeat(64) },
  ])
    assert.throws(() => c.parseRuntimeEntryObservation(value))
  assert.throws(() =>
    c.parseRuntimeEntryAttribution({ ...fixture.values.attribution, sourceEventId: 'forged' }),
  )
})
void test('manifest has complete field grammar, unique sources/decisions and no dangling or accessor edges', () => {
  const m = fixture.values.manifest
  for (const value of [
    { ...m, sources: [...m.sources, ...m.sources] },
    { ...m, decisions: [...m.decisions, m.decisions[0]] },
    { ...m, fieldDerivations: m.fieldDerivations.slice(1) },
    {
      ...m,
      fieldDerivations: m.fieldDerivations.map((f: Record<string, unknown>) => ({
        ...f,
        sourceIds: ['unknown'],
      })),
    },
    { ...m, sources: Array(65).fill(m.sources[0]) },
  ])
    assert.throws(() => c.parseRuntimeEntryManifest(value))
  const sources = [...m.sources]
  Object.defineProperty(sources, 'hidden', { value: true })
  assert.throws(() => c.parseRuntimeEntryManifest({ ...m, sources }))
})
void test('effect and independent readback digests are noncircular and bind actual receipt/manifest coordinates', () => {
  const r = fixture.values.receipt,
    m = fixture.values.manifest
  assert.equal(c.runtimeEntryEffectDigest(r), r.entryEffectDigest)
  assert.equal(c.runtimeEntryManifestDigest(m), r.manifestDigest)
  assert.equal(c.runtimeEntryReadbackDigest(r, m), fixture.values.observation.readbackDigest)
  assert.equal(
    c.runtimeEntryEffectDigest({ ...r, manifestDigest: '0'.repeat(64) }),
    r.entryEffectDigest,
  )
  assert.notEqual(c.runtimeEntryEffectDigest({ ...r, entryEffectSeq: '2' }), r.entryEffectDigest)
  assert.throws(() => c.runtimeEntryReadbackDigest(r, { ...m, registryGeneration: '2' }))
  assert.throws(() => c.runtimeEntryReadbackDigest({ ...r, journalEpoch: '2' }, m))
  assert.equal(
    createHash('sha256').update(c.encodeRuntimeEntryReceipt(r)).digest('hex'),
    c.runtimeEntryReceiptDigest(r),
  )
})

void test('signed actual source mapping is distinct from private receipt sequence/epoch and cannot be transplanted', () => {
  const o = fixture.values.observation,
    m = o.sourceEventMapping
  assert(m !== null)
  assert.equal(c.encodeRuntimeEntrySourceEventMapping(m), fixture.expected.sourceEventMapping)
  assert.equal(m.sourceSequence, '341')
  assert.equal(o.receipt.journalCommitSequence, '1')
  assert.equal(o.receipt.journalEpoch, '1')
  assert.equal(
    c.parseRuntimeEntryObservation({ ...o, sourceEventMapping: null }).sourceEventMapping,
    null,
    'receipt-only observation confers no attribution capability',
  )
  for (const sourceEventMapping of [
    { ...m, entryId: fixture.values.binding.admissionId },
    { ...m, entryReceiptDigest: '0'.repeat(64) },
    { ...m, manifestDigest: '0'.repeat(64) },
    { ...m, journalEpoch: o.receipt.journalEpoch },
  ])
    assert.throws(() => c.parseRuntimeEntryObservation({ ...o, sourceEventMapping }))
  const key = generateKeyPairSync('ed25519'),
    signature = sign(null, Buffer.from(c.encodeRuntimeEntryObservation(o)), key.privateKey)
  assert(
    !verify(
      null,
      Buffer.from(
        c.encodeRuntimeEntryObservation({
          ...o,
          sourceEventMapping: { ...m, sourceSequence: '342' },
        }),
      ),
      key.publicKey,
      signature,
    ),
  )
  assert(
    !verify(
      null,
      Buffer.from(
        c.encodeRuntimeEntryObservation({
          ...o,
          sourceEventMapping: { ...m, journalEpoch: '10000000-0000-4000-8000-000000000021' },
        }),
      ),
      key.publicKey,
      signature,
    ),
  )
})

void test('UTF8 validation rejects lone surrogates without depending on ESNext String APIs', () => {
  assert.throws(() =>
    c.parseRuntimeEntryObservation({ ...fixture.values.observation, issuer: 'bad\uD800' }),
  )
  assert.throws(() =>
    c.parseRuntimeEntryAttribution({ ...fixture.values.attribution, issuer: 'bad\uDC00' }),
  )
  assert.equal(
    c.parseRuntimeEntryObservation({ ...fixture.values.observation, issuer: '合法😀' }).issuer,
    '合法😀',
  )
})
