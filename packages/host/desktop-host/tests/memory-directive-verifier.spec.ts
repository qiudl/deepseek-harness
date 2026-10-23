import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { MemoryDirectiveVerifier, type MemoryDirectiveContext } from '../src/memory-directive-verifier.ts'

const keys = generateKeyPairSync('ed25519')
const now = 1_800_000_000_000
const context: MemoryDirectiveContext = {
  environmentId: 'prod', ownerUserId: 'owner', computerId: 'computer',
  installationId: 'installation', profileId: 'profile',
  hostInstanceId: '22222222-2222-4222-8222-222222222222', processNonce: 'P'.repeat(43),
  operation: 'search', value: 'redacted', limit: 2,
}
const ringFixture = { version: 1, environmentId: context.environmentId,
  issuer: 'https://slark.example', keys: [{ kid: 'dsh-assertion-test',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    validFrom: 1, validUntil: now + 60_000 }] }
const publicRing = JSON.stringify(ringFixture)

function directive(readerKind: 'personal_dsh' | 'personal_coordinator' = 'personal_dsh',
  nonce = 'N'.repeat(43), issuedAt = now) {
  const grant = { grantId: '11111111-1111-4111-8111-111111111111', generation: 1,
    ownerUserId: 'owner', environmentId: context.environmentId, computerId: 'computer',
    installationId: context.installationId, profileId: context.profileId, readerKind }
  const unsigned = { schemaVersion: 1, purpose: 'dsh_memory_query', issuer: 'https://slark.example',
    keyId: 'dsh-assertion-test', requestId: '33333333-3333-4333-8333-333333333333',
    nonce, hostInstanceId: context.hostInstanceId, processNonce: context.processNonce,
    issuedAt, expiresAt: issuedAt + 15_000, operation: context.operation,
    queryDigest: createHash('sha256').update(JSON.stringify(['search', 'redacted', 2])).digest('hex'),
    limit: 2, grant }
  const payload = Buffer.from('slark.dsh-memory-query/v1\0' + JSON.stringify([
    1, 'dsh_memory_query', unsigned.issuer, unsigned.keyId, unsigned.requestId, unsigned.nonce,
    unsigned.hostInstanceId, unsigned.processNonce, unsigned.issuedAt, unsigned.expiresAt,
    unsigned.operation, unsigned.queryDigest, unsigned.limit, grant.grantId, grant.generation,
    grant.ownerUserId, grant.environmentId, grant.computerId, grant.installationId, grant.profileId,
    grant.readerKind,
  ]))
  return { ...unsigned, signature: sign(null, payload, keys.privateKey).toString('base64url') }
}

it('accepts one exact signed instruction and consumes its nonce', () => {
  const verifier = new MemoryDirectiveVerifier(publicRing, () => now + 1)
  const value = directive()
  const verified = verifier.verifyAndConsume(value, context)
  expect(verified.grant).toEqual(value.grant)
  expect(verified.expiresAt).toBe(value.expiresAt)
  expect(Object.isFrozen(verified)).toBe(true)
  expect(Object.isFrozen(verified.grant)).toBe(true)
  expect(() => { verifier.verifyAndConsume(value, context) }).toThrow(/replayed/u)
  value.grant.ownerUserId = 'changed'
  expect(verified.grant.ownerUserId).toBe('owner')
  verifier.assertUnexpired(verified)
  expect(() => { new MemoryDirectiveVerifier(publicRing, () => now + 15_000)
    .assertUnexpired(verified) }).toThrow(/stale/u)
})

it('accepts an explicitly signed personal coordinator grant for the same owner and Profile', () => {
  const value = directive('personal_coordinator')
  const verifier = new MemoryDirectiveVerifier(publicRing, () => now + 1)
  expect(verifier.verifyAndConsume(value, context).grant.readerKind).toBe('personal_coordinator')
  expect(() => verifier.verifyAndConsume({ ...value, grant: {
    ...value.grant, readerKind: 'personal_dsh' } }, context)).toThrow()
})

it('rejects changed scope, operation, limit, Host epoch, signature and expiry', () => {
  const value = directive()
  for (const [changed, expected] of [
    [{ ...value, grant: { ...value.grant, profileId: 'other' } }, context],
    [value, { ...context, ownerUserId: 'other' }],
    [value, { ...context, computerId: 'other' }],
    [value, { ...context, operation: 'evidence' as const }],
    [value, { ...context, limit: 3 }],
    [value, { ...context, processNonce: 'Q'.repeat(43) }],
    [{ ...value, signature: 'A'.repeat(86) }, context],
  ] as const) {
    expect(() => { new MemoryDirectiveVerifier(publicRing, () => now + 1)
      .verifyAndConsume(changed, expected) }).toThrow()
  }
  expect(() => { new MemoryDirectiveVerifier(publicRing, () => now + 15_000)
    .verifyAndConsume(value, context) }).toThrow()
})

it('rejects caller-supplied private keys and untrusted public ring shapes', () => {
  expect(() => new MemoryDirectiveVerifier(JSON.stringify({ ...JSON.parse(publicRing) as object,
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }))).toThrow()
  expect(() => new MemoryDirectiveVerifier(JSON.stringify({ version: 1, environmentId: 'prod',
    issuer: 'https://slark.example', keys: [{ kid: 'dsh-assertion-test', publicKeyPem: 'bad',
      validFrom: 1, validUntil: now + 60_000 }] }))).toThrow()
})

it('rejects malformed and non-Ed25519 keyrings before accepting a directive', () => {
  const valid = ringFixture
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString()
  const invalid = [
    'null', '{', 'x'.repeat(17_000), JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, keys: [] }),
    JSON.stringify({ ...valid, keys: [{ ...valid.keys[0], validUntil: 0 }] }),
    JSON.stringify({ ...valid, keys: [{ ...valid.keys[0], publicKeyPem: rsa }] }),
    JSON.stringify({ ...valid, keys: [{ ...valid.keys[0], publicKeyPem: keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' }).toString() }] }),
  ]
  for (const ring of invalid) expect(() => new MemoryDirectiveVerifier(ring)).toThrow()
})

it('rejects missing and out-of-window signing keys', () => {
  const value = directive()
  for (const changed of [
    { ...value, keyId: 'missing' },
    { ...value, issuedAt: 0 },
    { ...value, expiresAt: now + 120_000 },
  ]) expect(() => new MemoryDirectiveVerifier(publicRing, () => now + 1)
    .verifyAndConsume(changed, context)).toThrow()
})

it('bounds replay state and removes expired nonces', () => {
  let currentTime = now + 1
  const verifier = new MemoryDirectiveVerifier(publicRing, () => currentTime)
  for (let index = 0; index < 4096; index += 1) {
    const nonce = `N${index.toString(36).padStart(42, '0')}`
    verifier.verifyAndConsume(directive('personal_dsh', nonce), context)
  }
  expect(() => verifier.verifyAndConsume(directive('personal_dsh', 'Z'.repeat(43)), context))
    .toThrow(/busy/u)
  currentTime = now + 15_001
  expect(verifier.verifyAndConsume(directive('personal_dsh', 'Z'.repeat(43), now + 15_000), context))
    .toMatchObject({ requestId: '33333333-3333-4333-8333-333333333333' })
})
