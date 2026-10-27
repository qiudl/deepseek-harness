import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostBotImportGrantPayload, verifyHostBotImportGrant,
  type HostBotImportGrantClaims } from '../src/bot-import-grant.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32).toString('base64url')
const now = 1_800_000_000_000
const claims: HostBotImportGrantClaims = {
  schema_version: 'dsh-bot-import-grant/v1', operation_id: randomUUID(),
  source_digest: 'a'.repeat(64), target_device_id: 'm5max',
  authority_environment_id: randomUUID(), account_binding_handle: 'binding:main',
  authority_binding_version: 1, account_issuer: 'https://accounts.example.test',
  account_subject: randomUUID(), host_instance_id: randomUUID(),
  process_nonce: randomBytes(32).toString('base64url'),
  boot_nonce: randomBytes(32).toString('base64url'),
  issued_at: now - 1000, expires_at: now + 60_000,
  nonce: randomBytes(32).toString('base64url'),
}
const grant = { ...claims,
  signature: sign(null, encodeHostBotImportGrantPayload(claims), keys.privateKey).toString('base64url') }
const expected = { hostInstanceId: claims.host_instance_id, processNonce: claims.process_nonce,
  bootNonce: claims.boot_nonce,
  authorityEnvironmentId: claims.authority_environment_id,
  accountBindingHandle: claims.account_binding_handle,
  authorityBindingVersion: claims.authority_binding_version,
  issuer: claims.account_issuer, subject: claims.account_subject,
  operationId: claims.operation_id, sourceDigest: claims.source_digest,
  targetDeviceId: claims.target_device_id }

it('accepts a bound short-lived Main signature and rejects scope changes or expiry', () => {
  expect(verifyHostBotImportGrant(grant, publicKey, expected, now)).toEqual(grant)
  for (const changed of [
    { ...grant, source_digest: 'b'.repeat(64) },
    { ...grant, target_device_id: 'boston' },
    { ...grant, account_subject: randomUUID() },
    { ...grant, profile_path: '/private/team' },
  ]) expect(() => verifyHostBotImportGrant(changed, publicKey, expected, now)).toThrow()
  expect(() => verifyHostBotImportGrant(grant, publicKey,
    { ...expected, hostInstanceId: randomUUID() }, now)).toThrow()
  expect(() => verifyHostBotImportGrant(grant, publicKey, expected, claims.expires_at)).toThrow()
  expect(() => verifyHostBotImportGrant(grant, publicKey, expected, claims.issued_at - 1)).toThrow()
})
