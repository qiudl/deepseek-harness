import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ProfileRegistry } from '../src/profile-registry.ts'

const environment = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181'
const account = { issuer: 'https://accounts.example', subject: 'person', keyHandle: 'keychain:one',
  unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), authorityEnvironmentId: environment }
const email = { ...account, accountBindingHandle: 'email-binding', authorityBindingVersion: 1,
  authorityBindingScope: 'a'.repeat(64) }
const feishu = { ...account, accountBindingHandle: 'feishu-binding', authorityBindingVersion: 5,
  authorityBindingScope: 'b'.repeat(64) }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-binding-scope-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const options = { root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } }
  return { options, path: join(root, 'profiles.json'), registry: new ProfileRegistry(options) }
}

describe('independent Slark login bindings for one Account Profile', () => {
  it('keeps the original Profile through 5 → 1 → 5 and a registry restart', async () => {
    const { registry, options, path } = fixture()
    const { authorityBindingScope: _scope, ...legacy } = feishu
    const original = await registry.registerAccount(legacy)
    const before = readFileSync(path)
    const mode = statSync(path).mode
    const loaded = new ProfileRegistry(options)
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mode).toBe(mode)
    const switched = await loaded.registerAccount(email)
    expect(switched.profileId).toBe(original.profileId)
    expect(switched.keyHandle).toBe(original.keyHandle)
    expect(switched.unlockVerifier).toBe(original.unlockVerifier)
    expect(loaded.resolveBinding(environment, legacy.accountBindingHandle, 5)).toBeNull()
    const returned = await loaded.registerAccount(feishu)
    expect(returned.profileId).toBe(original.profileId)
    const restarted = new ProfileRegistry(options)
    expect(restarted.resolveBinding(environment, email.accountBindingHandle, 1)?.profileId).toBe(original.profileId)
    expect(restarted.resolveBinding(environment, feishu.accountBindingHandle, 5)?.profileId).toBe(original.profileId)
    const snapshot: unknown = JSON.parse(readFileSync(path, 'utf8'))
    expect(snapshot).toMatchObject({ version: 4 })
  })

  it('retains each scope high-water mark and retires replaced handles across other login switches', async () => {
    const { registry, options, path } = fixture()
    await registry.registerAccount(email)
    await registry.registerAccount({ ...email, accountBindingHandle: 'new-email', authorityBindingVersion: 2 })
    await registry.registerAccount(feishu)
    const restarted = new ProfileRegistry(options)
    const before = readFileSync(path)
    await expect(restarted.registerAccount(email)).rejects.toMatchObject({ code: 'stale' })
    await expect(restarted.registerAccount({ ...email, authorityBindingVersion: 2 })).rejects.toMatchObject({ code: 'conflict' })
    expect(restarted.resolveBinding(environment, email.accountBindingHandle, 1)).toBeNull()
    expect(readFileSync(path)).toEqual(before)
  })

  it('rejects an unscoped writer after a scope is established without changing the file', async () => {
    const { registry, path } = fixture()
    await registry.registerAccount(email)
    const before = readFileSync(path)
    const { authorityBindingScope: _scope, ...oldClient } = feishu
    await expect(registry.registerAccount(oldClient)).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(readFileSync(path)).toEqual(before)
  })

  it('does not let another scope claim an existing handle or bypass its legacy version', async () => {
    const { registry, path } = fixture()
    const { authorityBindingScope: _scope, ...legacy } = feishu
    await registry.registerAccount(legacy)
    const before = readFileSync(path)
    await expect(registry.registerAccount({ ...feishu, authorityBindingVersion: 4 })).rejects.toMatchObject({ code: 'stale' })
    expect(readFileSync(path)).toEqual(before)
    await registry.registerAccount(feishu)
    const scoped = readFileSync(path)
    await expect(registry.registerAccount({ ...feishu, authorityBindingScope: email.authorityBindingScope }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(readFileSync(path)).toEqual(scoped)
  })

  it('rejects malformed or unbound scopes before writing', async () => {
    const { registry, path } = fixture()
    await registry.registerAccount(email)
    const before = readFileSync(path)
    await expect(registry.registerAccount({ ...email, authorityBindingScope: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(registry.registerAccount({ ...account, authorityBindingScope: email.authorityBindingScope }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(readFileSync(path)).toEqual(before)
  })

  it('prevents one login from migrating another scope or a Profile shared by other bindings', async () => {
    const { registry, path } = fixture()
    const original = await registry.registerAccount(email)
    await expect(registry.registerAccount({ ...email, subject: 'migrated', authorityBindingVersion: 2,
      authorityBindingScope: feishu.authorityBindingScope })).rejects.toMatchObject({ code: 'profile_mismatch' })
    const migrated = await registry.registerAccount({ ...email, subject: 'migrated', authorityBindingVersion: 2 })
    expect(migrated.profileId).toBe(original.profileId)
    await registry.registerAccount({ ...feishu, subject: 'migrated' })
    const before = readFileSync(path)
    await expect(registry.registerAccount({ ...email, subject: 'another', authorityBindingVersion: 3 }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(readFileSync(path)).toEqual(before)
  })

  it('allows an older broker to renew a known handle without discarding its scope', async () => {
    const { registry, options } = fixture()
    const original = await registry.registerAccount(email)
    const { authorityBindingScope: _scope, ...unscoped } = email
    const renewed = await registry.registerAccount(unscoped)
    expect(renewed).toEqual(original)
    expect(new ProfileRegistry(options).resolveBinding(environment, email.accountBindingHandle, 1)).toEqual(original)
  })

  it('restores the original released registry when worker preparation fails', async () => {
    const { registry, options, path } = fixture()
    const { authorityBindingScope: _scope, ...legacy } = feishu
    const original = await registry.registerAccount(legacy)
    const before = readFileSync(path)
    const mode = statSync(path).mode
    await expect(registry.provisionAccount(email, async () => { throw new Error('worker failed') }))
      .rejects.toThrow('worker failed')
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mode).toBe(mode)
    expect(new ProfileRegistry(options).resolveProfile(original.profileId)).toEqual(original)
  })

  it.each([false, true])('keeps released v2 bytes on worker failure (storage hook=%s)', async (storageHook) => {
    const { registry, options, path } = fixture()
    const { authorityBindingScope: _scope, ...legacy } = feishu
    const { unlockVerifier: _verifier, accountBindings: _bindings, ...original } = await registry.registerAccount(legacy)
    writeFileSync(path, JSON.stringify({ version: 2, profiles: [{
      profileId: original.profileId, kind: original.kind, personIndex: original.personIndex, keyHandle: original.keyHandle,
      accountBindings: [{
        authorityEnvironmentId: environment, handle: legacy.accountBindingHandle,
      }], bindingGeneration: original.bindingGeneration, createdAt: original.createdAt,
    }] }))
    const before = readFileSync(path)
    const mode = statSync(path).mode
    const loaded = new ProfileRegistry({ ...options, ...(storageHook ? {
      loadSnapshot: () => { const snapshot: unknown = JSON.parse(readFileSync(path, 'utf8')); return snapshot },
      persistSnapshot: (_path: string, _root: string, snapshot: unknown) => { writeFileSync(path, JSON.stringify(snapshot)) },
    } : {}) })
    await expect(loaded.provisionAccount(email, async () => { throw new Error('worker failed') }))
      .rejects.toThrow('worker failed')
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).mode).toBe(mode)
  })

  it('retains another Profile written while the scoped worker fails', async () => {
    const { registry, options } = fixture()
    const original = await registry.registerAccount(feishu)
    let neighbor: typeof original | undefined
    await expect(registry.provisionAccount(email, async () => {
      neighbor = await registry.registerAccount({ ...account, subject: 'neighbor', keyHandle: 'keychain:neighbor',
        accountBindingHandle: 'neighbor-binding', authorityBindingVersion: 1 })
      throw new Error('worker failed')
    })).rejects.toThrow('worker failed')
    const restarted = new ProfileRegistry(options)
    expect(restarted.resolveBinding(environment, feishu.accountBindingHandle, 5)).toEqual(original)
    expect(restarted.resolveProfile(neighbor!.profileId)).toEqual(neighbor)
  })
})
