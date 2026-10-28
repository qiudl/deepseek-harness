import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame,
  parseHostBotImportRelayKeyAssertion, parseHostBotImportRelayKeyRequest } from '../src/index.ts'

const id = randomUUID()
const request = { targetDeviceId: `target-${'a'.repeat(64)}`,
  targetProfileId: id, importOperationId: randomUUID(), sourceDigest: 'b'.repeat(64),
  ephemeralPublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url') }
const assertion = { version: 1, installationId: randomUUID(),
  installationPublicKey: Buffer.alloc(32).toString('base64url'),
  hostInstanceId: randomUUID(), processNonce: Buffer.alloc(32).toString('base64url'),
  ...request, nonce: Buffer.alloc(32, 1).toString('base64url'),
  issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_300_000,
  signature: Buffer.alloc(64).toString('base64url') }

it('accepts only the fixed relay request and assertion wire fields', () => {
  expect(parseHostBotImportRelayKeyRequest(request)).toEqual(request)
  expect(parseHostBotImportRelayKeyAssertion(assertion)).toEqual(assertion)
  for (const changed of [{ ...request, profilePath: '/private' },
    { ...request, targetProfileId: randomUUID().toUpperCase() },
    { ...request, ephemeralPublicKey: 'A'.repeat(87) }])
    expect(() => parseHostBotImportRelayKeyRequest(changed)).toThrow()
  for (const changed of [{ ...assertion, secret: 'private' },
    { ...assertion, expiresAt: assertion.expiresAt + 1 },
    { ...assertion, signature: 'A'.repeat(85) + 'B' }])
    expect(() => parseHostBotImportRelayKeyAssertion(changed)).toThrow()
})

it('roundtrips the Account-bound Host command and rejects extra wire fields', () => {
  const frame = { version: 1, type: 'request', request_id: randomUUID(),
    method: 'profile.bot_import_relay_key', params: {
      client_instance_id: randomUUID(), host_instance_id: assertion.hostInstanceId,
      process_nonce: assertion.processNonce, jti: randomUUID(), issued_at: 1000, expires_at: 2000,
      authority_environment_id: randomUUID(), account_binding_handle: 'binding:bot',
      authority_binding_version: 1, account_issuer: 'https://accounts.example.test',
      account_subject: randomUUID(), relay: request } }
  const reply = { version: 1, type: 'result', request_id: frame.request_id,
    method: frame.method, result: { assertion } }
  for (const value of [frame, reply])
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
      .toBe(`${JSON.stringify(value)}\n`)
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame, params: {
    ...frame.params, relay: { ...request, privateKey: 'secret' } } })}\n`)).toThrow()
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...reply,
    result: { assertion: { ...assertion, targetProfileId: 'other' } } })}\n`)).toThrow()
})
