import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  enrollWebDshPasskeyProfile,
  parseWebDshPasskeyEnvelope,
  unlockWebDshPasskeyProfile,
} from '../../src/client/passkey-profile.ts'

const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140'
const credentialId = Uint8Array.from({ length: 32 }, (_, index) => index + 1).buffer
const prf = Uint8Array.from({ length: 32 }, (_, index) => 255 - index).buffer
const labels = { relyingParty: 'DSH Web', profile: 'Local workspace' }

class FakePublicKeyCredential {
  readonly rawId = credentialId
  constructor(
    private readonly result: ArrayBuffer | null = prf,
    private readonly registration = false,
  ) {}
  getClientExtensionResults(): object {
    if (this.registration) {
      return this.result === null
        ? { prf: { enabled: false } }
        : { prf: { enabled: true, results: { first: this.result.slice(0) } } }
    }
    return this.result === null ? { prf: {} } : { prf: { results: { first: this.result.slice(0) } } }
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    value: FakePublicKeyCredential,
    configurable: true,
  })
})

function credentials(result: ArrayBuffer | null = prf): Pick<CredentialsContainer, 'create' | 'get'> {
  return {
    create: async () => new FakePublicKeyCredential(result, true) as unknown as Credential,
    get: async () => new FakePublicKeyCredential(result) as unknown as Credential,
  }
}

describe('Web-local passkey profile', () => {
  it('wraps and unlocks a non-extractable data key after passkey user verification', async () => {
    const enrolled = await enrollWebDshPasskeyProfile('staging', labels, {
      credentials: credentials(), crypto: webcrypto as unknown as Crypto,
      randomUuid: () => profileId, now: () => 1_800_000_000_000,
    })
    expect(enrolled.encryptionKey.extractable).toBe(false)
    expect(enrolled.envelope.environmentId).toBe('staging')
    expect(JSON.stringify(enrolled.envelope)).not.toContain('CryptoKey')

    const unlocked = await unlockWebDshPasskeyProfile('staging', profileId, enrolled.envelope, {
      credentials: credentials(), crypto: webcrypto as unknown as Crypto,
    })
    expect(unlocked.extractable).toBe(false)
    const iv = new Uint8Array(12)
    const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, unlocked, new Uint8Array([1, 2, 3]))
    const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, enrolled.encryptionKey, ciphertext)
    expect([...new Uint8Array(plaintext)]).toEqual([1, 2, 3])
  })

  it('binds the wrapped key to the exact environment and profile', async () => {
    const enrolled = await enrollWebDshPasskeyProfile('staging', labels, {
      credentials: credentials(), crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })
    await expect(unlockWebDshPasskeyProfile(
      'staging', profileId,
      { ...enrolled.envelope, environmentId: 'production' },
      { credentials: credentials(), crypto: webcrypto as unknown as Crypto },
    )).rejects.toThrow('WEB_DSH_PASSKEY_ENVELOPE_INVALID')
  })

  it('uses an immediate assertion when registration reports support without a PRF result', async () => {
    let assertions = 0
    const withoutCreationResult: Pick<CredentialsContainer, 'create' | 'get'> = {
      create: async () => {
        const created = new FakePublicKeyCredential(prf, true)
        created.getClientExtensionResults = () => ({ prf: { enabled: true } })
        return created as unknown as Credential
      },
      get: async () => {
        assertions += 1
        return new FakePublicKeyCredential(prf) as unknown as Credential
      },
    }
    const enrolled = await enrollWebDshPasskeyProfile('staging', labels, {
      credentials: withoutCreationResult, crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })
    expect(assertions).toBe(1)
    await expect(unlockWebDshPasskeyProfile('staging', profileId, enrolled.envelope, {
      credentials: credentials(), crypto: webcrypto as unknown as Crypto,
    })).resolves.toMatchObject({ extractable: false })
  })

  it('fails closed when the authenticator does not provide the PRF extension', async () => {
    await expect(enrollWebDshPasskeyProfile('staging', labels, {
      credentials: credentials(null), crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })).rejects.toThrow('WEB_DSH_PASSKEY_PRF_UNAVAILABLE')
  })

  it('strictly rejects extra fields and malformed environment identifiers', async () => {
    const enrolled = await enrollWebDshPasskeyProfile('staging', labels, {
      credentials: credentials(), crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })
    expect(parseWebDshPasskeyEnvelope({ ...enrolled.envelope, accountToken: 'leak' })).toBeNull()
    expect(parseWebDshPasskeyEnvelope({ ...enrolled.envelope, environmentId: '../production' })).toBeNull()
  })

  it('normalizes browser ceremony failures into stable UI reason codes', async () => {
    const cancelled: Pick<CredentialsContainer, 'create' | 'get'> = {
      create: async () => { throw new DOMException('cancelled', 'NotAllowedError') },
      get: async () => null,
    }
    await expect(enrollWebDshPasskeyProfile('staging', labels, {
      credentials: cancelled, crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })).rejects.toThrow('WEB_DSH_PASSKEY_CANCELLED')

    const insecure: Pick<CredentialsContainer, 'create' | 'get'> = {
      create: async () => { throw new DOMException('insecure origin', 'SecurityError') },
      get: async () => null,
    }
    await expect(enrollWebDshPasskeyProfile('staging', labels, {
      credentials: insecure, crypto: webcrypto as unknown as Crypto, randomUuid: () => profileId,
    })).rejects.toThrow('WEB_DSH_PASSKEY_SECURITY_ERROR')
  })
})
