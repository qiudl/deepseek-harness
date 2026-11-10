/** Current Account cancellation owns the awaited original collaboration request. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'req0006-account-lifetime-'))
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  const clock = { now: () => 1000 }, registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock,
    ...registryFileFixture() })
  const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'original-binding', authorityBindingVersion: 1,
    issuer: 'https://account.test', subject: randomUUID(), keyHandle: 'original-key', unlockMaterial: Buffer.alloc(32,
      9).toString('base64url') }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 1, ensureProfileWorker: async () => {},
    verifyAccountAccessToken: () => ({ issuer: account.issuer, subject: account.subject }) })
  const ownerId = randomUUID()
  const granted = await host.ensureAccountProfile({ ...account, ownerId, accountAccessToken: 'controlled-token' })
  return { host, registry, account, ownerId, granted }
}

it('aborts the original awaited request on owner revoke and keeps another owner live', async () => {
  const f = await fixture(), second = randomUUID()
  await f.host.ensureAccountProfile({ ...f.account, ownerId: second, accountAccessToken: 'controlled-token' })
  const proof = { ...f.account, ownerId: f.ownerId }, own = new AbortController()
  await expect(f.host.withCollaborationAccountRequest(proof, own.signal, async (_profile, signal) => {
    await f.host.withCollaborationAccountRequest({ ...proof, ownerId: second }, own.signal, async (_otherProfile, otherSignal) => {
      await Promise.resolve()
      f.host.revokeOwner(f.ownerId)
      expect(signal.aborted).toBe(true)
      expect(otherSignal.aborted).toBe(false)
    })
  })).rejects.toMatchObject({ code: 'unauthorized' })
})

it.each(['registry_rotation', 'profile_revoke',
  'original_abort'] as const)('cancels the live request at %s and never revives it on a later grant', async (boundary) => {
  const f = await fixture(), own = new AbortController(), proof = { ...f.account, ownerId: f.ownerId }
  await expect(f.host.withCollaborationAccountRequest(proof, own.signal, async (_profile, signal) => {
    if (boundary === 'registry_rotation') {
      await f.registry.registerAccount({ ...f.account, authorityBindingVersion: 2 })
    } else if (boundary === 'profile_revoke') f.host.revokeProfile(f.granted.profileId)
    else own.abort(Error('original-cancelled'))
    expect(signal.aborted).toBe(true)
    await f.host.ensureAccountProfile({ ...f.account, authorityBindingVersion: boundary === 'registry_rotation' ? 2 : 1,
      ownerId: f.ownerId, accountAccessToken: 'controlled-token' })
    expect(signal.aborted).toBe(true)
  })).rejects.toThrow()
})

it('removes settled request ownership and rejects an unverified current Account before invoking the worker', async () => {
  const f = await fixture(), proof = { ...f.account, ownerId: f.ownerId }, own = new AbortController()
  const old = await f.host.withCollaborationAccountRequest(proof, own.signal, async (_profile, signal) => signal)
  f.host.revokeOwner(f.ownerId)
  expect(old.aborted).toBe(false)
  let calls = 0
  await expect(f.host.withCollaborationAccountRequest(proof, own.signal, async () => { calls++; return null }))
    .rejects.toMatchObject({ code: 'unauthorized' })
  expect(calls).toBe(0)
})

it('publishes a registry replacement before notifying cancellation and retains a newly attached generation observer', async () => {
  const f = await fixture(), original = f.registry.profileChangeSignal(f.granted.profileId)
  let observed: string | undefined, next: AbortSignal | undefined
  original.addEventListener('abort', () => {
    observed = f.registry.resolveBinding(f.account.authorityEnvironmentId, f.account.accountBindingHandle, 2)?.profileId
    next = f.registry.profileChangeSignal(f.granted.profileId)
  }, { once: true })
  await f.registry.registerAccount({ ...f.account, authorityBindingVersion: 2 })
  expect(observed).toBe(f.granted.profileId)
  expect(next?.aborted).toBe(false)
  await f.registry.registerAccount({ ...f.account, authorityBindingVersion: 3 })
  expect(next?.aborted).toBe(true)
})
