import { expect, it } from 'vitest'
import {
  encodeHostBindingIntent, HOST_BINDING_INTENT_PURPOSE, HOST_BINDING_RECEIPT_PURPOSE,
  parseHostBindingIntentProof, parseHostBindingReceiptProof,
  parseHostBindingRegistration, parseHostBindingWorkerEvidence,
  parseHostPrivateTwinCommand, parseHostPrivateTwinResult, PRIVATE_TWIN_CONTROL_CHUNK_BYTES,
  PRIVATE_TWIN_CONTROL_REQUEST_BYTES,
} from '../src/index.ts'

const ticket = Buffer.alloc(32, 47).toString('base64url')
const profile_id = 'b3eeeaf0-6d61-4f7c-a6ad-feccae862c10'
const digest = 'a'.repeat(64)

it('validates exact private twin commands and bounded upload fragments', () => {
  const finish = { operation: 'finish', ticket, offset: 1, total_bytes: 2, digest, bytes: 'YQ' }
  expect(parseHostPrivateTwinCommand({ operation: 'claim' })).toEqual({ operation: 'claim' })
  expect(parseHostPrivateTwinCommand({ operation: 'claim', binding_profile_epoch: true }))
    .toEqual({ operation: 'claim', binding_profile_epoch: true })
  expect(parseHostPrivateTwinCommand(finish)).toEqual(finish)
  for (const value of [
    null, [], { operation: 'other' }, { operation: 'claim', [Symbol()]: 'extra' },
    { operation: 'claim', binding_profile_epoch: false }, { operation: 'claim', binding_profile_epoch: 1 },
    Object.defineProperty({ operation: 'claim' }, 'ticket', { get() { throw Error('untrusted getter') } }),
    { operation: 'check', ticket: 'YQ' }, { operation: 'check', ticket: '!' },
    { operation: 'read', ticket, offset: -1 }, { operation: 'read', ticket, offset: PRIVATE_TWIN_CONTROL_REQUEST_BYTES },
    { ...finish, digest: 'B'.repeat(64) }, { ...finish, offset: finish.total_bytes },
    { ...finish, bytes: 'YWI' }, { ...finish, bytes: 'YQ=' }, { ...finish, bytes: '' },
    { ...finish, bytes: Buffer.alloc(PRIVATE_TWIN_CONTROL_CHUNK_BYTES + 1).toString('base64url') },
  ]) expect(() => parseHostPrivateTwinCommand(value)).toThrow('invalid_host_private_twin_frame')
})

it('validates idle, claim and exact progress states without trusting result coordinates', () => {
  const claimed = { state: 'claimed', profile_id, ticket, total_bytes: 1, digest }
  expect(parseHostPrivateTwinResult({ state: 'idle' })).toEqual({ state: 'idle' })
  expect(parseHostPrivateTwinResult(claimed)).toEqual(claimed)
  const scoped = { ...claimed, binding_profile_epoch: 7 }
  expect(parseHostPrivateTwinResult(scoped)).toEqual(scoped)
  for (const state of ['current', 'completed']) expect(parseHostPrivateTwinResult({ state, ticket })).toEqual({ state, ticket })
  for (const value of [
    { state: 'unrecognized' }, { state: 'idle', ticket }, { ...claimed, profile_id: 'unknown' },
    { ...claimed, profile_id: 123 }, { ...claimed, total_bytes: 0 }, { ...claimed, total_bytes: 1.5 },
    { ...claimed, binding_profile_epoch: 0 }, { ...claimed, binding_profile_epoch: '7' },
    { state: 'chunk', ticket, offset: 0, bytes: 'YQ==' }, { state: 'staged', ticket, next_offset: 0 },
  ]) expect(() => parseHostPrivateTwinResult(value)).toThrow('invalid_host_private_twin_frame')
})

