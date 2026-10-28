import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostBotImportSourceRelayKeyPayload } from '@deepseek-ai/dsh-host-control-protocol'
import { issueHostBotImportSourceRelayKey } from '../src/bot-import-source-relay-key.ts'

const pair = generateKeyPairSync('ed25519')
const identity = { installationId: randomUUID(), installationPrivateKey: pair.privateKey,
  installationPublicKey: (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32).toString('base64url'), hostInstanceId: randomUUID(),
  processNonce: randomBytes(32).toString('base64url') }
const profileId = randomUUID()
const relay = { sourceComputerId: 'boston-computer', sourceProfileId: profileId,
  environmentId: randomUUID(), accountIssuer: 'https://accounts.example.test',
  accountSubject: randomUUID(), accountBindingHandle: 'binding', authGeneration: 3,
  importOperationId: randomUUID(), sourceDigest: 'a'.repeat(64),
  targetAssertionDigest: 'b'.repeat(64),
  ephemeralPublicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url') }
const input = { identity, relay, currentProfileId: () => profileId, now: 1_800_000_000_000 }

it('signs only the current source Profile and exact target assertion digest', () => {
  const assertion = issueHostBotImportSourceRelayKey(input)
  const { signature, ...claims } = assertion
  const raw = Buffer.from(identity.installationPublicKey, 'base64url')
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), raw,
  ]), format: 'der', type: 'spki' })
  expect(verify(null, encodeHostBotImportSourceRelayKeyPayload(claims), key,
    Buffer.from(signature, 'base64url'))).toBe(true)
  expect(assertion.targetAssertionDigest).toBe(relay.targetAssertionDigest)
  expect(() => issueHostBotImportSourceRelayKey({ ...input,
    currentProfileId: () => randomUUID() })).toThrow()
  let reads = 0
  expect(() => issueHostBotImportSourceRelayKey({ ...input,
    currentProfileId: () => { reads++; return reads === 1 ? profileId : randomUUID() } })).toThrow()
  expect(() => issueHostBotImportSourceRelayKey({ ...input,
    identity: { ...identity, installationPublicKey: randomBytes(32).toString('base64url') } })).toThrow()
})
