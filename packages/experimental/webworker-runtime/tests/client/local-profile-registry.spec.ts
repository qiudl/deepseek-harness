import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { enrollWebDshLocalProfile } from '../../src/client/passkey-profile.ts'
import {
  createWebDshLocalProfileRecord,
  IndexedDbWebDshLocalProfileRegistry,
  parseWebDshLocalProfileRecord,
} from '../../src/client/local-profile-registry.ts'

const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140'
const prf = Uint8Array.from({ length: 32 }, (_, index) => index + 1).buffer

class FakePublicKeyCredential {
  readonly rawId = Uint8Array.from({ length: 32 }, (_, index) => 255 - index).buffer
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

async function enrollment() {
  return await enrollWebDshLocalProfile(
    'staging',
    { relyingParty: 'DSH Web', profile: 'Local workspace' },
    'correct horse battery staple 2026',
    {
      credentials: {
        create: async () => new FakePublicKeyCredential() as unknown as Credential,
        get: async () => new FakePublicKeyCredential() as unknown as Credential,
      },
      crypto: webcrypto as unknown as Crypto,
      randomUuid: () => profileId,
      now: () => 1_800_000_000_000,
    },
  )
}

describe('Web-local profile registry record', () => {
  it('keeps standalone registry access read-only so creation cannot become half-committed', () => {
    expect('put' in IndexedDbWebDshLocalProfileRegistry.prototype).toBe(false)
  })

  it('creates a strict environment-owned record without storing the unwrapped key', async () => {
    const record = createWebDshLocalProfileRecord('My local workspace', await enrollment())
    expect(record).toMatchObject({
      version: 1,
      environmentId: 'staging',
      profileId,
      displayName: 'My local workspace',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    })
    expect(parseWebDshLocalProfileRecord(record)).toEqual(record)
    expect(JSON.stringify(record)).not.toContain('encryptionKey')
  })

  it('rejects wrapper mismatch, unknown fields, and ambiguous display names', async () => {
    const record = createWebDshLocalProfileRecord('My local workspace', await enrollment())
    expect(parseWebDshLocalProfileRecord({ ...record, accountId: 'forbidden' })).toBeNull()
    expect(parseWebDshLocalProfileRecord({
      ...record,
      recoveryEnvelope: { ...record.recoveryEnvelope, environmentId: 'production' },
    })).toBeNull()
    const another = await enrollment()
    expect(() => createWebDshLocalProfileRecord(' trailing ', another))
      .toThrow('WEB_DSH_PROFILE_RECORD_INVALID')
  })
})