it('accepts only exact binding claims, registration, evidence and bounded lifetime', () => {
  const registration = { audience: 'https://slark.example', ownerUserId: 'owner', computerId: 'computer',
    accountBindingId: 'cloud-account', accountBindingVersion: 2, hostEpoch: '7' }
  const evidence = { requestId: profile_id, messageSeq: 24, messageDigest: digest,
    previewDigest: digest, commandDigest: digest, expiresAt: 101 }
  const claims = { ...registration, ...evidence, version: 1, purpose: HOST_BINDING_INTENT_PURPOSE,
    environmentId: profile_id, profileId: profile_id, profileEpoch: 1, hostAccountBindingId: 'host-account',
    hostAccountBindingVersion: 2, installationId: profile_id, hostInstanceId: profile_id, processNonce: ticket,
    mainBotId: 'main', sessionId: 'private', messageId: 'confirm', issuedAt: 100 }
  const signature = Buffer.alloc(64, 13).toString('base64url')
  const proof = parseHostBindingIntentProof({ claims, signature })
  expect(proof).toEqual({ claims, signature })
  expect(proof.claims).not.toBe(claims)
  expect(Buffer.from(encodeHostBindingIntent(proof.claims)).toString()).toMatch(/^\{"accountBindingId":"cloud-account",/u)
  expect(parseHostPrivateTwinCommand({ operation: 'sign_binding', ticket, registration })).toEqual({ operation: 'sign_binding', ticket, registration })
  expect(parseHostPrivateTwinResult({ state: 'binding_intent', ticket, proof })).toEqual({ state: 'binding_intent', ticket, proof })
  for (const invalid of [null, [], { ...registration, extra: true },
    Object.defineProperty({ ...registration }, 'hostEpoch', { get() { throw Error('unsolicited getter') } }),
    { ...registration, audience: 'https://slark.example/path' }, { ...registration, audience: 'http://slark.example' },
    { ...registration, audience: 'x'.repeat(2049) }, { ...registration, audience: 1 },
    { ...registration, hostEpoch: '9223372036854775808' }, { ...registration, ownerUserId: 'owner\n' },
  ]) expect(() => parseHostBindingRegistration(invalid)).toThrow('invalid_host_binding_intent')
  for (const invalid of [{ ...evidence, messageSeq: '24' }, { ...evidence, messageSeq: 0 },
    { ...evidence, expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { ...evidence, commandDigest: 'bad' },
  ]) expect(() => parseHostBindingWorkerEvidence(invalid)).toThrow('invalid_host_binding_intent')
  for (const invalid of [{ ...claims, expiresAt: claims.issuedAt }, { ...claims, expiresAt: 30_101 },
    { ...claims, purpose: 'unsupported' }, { ...claims, version: 2 },
  ]) expect(() => parseHostBindingIntentProof({ claims: invalid, signature })).toThrow('invalid_host_binding_intent')
  const receipt = {
    ...registration, version: 1, purpose: HOST_BINDING_RECEIPT_PURPOSE, lookupBy: 'request', lookupId: profile_id,
    environmentId: claims.environmentId, profileId: claims.profileId, profileEpoch: claims.profileEpoch,
    hostAccountBindingId: claims.hostAccountBindingId, hostAccountBindingVersion: claims.hostAccountBindingVersion,
    installationId: claims.installationId, hostInstanceId: claims.hostInstanceId, processNonce: claims.processNonce,
    mainBotId: claims.mainBotId, sessionId: claims.sessionId, issuedAt: claims.issuedAt, expiresAt: 30_100,
  }
  expect(parseHostBindingReceiptProof({ claims: receipt, signature })).toEqual({ claims: receipt, signature })
  for (const patch of [
    { lookupBy: 'operation' }, { purpose: HOST_BINDING_INTENT_PURPOSE }, { version: 2 },
    { expiresAt: 100 }, { expiresAt: 30_101 },
  ]) expect(() => parseHostBindingReceiptProof({ claims: { ...receipt, ...patch }, signature })).toThrow('invalid_host_binding_intent')
})
