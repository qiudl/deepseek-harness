import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DesktopHost, ProfileRegistry } from '../src/index.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

const environmentId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181'
const personProfileId = '11111111-1111-4111-8111-111111111111'
const subject = '22222222-2222-4222-8222-222222222222'
const issuer = 'https://accounts.dsh.colorbuyai.com'
const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
const expected = {
  slarkUserId: 'slark-user', environmentId, profileId: personProfileId,
  deviceId: '33333333-3333-4333-8333-333333333333',
  deviceKeyThumbprint: Buffer.alloc(32, 4).toString('base64url'), loginEpoch: 2, bindingEpoch: 3,
}
const bindingScope = 'a'.repeat(64)
const input = {
  issuer, subject, authorityEnvironmentId: environmentId,
  accountBindingHandle: `slark:${personProfileId}`, authorityBindingVersion: 3,
  accountAccessToken: 'slark-token', keyHandle: 'keychain:slark', unlockMaterial,
  ownerId: 'connection-1', expected,
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-slark-profile-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1_000 }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock,
    ...registryFileFixture() })
  let workerStarts = 0
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
    verifySlarkAccountAccessToken: (token, context) => {
      if (token !== 'slark-token' || context !== expected) throw Error('invalid Slark authority')
      return { issuer, subject, bindingScope }
    },
    ensureProfileWorker: async () => { workerStarts += 1 },
  })
  return { host, registry, workerStarts: () => workerStarts }
}

describe('Slark Account Profile admission', () => {
  it('opens a distinct new Profile only after scoped token and local key proof', async () => {
    const { host, registry, workerStarts } = fixture()
    const ready = await host.ensureSlarkAccountProfile(input)
    expect(ready.profileId).not.toBe(personProfileId)
    expect(registry.resolveBinding(environmentId, input.accountBindingHandle, 3)?.profileId).toBe(ready.profileId)
    expect(registry.resolveProfile(ready.profileId)?.accountBindings?.[0]?.authorityBindingScope).toBe(bindingScope)
    expect(workerStarts()).toBe(1)
    const repeated = await host.ensureSlarkAccountProfile(input)
    expect(repeated.profileId).toBe(ready.profileId)
    await expect(host.ensureSlarkAccountProfile({ ...input, expected: { ...expected, slarkUserId: 'other' } }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    await expect(host.ensureSlarkAccountProfile({ ...input, unlockMaterial: Buffer.alloc(32, 8).toString('base64url') }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    expect(workerStarts()).toBe(2)
  })

  it('does not attach a shared legacy Account Profile or overwrite its bindings', async () => {
    const { host, registry, workerStarts } = fixture()
    const old = await registry.registerAccount({ issuer, subject, keyHandle: input.keyHandle,
      unlockMaterial, authorityEnvironmentId: environmentId,
      accountBindingHandle: 'legacy:other-user', authorityBindingVersion: 1 })
    await expect(host.ensureSlarkAccountProfile(input)).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(registry.resolveProfile(old.profileId)?.accountBindings?.[0]?.handle).toBe('legacy:other-user')
    expect(workerStarts()).toBe(0)
  })

  it('does not attach an unbound legacy Account Profile with the same subject', async () => {
    const { host, registry, workerStarts } = fixture()
    const old = await registry.registerAccount({ issuer, subject, keyHandle: input.keyHandle, unlockMaterial })
    const scoped = await host.ensureSlarkAccountProfile({ ...input, keyHandle: 'keychain:slark-scoped' })
    expect(scoped.profileId).not.toBe(old.profileId)
    expect(registry.resolveProfile(old.profileId)?.accountBindings).toEqual([])
    expect(registry.resolveProfile(old.profileId)?.keyHandle).toBe(input.keyHandle)
    expect(registry.resolveProfile(scoped.profileId)?.accountBindings?.[0]?.authorityBindingScope).toBe(bindingScope)
    expect(workerStarts()).toBe(1)
  })

  it('keeps a bound old Account Profile separate from its Slark scope', async () => {
    const { host, registry } = fixture()
    const old = await registry.registerAccount({ issuer, subject, keyHandle: input.keyHandle,
      unlockMaterial, authorityEnvironmentId: environmentId,
      accountBindingHandle: 'legacy:other-user', authorityBindingVersion: 1 })
    const scoped = await host.ensureSlarkAccountProfile({ ...input, keyHandle: 'keychain:slark-scoped' })
    expect(scoped.profileId).not.toBe(old.profileId)
    expect(registry.resolveProfile(old.profileId)?.accountBindings?.[0]?.handle).toBe('legacy:other-user')
    expect(registry.matchesAccountIdentity(registry.resolveProfile(scoped.profileId)!, { issuer, subject })).toBe(true)
    expect(registry.matchesAccountIdentity(registry.resolveProfile(scoped.profileId)!, { issuer, subject: 'someone-else' })).toBe(false)
  })

  it('requires a verified Slark grant and old Account key proof before import preview', async () => {
    const { host, registry } = fixture()
    const old = await registry.registerAccount({ issuer, subject, keyHandle: 'keychain:old', unlockMaterial })
    const preview = {
      authorityEnvironmentId: environmentId, accountBindingHandle: input.accountBindingHandle,
      authorityBindingVersion: input.authorityBindingVersion, ownerId: input.ownerId,
      issuer, subject, sourceIssuer: issuer, sourceSubject: subject,
      sourceKeyHandle: 'keychain:old', sourceUnlockMaterial: unlockMaterial,
    }
    expect(() => host.authorizeSlarkImportPreview(preview)).toThrow('unauthorized')
    const scoped = await host.ensureSlarkAccountProfile(input)
    expect(host.authorizeSlarkImportPreview(preview)).toEqual({
      sourceProfileId: old.profileId, targetProfileId: scoped.profileId,
    })
    expect(() => host.authorizeSlarkImportPreview({ ...preview, sourceUnlockMaterial: Buffer.alloc(32, 8).toString('base64url') }))
      .toThrow('unauthorized')
    expect(() => host.authorizeSlarkImportPreview({ ...preview, sourceKeyHandle: input.keyHandle }))
      .toThrow('profile_mismatch')
    expect(() => host.authorizeSlarkImportPreview({ ...preview, subject: 'wrong-person' }))
      .toThrow('profile_mismatch')
    expect(() => host.authorizeSlarkImportPreview({ ...preview, sourceSubject: 'wrong-old-person' }))
      .toThrow('profile_mismatch')
  })
})
