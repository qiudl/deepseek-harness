import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostBotImportGrantPayload,
  type HostBotImportGrantClaims } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from '../src/account-bot-identity.ts'
import { BotImportGrantRegistry } from '../src/bot-import-grants.ts'

const keys = generateKeyPairSync('ed25519')
const publicKey = (keys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  .subarray(-32).toString('base64url')
const now = 1_800_000_000_000
const account = { ownerId: 'owner', authorityEnvironmentId: randomUUID(),
  accountBindingHandle: 'binding:main', authorityBindingVersion: 1,
  issuer: 'https://accounts.example.test', subject: randomUUID() } as BotIdentityAccount
const identity = { hostInstanceId: randomUUID(),
  processNonce: randomBytes(32).toString('base64url'),
  bootNonce: randomBytes(32).toString('base64url') }
const claims: HostBotImportGrantClaims = {
  schema_version: 'dsh-bot-import-grant/v1', operation_id: randomUUID(),
  source_digest: 'a'.repeat(64), target_device_id: 'm5max',
  authority_environment_id: account.authorityEnvironmentId,
  account_binding_handle: account.accountBindingHandle,
  authority_binding_version: account.authorityBindingVersion,
  account_issuer: account.issuer, account_subject: account.subject,
  host_instance_id: identity.hostInstanceId, process_nonce: identity.processNonce,
  boot_nonce: identity.bootNonce, issued_at: now - 1000, expires_at: now + 60_000,
  nonce: randomBytes(32).toString('base64url'),
}
const grant = { ...claims,
  signature: sign(null, encodeHostBotImportGrantPayload(claims), keys.privateKey).toString('base64url') }

it('keeps one signed import approval bound to its owner, Profile, target and Host boot', () => {
  let time = now
  const registry = new BotImportGrantRegistry(publicKey, identity, () => time)
  expect(registry.register(grant, account, 'profile')).toEqual(grant)
  const sessionId = `session-${randomUUID()}`
  const input = { profileId: 'profile', ownerId: account.ownerId,
    scope: { source_digest: claims.source_digest, target_device_id: claims.target_device_id,
      session_id: sessionId },
    transfer: { kind: 'open' as const, operationId: claims.operation_id,
      sourceDigest: claims.source_digest, sessionId },
    signal: new AbortController().signal }
  expect(() => registry.check(input)).not.toThrow()
  for (const changed of [{ ownerId: 'other' }, { profileId: 'other' },
    { scope: { ...input.scope, target_device_id: 'boston' } }])
    expect(() => registry.check({ ...input, ...changed })).toThrow()
  expect(() => registry.register(grant, account, 'profile')).toThrow()
  time = claims.expires_at
  expect(() => registry.check(input)).toThrow()
  expect(() => new BotImportGrantRegistry(publicKey, { ...identity,
    bootNonce: randomBytes(32).toString('base64url') }, () => now)
    .register(grant, account, 'profile')).toThrow()
})
