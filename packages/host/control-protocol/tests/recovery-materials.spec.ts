import { describe, expect, it } from 'vitest'
import {
  encodeRecoveryDescriptorPayload, parseRecoveryDescriptor,
  parseRecoveryDescribeInput, parseRecoveryValidateInput, parseRecoveryValidation,
} from '../src/recovery-materials.ts'
import { decodeHostControlFrame, encodeHostControlFrame } from '../src/codec.ts'
import type { HostControlFrame } from '../src/types.ts'

const nonce = Buffer.alloc(32, 7).toString('base64url')
const uuid = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
const descriptor = {
  version: 1, type: 'dsh.host-access-recovery', installationId: uuid,
  installationKeyFingerprint: 'a'.repeat(64), profileId: uuid,
  issuer: 'https://accounts.example.com', subject: 'subject:历史',
  profileKeyHandle: nonce, materialCommitment: 'b'.repeat(64),
  bindingGeneration: 0, schemaGeneration: 1, persistenceGeneration: 0, challenge: nonce,
}
const input = { challenge: nonce, issuer: descriptor.issuer, subject: descriptor.subject,
  profile_key_handle: nonce, unlock_proof: nonce }
const authorization = {
  client_instance_id: uuid, host_instance_id: uuid, process_nonce: nonce, jti: uuid,
  issued_at: 1000, expires_at: 2000,
}

describe('same-Host recovery material wire fields', () => {
  it('signs a fixed-order array and normalizes reordered descriptor fields', () => {
    const reordered = Object.fromEntries(Object.entries(descriptor).reverse())
    expect(parseRecoveryDescriptor(reordered)).toEqual(descriptor)
    expect(encodeRecoveryDescriptorPayload(parseRecoveryDescriptor(reordered))).toBe(
      'DSH-RECOVERY-DESCRIPTOR-v1\0' + JSON.stringify(Object.values(descriptor)),
    )
    expect(Object.isFrozen(parseRecoveryDescriptor(descriptor))).toBe(true)
  })
  it('rejects malformed identities, extra fields and noncanonical secret encodings', () => {
    const invalid = [
      { ...input, issuer: 'https://accounts.example.com/' },
      { ...input, issuer: 'https://user@accounts.example.com' },
      { ...input, issuer: 'http://accounts.example.com' },
      { ...input, subject: '\ud800' },
      { ...input, subject: 'é'.repeat(129) },
      { ...input, subject: 'a\nb' },
      { ...input, unlock_proof: 'A'.repeat(42) + 'B' },
      { ...input, profile_key_handle: nonce + '=' },
      { ...input, extra: 1 },
    ]
    for (const value of invalid) expect(() => parseRecoveryDescribeInput(value)).toThrow()
    for (const value of [
      { ...descriptor, version: 2 }, { ...descriptor, bindingGeneration: -1 },
      { ...descriptor, schemaGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...descriptor, installationId: 'not-a-uuid' }, { ...descriptor, publicKey: nonce },
    ]) expect(() => parseRecoveryDescriptor(value)).toThrow()
    expect(() => parseRecoveryValidateInput({
      challenge: nonce, descriptor, signature: 'A'.repeat(85) + 'B', unlock_proof: nonce,
    })).toThrow()
  })
  it('rejects non-records, accessors, invalid UTF-8 identities and false validation claims', () => {
    for (const value of [null, [], new Date(), { ...input, [Symbol('secret')]: 1 },
      Object.defineProperty({ ...input }, 'subject', { get: () => 'hidden', enumerable: true }),
      { ...input, issuer: 'not a URL' }]) {
      expect(() => parseRecoveryDescribeInput(value)).toThrow()
    }
    expect(parseRecoveryDescribeInput(Object.assign(Object.create(null), input))).toEqual(input)
    expect(() => parseRecoveryValidation({ valid: false, challenge: nonce, descriptorDigest: 'c'.repeat(64),
      materialCommitment: 'b'.repeat(64), currentInstallationId: uuid, currentProfileId: uuid,
      currentBindingGeneration: 0, currentPersistenceGeneration: 0 })).toThrow()
    expect(() => decodeHostControlFrame(JSON.stringify({
      version: 1, type: 'request', request_id: uuid, method: 'profile.recovery_materials.describe',
      params: { ...authorization, ...input, extra: 'x'.repeat(16384) },
    }) + '\n')).toThrow()
  })
  it('round trips authenticated describe and validate while rejecting omitted authority', () => {
    const frames: unknown[] = [
      { version: 1, type: 'request', request_id: uuid, method: 'profile.recovery_materials.describe',
        params: { ...authorization, ...input } },
      { version: 1, type: 'request', request_id: uuid, method: 'profile.recovery_materials.validate',
        params: { ...authorization, challenge: nonce, descriptor, signature: 'A'.repeat(86), unlock_proof: nonce } },
      { version: 1, type: 'result', request_id: uuid, method: 'profile.recovery_materials.describe',
        result: { descriptor, signature: 'A'.repeat(86) } },
      { version: 1, type: 'result', request_id: uuid, method: 'profile.recovery_materials.validate',
        result: { valid: true, challenge: nonce, descriptorDigest: 'c'.repeat(64),
          materialCommitment: descriptor.materialCommitment, currentInstallationId: uuid, currentProfileId: uuid,
          currentBindingGeneration: 0, currentPersistenceGeneration: 2 } },
    ]
    for (const frame of frames) {
      const parsed = decodeHostControlFrame(JSON.stringify(frame) + '\n')
      expect(decodeHostControlFrame(encodeHostControlFrame(parsed))).toEqual(frame)
    }
    expect(() => decodeHostControlFrame(JSON.stringify({
      version: 1, type: 'request', request_id: uuid, method: 'profile.recovery_materials.describe', params: input,
    }) + '\n')).toThrow()
    const frame: HostControlFrame = decodeHostControlFrame(JSON.stringify(frames[0]) + '\n')
    expect(frame.method).toBe('profile.recovery_materials.describe')
  })
})
