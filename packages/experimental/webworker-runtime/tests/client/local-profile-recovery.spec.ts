import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  enrollWebDshLocalProfile,
  parseWebDshRecoveryEnvelope,
  unlockWebDshRecoveryProfile,
} from '../../src/client/passkey-profile.ts'
import * as clientApi from '../../src/client/index.ts'

const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140'
const credentialId = Uint8Array.from({ length: 32 }, (_, index) => index + 1).buffer
const prf = Uint8Array.from({ length: 32 }, (_, index) => 255 - index).buffer
const labels = { relyingParty: 'DSH Web', profile: 'Local workspace' }

class FakePublicKeyCredential {
  readonly rawId = credentialId
  getClientExtensionResults(): object {
    return { prf: { enabled: true, results: { first: prf.slice(0) } } }
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: FakePublicKeyCredential,
    configurable: true,
  })
})

const credentials: Pick<CredentialsContainer, 'create' | 'get'> = {
  create: async () => new FakePublicKeyCredential() as unknown as Credential,
  get: async () => new FakePublicKeyCredential() as unknown as Credential,
}

describe('Web-local profile recovery wrapper', () => {
  it('does not expose passkey-only enrollment on the product client surface', () => {
    expect('enrollWebDshPasskeyProfile' in clientApi).toBe(false)
  })

  it('wraps one random data key with both passkey PRF and recovery passphrase', async () => {
    const enrolled = await enrollWebDshLocalProfile(
      'staging',
      labels,
      'correct horse battery staple 2026',
      {
        credentials,
        crypto: webcrypto as unknown as Crypto,
        randomUuid: () => profileId,
        now: () => 1_800_000_000_000,
      },
    )
    expect(enrolled.encryptionKey.extractable).toBe(false)
    expect(enrolled.passkeyEnvelope.profileId).toBe(profileId)
    expect(enrolled.recoveryEnvelope).toMatchObject({
      version: 1,
      environmentId: 'staging',
      profileId,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000 },
    })

    const recovered = await unlockWebDshRecoveryProfile(
      'staging',
      profileId,
      enrolled.recoveryEnvelope,
      'correct horse battery staple 2026',
      { crypto: webcrypto as unknown as Crypto },
    )
    expect(recovered.extractable).toBe(false)
    const iv = new Uint8Array(12)
    const ciphertext = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, recovered, new Uint8Array([4, 5, 6]),
    )
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, enrolled.encryptionKey, ciphertext,
    )
    expect([...new Uint8Array(plaintext)]).toEqual([4, 5, 6])
  })

  it('fails closed for a wrong passphrase, environment mismatch, or malformed KDF', async () => {
    const enrolled = await enrollWebDshLocalProfile(
      'staging',
      labels,
      'correct horse battery staple 2026',
      {
        credentials,
        crypto: webcrypto as unknown as Crypto,
        randomUuid: () => profileId,
      },
    )
    await expect(unlockWebDshRecoveryProfile(
      'staging', profileId, enrolled.recoveryEnvelope, 'wrong passphrase value',
      { crypto: webcrypto as unknown as Crypto },
    )).rejects.toThrow('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
    await expect(unlockWebDshRecoveryProfile(
      'production', profileId, enrolled.recoveryEnvelope, 'correct horse battery staple 2026',
      { crypto: webcrypto as unknown as Crypto },
    )).rejects.toThrow('WEB_DSH_RECOVERY_ENVELOPE_INVALID')
    expect(parseWebDshRecoveryEnvelope({
      ...enrolled.recoveryEnvelope,
      kdf: { ...enrolled.recoveryEnvelope.kdf, iterations: 1 },
    })).toBeNull()

    const relabeled = {
      ...enrolled.recoveryEnvelope,
      environmentId: 'production',
    }
    await expect(unlockWebDshRecoveryProfile(
      'production', profileId, relabeled, 'correct horse battery staple 2026',
      { crypto: webcrypto as unknown as Crypto },
    )).rejects.toThrow('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
  })

  it('rejects a weak recovery phrase before creating an authenticator credential', async () => {
    let creations = 0
    await expect(enrollWebDshLocalProfile('staging', labels, 'too short', {
      credentials: {
        create: async () => { creations += 1; return new FakePublicKeyCredential() as unknown as Credential },
        get: credentials.get,
      },
      crypto: webcrypto as unknown as Crypto,
      randomUuid: () => profileId,
    })).rejects.toThrow('WEB_DSH_RECOVERY_PASSPHRASE_INVALID')
    expect(creations).toBe(0)
  })
})
