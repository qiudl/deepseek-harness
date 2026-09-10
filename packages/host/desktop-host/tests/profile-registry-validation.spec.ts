import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ProfileRegistry, personIndex } from '../src/index.ts'

const key = Buffer.alloc(32, 7)
const clock = { now: () => 1000 }
const base = { issuer: 'https://accounts.example', subject: 'person', keyHandle: 'keychain:one',
  unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
const binding = { authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
  accountBindingHandle: 'binding:one', authorityBindingVersion: 1 }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-registry-validation-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const options = { root, deviceIndexKey: key, clock }
  return { root, path: join(root, 'profiles.json'), options, registry: new ProfileRegistry(options) }
}

describe('registry authority validation', () => {
  it.each(['', 'x'.repeat(513)])('rejects invalid subject length %s', (subject) => {
    expect(() => personIndex(key, { ...base, subject })).toThrow(/invalid_input/)
  })
  it.each(['not-url', 'http://accounts.example', 'https://user@accounts.example',
    'https://:password@accounts.example', 'https://accounts.example?q=1',
    'https://accounts.example#fragment', 'https://accounts.example/path'])('rejects issuer %s', (issuer) => {
    expect(() => personIndex(key, { ...base, issuer })).toThrow(/invalid_input/)
  })
  it('rejects invalid installation keys', () => {
    const { options } = fixture()
    expect(() => personIndex(Buffer.alloc(31), base)).toThrow(/invalid_input/)
    expect(() => new ProfileRegistry({ ...options, deviceIndexKey: Buffer.alloc(31) })).toThrow(/invalid_input/)
  })
  it.each([
    { keyHandle: '' }, { keyHandle: 'x'.repeat(513) }, { keyHandle: 'key\u0000' },
    { unlockMaterial: '' }, { unlockMaterial: 'A'.repeat(42) + 'B' },
    { authorityEnvironmentId: binding.authorityEnvironmentId },
    { accountBindingHandle: binding.accountBindingHandle }, { authorityBindingVersion: 1 },
    { ...binding, authorityEnvironmentId: 'invalid' },
    { ...binding, authorityBindingVersion: 0 }, { ...binding, authorityBindingVersion: 1.5 },
  ])('rejects invalid registration without changing durable data: %j', async (invalid) => {
    const { registry, path } = fixture()
    await registry.registerAccount(base)
    const before = readFileSync(path, 'utf8')
    await expect(registry.registerAccount({ ...base, ...invalid })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it.each([null, [], 1, { version: 3, profiles: null }, { version: 4, profiles: [] },
    { version: 3, profiles: [], extra: true }, { profiles: [], version: 3 }])('rejects malformed container %j', (value) => {
    const { options, path } = fixture()
    const content = JSON.stringify(value)
    writeFileSync(path, content, { mode: 0o600 })
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it.each([
    ['profileId', 1], ['profileId', 'invalid'], ['personIndex', 1], ['personIndex', 'invalid'],
    ['keyHandle', 1], ['unlockVerifier', 1], ['unlockVerifier', 'invalid'],
    ['bindingGeneration', -1], ['bindingGeneration', 1.5], ['createdAt', -1], ['createdAt', 1.5],
    ['kind', 'unknown'], ['accountBindings', {}], ['accountBindings', [null]],
    ['accountBindings', [[]]], ['accountBindings', [{ authorityEnvironmentId: 'invalid', handle: 'one', authorityBindingVersion: 1 }]],
    ['accountBindings', [{ authorityEnvironmentId: binding.authorityEnvironmentId, handle: 1, authorityBindingVersion: 1 }]],
    ['accountBindings', [{ authorityEnvironmentId: binding.authorityEnvironmentId, handle: 'one', authorityBindingVersion: 0 }]],
  ])('rejects invalid stored %s = %j', async (field, value) => {
    const { registry, options, path } = fixture()
    const profile = await registry.registerAccount(base)
    const content = JSON.stringify({ version: 3, profiles: [{ ...profile, [field]: value }] })
    writeFileSync(path, content)
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it.each([null, [], 1])('rejects malformed Profile %j', (profile) => {
    const { options, path } = fixture()
    writeFileSync(path, JSON.stringify({ version: 3, profiles: [profile] }), { mode: 0o600 })
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
  })

  it('rejects broken JSON and duplicate Profile ids, indexes, or cross-Profile bindings', async () => {
    const { registry, options, path } = fixture()
    const first = await registry.registerAccount({ ...base, ...binding })
    const second = await registry.registerAccount({ ...base, subject: 'two', keyHandle: 'keychain:two' })
    for (const duplicate of [{ ...second, profileId: first.profileId },
      { ...second, personIndex: first.personIndex }, { ...second, accountBindings: first.accountBindings }]) {
      writeFileSync(path, JSON.stringify({ version: 3, profiles: [first, duplicate] }))
      expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
    }
    writeFileSync(path, '{')
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
  })

  it.each([false, true])('upgrades a legacy account and persists its first verifier (bound=%s)', async (bound) => {
    const { registry, options, path } = fixture()
    const original = await registry.registerAccount({ ...base, ...(bound ? binding : {}) })
    const neighbor = await registry.createLocalAnonymous({ ...base, keyHandle: 'keychain:neighbor' })
    const legacy = [original, neighbor].map(({ unlockVerifier: _verifier, accountBindings, ...rest }) => ({
      profileId: rest.profileId, kind: rest.kind, personIndex: rest.personIndex, keyHandle: rest.keyHandle,
      ...(accountBindings ? {
        accountBindings: accountBindings.map(({ authorityEnvironmentId, handle }) => ({ authorityEnvironmentId, handle })),
      } : {}),
      bindingGeneration: rest.bindingGeneration, createdAt: rest.createdAt,
    }))
    writeFileSync(path, JSON.stringify({ version: 2, profiles: legacy }))
    const loaded = new ProfileRegistry(options)
    const old = loaded.resolveProfile(original.profileId)!
    expect(old.unlockVerifier).toBeNull()
    expect(() => { loaded.verifyUnlock(old, base.keyHandle, base.unlockMaterial) }).toThrow(/unauthorized/)
    await expect(loaded.createLocalAnonymous({ ...base, keyHandle: 'keychain:neighbor' })).rejects.toMatchObject({ code: 'unauthorized' })
    const updated = await loaded.registerAccount({ ...base, ...(bound ? binding : {}) })
    expect(updated.bindingGeneration).toBe(original.bindingGeneration + 1)
    expect(updated.unlockVerifier).not.toBeNull()
    const reopened = new ProfileRegistry(options)
    expect(reopened.resolveProfile(updated.profileId)).toEqual(updated)
    expect(reopened.resolveProfile(neighbor.profileId)?.unlockVerifier).toBeNull()
  })

  it('reports only currently key-unlocked Profiles and rejects stale rollback requests', async () => {
    const { registry, options } = fixture()
    const first = await registry.registerAccount(base)
    const second = await registry.createLocalAnonymous({ ...base, keyHandle: 'keychain:two' })
    expect(registry.isUnlocked(first)).toBe(false)
    expect(registry.listUnlocked()).toEqual([])
    const unlocked = new ProfileRegistry({ ...options, keyHandleUnlocked: handle => handle === first.keyHandle })
    expect(unlocked.listUnlocked()).toEqual([first])
    await expect(registry.bindAccount(first.profileId, base)).rejects.toMatchObject({ code: 'conflict' })
    expect(() => { registry.rollbackUpdate(first, second) }).toThrow(/stale/)
    registry.rollbackRegistration(first.profileId)
    expect(() => { registry.rollbackRegistration(first.profileId) }).toThrow(/stale/)
    expect(() => { registry.rollbackUpdate(first, first) }).toThrow(/stale/)
    await expect(registry.bindAccount(first.profileId, base)).rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(registry.resolveProfile(second.profileId)).toEqual(second)
  })

  it('rejects incorrect keys and unlock material without modifying the existing Profile', async () => {
    const { registry, path } = fixture()
    const profile = await registry.registerAccount(base)
    await registry.createLocalAnonymous({ ...base, keyHandle: 'keychain:local' })
    const before = readFileSync(path, 'utf8')
    await expect(registry.registerAccount({ ...base, keyHandle: 'wrong' })).rejects.toMatchObject({ code: 'profile_mismatch' })
    const wrong = Buffer.alloc(32, 8).toString('base64url')
    await expect(registry.registerAccount({ ...base, unlockMaterial: wrong })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(registry.createLocalAnonymous({ ...base, keyHandle: 'keychain:local', unlockMaterial: wrong }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    expect(() => { registry.verifyUnlock(profile, 'wrong', base.unlockMaterial) }).toThrow(/unauthorized/)
    expect(() => registry.resolveBinding('invalid', 'one', 1)).toThrow(/invalid_input/)
    for (const version of [0, 1.5]) {
      expect(() => registry.resolveBinding(binding.authorityEnvironmentId, 'one', version)).toThrow(/invalid_input/)
    }
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('does not reinterpret a local Profile with an account-shaped index as an account', async () => {
    const { registry, options, path } = fixture()
    const local = await registry.createLocalAnonymous(base)
    writeFileSync(path, JSON.stringify({ version: 3, profiles: [{ ...local, personIndex: personIndex(key, base) }] }))
    const loaded = new ProfileRegistry(options)
    await expect(loaded.registerAccount(base)).rejects.toMatchObject({ code: 'profile_mismatch' })
    await expect(loaded.resolveAccount(base)).resolves.toBeNull()
  })

  it('rejects account binding fields on a local Profile through the exact stored key schema', async () => {
    const { registry, options, path } = fixture()
    const local = await registry.createLocalAnonymous(base)
    const content = JSON.stringify({ version: 3, profiles: [{ ...local, accountBindings: [] }] })
    writeFileSync(path, content)
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('can add a binding after restoring a prior account row with no optional bindings field', async () => {
    const { registry, options } = fixture()
    const original = await registry.registerAccount(base)
    const { accountBindings: _bindings, ...previous } = original
    const bound = await registry.registerAccount({ ...base, ...binding })
    registry.rollbackUpdate(bound, previous)
    expect(registry.resolveProfile(original.profileId)).toEqual(previous)
    const rebound = await registry.registerAccount({ ...base, ...binding })
    expect(rebound.accountBindings).toEqual([{
      authorityEnvironmentId: binding.authorityEnvironmentId, handle: binding.accountBindingHandle, authorityBindingVersion: 1,
    }])
    expect(new ProfileRegistry(options).resolveProfile(original.profileId)).toEqual(rebound)
  })

  it.skipIf(process.platform === 'win32')('rejects a non-private registry directory (POSIX permissions)', () => {
    const { root, options } = fixture()
    chmodSync(root, 0o755)
    expect(() => new ProfileRegistry(options)).toThrow(/unavailable/)
  })
})
