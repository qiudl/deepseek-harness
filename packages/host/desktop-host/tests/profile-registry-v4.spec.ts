import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ProfileRegistry } from '../src/profile-registry.ts'

const environment = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181'
const account = {
  issuer: 'https://accounts.example', subject: 'person', keyHandle: 'keychain:one',
  unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), authorityEnvironmentId: environment,
}
const email = { ...account, accountBindingHandle: 'email-binding', authorityBindingVersion: 1,
  authorityBindingScope: 'a'.repeat(64) }
const feishu = { ...account, accountBindingHandle: 'feishu-binding', authorityBindingVersion: 5,
  authorityBindingScope: 'b'.repeat(64) }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-registry-v4-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const options = { root, deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } }
  return { options, path: join(root, 'profiles.json'), registry: new ProfileRegistry(options) }
}

describe('scoped v4 Profile registry', () => {
  it('opens a released v4 snapshot without rewriting bytes and resolves both login bindings', async () => {
    const { registry, options, path } = fixture()
    const original = await registry.registerAccount(email)
    await registry.registerAccount(feishu)
    const before = readFileSync(path)
    const beforeStat = statSync(path)
    expect(JSON.parse(before.toString('utf8'))).toMatchObject({ version: 4 })
    const reopened = new ProfileRegistry(options)
    expect(readFileSync(path)).toEqual(before)
    expect(statSync(path).ino).toBe(beforeStat.ino)
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs)
    expect(reopened.resolveBinding(environment, email.accountBindingHandle, 1)?.profileId).toBe(original.profileId)
    expect(reopened.resolveBinding(environment, feishu.accountBindingHandle, 5)?.profileId).toBe(original.profileId)
  })

  it('preserves a known scope for an older broker and rejects an unknown unscoped handle', async () => {
    const { registry, options, path } = fixture()
    const original = await registry.registerAccount(email)
    const { authorityBindingScope: _scope, ...known } = email
    expect(await registry.registerAccount(known)).toEqual(original)
    expect(new ProfileRegistry(options).resolveBinding(environment, known.accountBindingHandle, 1)).toEqual(original)
    await registry.registerAccount({ ...known, authorityBindingVersion: 2 })
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { version: number; profiles: Array<{ accountBindings: Array<{ authorityBindingScope?: string }> }> }
    expect(stored.version).toBe(4)
    expect(stored.profiles[0]?.accountBindings[0]?.authorityBindingScope).toBe(email.authorityBindingScope)
    const before = readFileSync(path)
    const { authorityBindingScope: _otherScope, ...unknown } = feishu
    await expect(registry.registerAccount(unknown)).rejects.toMatchObject({ code: 'upgrade_required' })
    expect(readFileSync(path)).toEqual(before)
  })

  it('keeps version counters independent by scope and rejects a retired handle', async () => {
    const { registry, options, path } = fixture()
    const original = await registry.registerAccount(email)
    await registry.registerAccount({ ...email, accountBindingHandle: 'email-rebound', authorityBindingVersion: 2 })
    await registry.registerAccount(feishu)
    const reopened = new ProfileRegistry(options)
    const before = readFileSync(path)
    expect(reopened.resolveBinding(environment, email.accountBindingHandle, 1)).toBeNull()
    expect(reopened.resolveBinding(environment, 'email-rebound', 2)?.profileId).toBe(original.profileId)
    expect(reopened.resolveBinding(environment, feishu.accountBindingHandle, 5)?.profileId).toBe(original.profileId)
    await expect(reopened.registerAccount(email)).rejects.toMatchObject({ code: 'stale' })
    await expect(reopened.registerAccount({ ...email, authorityBindingVersion: 2 }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(readFileSync(path)).toEqual(before)
  })

  it('rejects malformed scope, v3 scope injection, duplicate scoped bindings and cross-account handle reuse', async () => {
    const { registry, options, path } = fixture()
    await registry.registerAccount(email)
    const before = readFileSync(path)
    await expect(registry.registerAccount({ ...email, authorityBindingScope: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(registry.registerAccount({ ...email, subject: 'other', authorityBindingVersion: 2 }))
      .rejects.toMatchObject({ code: 'profile_mismatch' })
    expect(readFileSync(path)).toEqual(before)
    const snapshot = JSON.parse(before.toString('utf8')) as { version: number; profiles: Array<{ accountBindings: Array<Record<string, unknown>> }> }
    snapshot.version = 3
    writeFileSync(path, `${JSON.stringify(snapshot)}\n`)
    const injected = readFileSync(path)
    expect(() => new ProfileRegistry(options)).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(readFileSync(path)).toEqual(injected)
    snapshot.version = 4
    snapshot.profiles[0]!.accountBindings.push({ ...snapshot.profiles[0]!.accountBindings[0], handle: 'other-handle' })
    writeFileSync(path, `${JSON.stringify(snapshot)}\n`)
    const duplicate = readFileSync(path)
    expect(() => new ProfileRegistry(options)).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(readFileSync(path)).toEqual(duplicate)
  })
})
