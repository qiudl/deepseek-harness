import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostBotImportRelayKeyPayload, issueHostBotImportRelayKey } from
  '../src/bot-import-relay-key.ts'

const installed = generateKeyPairSync('ed25519')
const identity = { installationId: randomUUID(), installationPrivateKey: installed.privateKey,
  installationPublicKey: (installed.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32).toString('base64url'), hostInstanceId: randomUUID(),
  processNonce: randomBytes(32).toString('base64url') }
const profileId = randomUUID()
const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const ephemeralPublicKey = (ecdh.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-65).toString('base64url')
const input = { identity, currentProfileId: () => profileId,
  targetDeviceId: `target-${'a'.repeat(64)}`, targetProfileId: profileId,
  importOperationId: randomUUID(), sourceDigest: 'b'.repeat(64), ephemeralPublicKey,
  now: 1_800_000_000_000 }

it('signs a target key with the current Account Profile and installation identity', () => {
  const assertion = issueHostBotImportRelayKey(input)
  const { signature, ...claims } = assertion
  const raw = Buffer.from(identity.installationPublicKey, 'base64url')
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), raw,
  ]), format: 'der', type: 'spki' })
  expect(verify(null, encodeHostBotImportRelayKeyPayload(claims), key,
    Buffer.from(signature, 'base64url'))).toBe(true)
  expect(assertion.targetProfileId).toBe(profileId)
  expect(assertion.expiresAt - assertion.issuedAt).toBe(300_000)
})

it('rejects a changed Profile, mismatched installation key or malformed ephemeral key', () => {
  expect(() => issueHostBotImportRelayKey({ ...input,
    currentProfileId: () => randomUUID() })).toThrow()
  expect(() => issueHostBotImportRelayKey({ ...input,
    identity: { ...identity, installationPublicKey: randomBytes(32).toString('base64url') } })).toThrow()
  expect(() => issueHostBotImportRelayKey({ ...input,
    ephemeralPublicKey: 'A'.repeat(87) })).toThrow()
  let reads = 0
  expect(() => issueHostBotImportRelayKey({ ...input,
    currentProfileId: () => { reads++; return reads === 1 ? profileId : randomUUID() } })).toThrow()
})
