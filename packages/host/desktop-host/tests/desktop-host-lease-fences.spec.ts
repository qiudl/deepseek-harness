import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DesktopHost, ProfileRegistry } from '../src/index.ts'

const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lease-fences-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  let now = 1_000
  const clock = { now: () => now }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock })
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, viewLeaseTtlMs: 100,
    ensureProfileWorker: async () => undefined })
  const local = await host.bootstrapLocalProfile({ keyHandle: 'keychain:local', unlockMaterial, ownerId: 'one' })
  const opened = await host.openLocalProfile({ profileId: local.profileId, ownerId: 'one' })
  return { host, registry, local, opened, clock, advance: () => { now += 101 } }
}

describe('Desktop Host lease fences', () => {
  it('validates owner and generation, expires leases, and fences old generations after reopening', async () => {
    const { host, local, opened, advance } = await fixture()
    const lease = { ...opened, ownerId: 'one' }
    expect(host.validateViewLease(lease)).toBe(local.profileId)
    expect(() => host.validateViewLease({ ...lease, ownerId: 'other' })).toThrow(/stale/)
    expect(() => host.validateViewLease({ ...lease, leaseGeneration: opened.leaseGeneration + 1 })).toThrow(/stale/)
    advance()
    expect(() => host.validateViewLease(lease)).toThrow(/stale/)
    const next = await host.openLocalProfile({ profileId: local.profileId, ownerId: 'one' })
    expect(next.viewLeaseId).not.toBe(opened.viewLeaseId)
    expect(next.leaseGeneration).toBeGreaterThan(opened.leaseGeneration)
    expect(host.validateViewLease({ ...next, ownerId: 'one' })).toBe(local.profileId)
    host.closeViewLease(next.viewLeaseId)
    expect(() => host.validateViewLease({ ...next, ownerId: 'one' })).toThrow(/stale/)
  })

  it('rejects stale process and lease generations without closing the valid lease', async () => {
    const { host, local, opened } = await fixture()
    const lease = { ...opened, ownerId: 'one' }
    expect(() => { host.closeOwnedViewLease({ ...lease, runtimeGeneration: 4 }) }).toThrow(/stale/)
    expect(() => { host.closeOwnedViewLease({ ...lease, leaseGeneration: opened.leaseGeneration + 1 }) }).toThrow(/stale/)
    expect(() => { host.closeOwnedViewLease({ ...lease, ownerId: 'other' }) }).toThrow(/profile_mismatch/)
    expect(host.validateViewLease(lease)).toBe(local.profileId)
    host.closeOwnedViewLease(lease)
    expect(() => host.validateViewLease(lease)).toThrow(/stale/)
    expect(() => { host.closeOwnedViewLease(lease) }).not.toThrow()
  })

  it('revokes only the selected Profile and leaves another Profile usable', async () => {
    const { host, local, opened } = await fixture()
    const other = await host.bootstrapLocalProfile({ keyHandle: 'keychain:other', unlockMaterial, ownerId: 'two' })
    const otherLease = await host.openLocalProfile({ profileId: other.profileId, ownerId: 'two' })
    host.revokeProfile(local.profileId)
    expect(() => host.validateViewLease({ ...opened, ownerId: 'one' })).toThrow(/stale/)
    expect(host.validateViewLease({ ...otherLease, ownerId: 'two' })).toBe(other.profileId)
    host.revokeOwner('one')
    expect(host.validateViewLease({ ...otherLease, ownerId: 'two' })).toBe(other.profileId)
    host.revokeOwner('two')
    expect(() => host.validateViewLease({ ...otherLease, ownerId: 'two' })).toThrow(/stale/)
    await expect(host.openLocalProfile({ profileId: other.profileId, ownerId: 'two' })).rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('does not activate without a worker adapter and rejects stale runtime capabilities', async () => {
    const { host, opened } = await fixture()
    await expect(host.activateView({ ...opened, ownerId: 'one', runtimeGeneration: 4 })).rejects.toMatchObject({ code: 'stale' })
    await expect(host.activateView({ ...opened, ownerId: 'one' })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid runtime generation %s', async (runtimeGeneration) => {
    const { registry, clock } = await fixture()
    expect(() => new DesktopHost({ registry, clock, runtimeGeneration })).toThrow(/invalid_input/)
  })

  it('requires worker readiness on local restore and does not unlock on failure', async () => {
    const { registry, clock, local } = await fixture()
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5 })
    const input = { ...local, keyHandle: 'keychain:local', unlockMaterial, ownerId: 'new' }
    await expect(host.restoreLocalProfile(input)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(host.restoreLocalProfile({ ...input, bindingGeneration: local.bindingGeneration + 1 })).rejects.toMatchObject({ code: 'stale' })
    await expect(host.openLocalProfile(input)).rejects.toMatchObject({ code: 'profile_locked' })
    await expect(host.bootstrapLocalProfile(input)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each([
    { origin: 'https://example.com', generation: 1 },
    { origin: 'http://127.0.0.1:65536', generation: 1 },
    { origin: 'http://127.0.0.1:1234', generation: 0 },
  ])('rejects invalid worker activation result %j without consuming the capability', async (result) => {
    const { registry, clock, local } = await fixture()
    let valid = false
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
      activateProfileView: async () => ({ ...(valid ? { origin: 'http://127.0.0.1:1234', generation: 1 } : result),
        bootstrapCookie: { name: 'test-cookie', value: 'test-value' } }),
    })
    await host.restoreLocalProfile({ ...local, keyHandle: 'keychain:local', unlockMaterial, ownerId: 'one' })
    const opened = await host.openLocalProfile({ profileId: local.profileId, ownerId: 'one' })
    const capability = { ...opened, ownerId: 'one' }
    await expect(host.activateView(capability)).rejects.toMatchObject({ code: 'unavailable' })
    valid = true
    await expect(host.activateView(capability)).resolves.toMatchObject({ origin: 'http://127.0.0.1:1234' })
    await expect(host.activateView(capability)).rejects.toMatchObject({ code: 'stale' })
  })

  it('rejects invalid account proofs and restoration selectors without unlocking', async () => {
    const { registry, clock, local } = await fixture()
    const account = { issuer: 'https://accounts.example', subject: 'one', keyHandle: 'keychain:account', unlockMaterial,
      authorityEnvironmentId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181', accountBindingHandle: 'one', authorityBindingVersion: 1 }
    const profile = await registry.registerAccount(account)
    const noVerifier = new DesktopHost({ registry, clock, runtimeGeneration: 5 })
    await expect(noVerifier.ensureAccountProfile({ ...account, accountAccessToken: 'invalid', ownerId: 'one' }))
      .rejects.toMatchObject({ code: 'unavailable' })
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
      verifyAccountAccessToken: () => { throw new Error('invalid signature') },
    })
    await expect(host.ensureAccountProfile({ ...account, accountAccessToken: 'invalid', ownerId: 'one' }))
      .rejects.toMatchObject({ code: 'unauthorized' })
    const restore = { ...account, profileId: profile.profileId, bindingGeneration: profile.bindingGeneration, ownerId: 'one' }
    await expect(host.restoreProfile({ ...restore, profileId: local.profileId })).rejects.toMatchObject({ code: 'unauthorized' })
    registry.rollbackRegistration(local.profileId)
    await expect(host.restoreProfile({ ...restore, profileId: local.profileId })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(host.restoreProfile({ ...restore, bindingGeneration: profile.bindingGeneration + 1 }))
      .rejects.toMatchObject({ code: 'stale' })
    await expect(host.restoreProfile({ ...restore, keyHandle: 'wrong' })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(host.restoreProfile(restore)).rejects.toMatchObject({ code: 'unavailable' })
    expect(() => host.authorizeMigrationProfileSelector({ ...local, ownerId: 'one' })).toThrow(/unauthorized/)
    expect(host.getProfileStatus({ ...account, ownerId: 'one' })).toEqual({ state: 'locked' })
  })

  it('rejects a concurrent activation while allowing the first activation to finish', async () => {
    const { registry, clock, local } = await fixture()
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    onTestFinished(() => { finish() })
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
      activateProfileView: async () => {
        await waiting
        return { origin: 'http://127.0.0.1:1234', generation: 1, bootstrapCookie: { name: 'test-cookie', value: 'test-value' } }
      },
    })
    await host.restoreLocalProfile({ ...local, keyHandle: 'keychain:local', unlockMaterial, ownerId: 'one' })
    const opened = await host.openLocalProfile({ profileId: local.profileId, ownerId: 'one' })
    const capability = { ...opened, ownerId: 'one' }
    const first = host.activateView(capability)
    try {
      await expect(host.activateView(capability)).rejects.toMatchObject({ code: 'busy' })
    } finally { finish() }
    await expect(first).resolves.toMatchObject({ activationGeneration: 1 })
  })
})
