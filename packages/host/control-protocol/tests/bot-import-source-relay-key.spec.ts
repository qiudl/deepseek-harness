import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/index.ts'
import { encodeHostBotImportSourceRelayKeyPayload,
  parseHostBotImportSourceRelayKeyAssertion,
  parseHostBotImportSourceRelayKeyRequest } from '../src/bot-import-source-relay-key.ts'

const request = { sourceComputerId: 'boston-computer', sourceProfileId: randomUUID(),
  environmentId: randomUUID(), accountIssuer: 'https://accounts.example.test',
  accountSubject: randomUUID(), accountBindingHandle: 'binding', authGeneration: 3,
  importOperationId: randomUUID(), sourceDigest: 'a'.repeat(64),
  targetAssertionDigest: 'b'.repeat(64),
  ephemeralPublicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url') }
const assertion = { version: 1 as const, installationId: randomUUID(),
  installationPublicKey: randomBytes(32).toString('base64url'),
  hostInstanceId: randomUUID(), processNonce: randomBytes(32).toString('base64url'),
  ...request, nonce: randomBytes(32).toString('base64url'),
  issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_300_000,
  signature: randomBytes(64).toString('base64url') }

it('parses the exact source relay request and signed fields', () => {
  expect(parseHostBotImportSourceRelayKeyRequest(request)).toEqual(request)
  expect(parseHostBotImportSourceRelayKeyAssertion(assertion)).toEqual(assertion)
  expect(encodeHostBotImportSourceRelayKeyPayload(assertion).toString())
    .toContain('dsh-bot-import-relay-source-key/v1')
  for (const changed of [{ ...request, targetAssertionDigest: 'bad' },
    { ...request, accountBindingHandle: 3 }, { ...request, privateKey: 'secret' }])
    expect(() => parseHostBotImportSourceRelayKeyRequest(changed)).toThrow()
  expect(() => parseHostBotImportSourceRelayKeyAssertion({ ...assertion,
    sourceProfileId: randomUUID().toUpperCase() })).toThrow()
})

it('roundtrips the Account-bound source Host command and rejects extra fields', () => {
  const frame = { version: 1, type: 'request', request_id: randomUUID(),
    method: 'profile.bot_import_source_relay_key', params: {
      client_instance_id: randomUUID(), host_instance_id: assertion.hostInstanceId,
      process_nonce: assertion.processNonce, jti: randomUUID(), issued_at: 1000,
      expires_at: 2000, authority_environment_id: request.environmentId,
      account_binding_handle: request.accountBindingHandle,
      authority_binding_version: request.authGeneration,
      account_issuer: request.accountIssuer, account_subject: request.accountSubject,
      relay: request } }
  const reply = { version: 1, type: 'result', request_id: frame.request_id,
    method: frame.method, result: { assertion } }
  for (const value of [frame, reply])
    expect(encodeHostControlFrame(decodeHostControlFrame(`${JSON.stringify(value)}\n`)))
      .toBe(`${JSON.stringify(value)}\n`)
  expect(() => decodeHostControlFrame(`${JSON.stringify({ ...frame, params: {
    ...frame.params, relay: { ...request, privateKey: 'secret' } } })}\n`)).toThrow()
})
