import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DesktopHost, ProfileRegistry } from '../src/index.ts'

const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')
const otherUnlockMaterial = Buffer.alloc(32, 8).toString('base64url')
const environmentId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181'
const preflightDigest = 'a'.repeat(64)

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-offline-recovery-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

async function account(registry: ProfileRegistry, input: {
  readonly subject: string
  readonly keyHandle: string
  readonly bindingHandle?: string
}) {
  return await registry.registerAccount({
    issuer: 'https://accounts.dsh.colorbuyai.com',
    subject: input.subject,
    keyHandle: input.keyHandle,
    unlockMaterial,
    ...(input.bindingHandle === undefined ? {} : {
      authorityEnvironmentId: environmentId,
      accountBindingHandle: input.bindingHandle,
      authorityBindingVersion: 1,
    }),
  })
}

describe('offline Account Profile recovery', () => {
  it('resolves an account Profile by a unique opaque key handle and fails closed on ambiguity', async () => {
    const registry = new ProfileRegistry({
      root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1_000 },
    })
    const original = await account(registry, { subject: 'original', keyHandle: 'keychain:original' })
    expect(registry.resolveUniqueAccountByKeyHandle('keychain:original')).toBe(original)
    expect(() => registry.resolveUniqueAccountByKeyHandle('keychain:missing'))
      .toThrow(expect.objectContaining({ code: 'profile_not_found' }))

    await account(registry, { subject: 'duplicate-a', keyHandle: 'keychain:duplicate' })
    await account(registry, { subject: 'duplicate-b', keyHandle: 'keychain:duplicate' })
    expect(() => registry.resolveUniqueAccountByKeyHandle('keychain:duplicate'))
      .toThrow(expect.objectContaining({ code: 'profile_ambiguous' }))
  })

  it('inspects without starting plugins, then grants only offline_local after proof and worker readiness', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, {
      subject: 'original', keyHandle: 'keychain:original', bindingHandle: 'binding:original',
    })
    let inspections = 0
    let workerStarts = 0
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async (profile, expected) => {
        inspections += 1
        expect(profile).toBe(original)
        expect(expected).toEqual({ runtimeGeneration: 5, schemaGeneration: 3 })
        return {
          state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
          sessionCount: 86, pluginCount: 6, preflightDigest,
        }
      },
      ensureRecoveredProfileWorker: async (profile, preflight) => {
        workerStarts += 1
        expect(profile).toBe(original)
        expect(preflight.preflightDigest).toBe(preflightDigest)
      },
    })

    const inspected = await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })
    expect(inspections).toBe(1)
    expect(workerStarts).toBe(0)
    expect(inspected).toEqual({ candidates: [expect.objectContaining({
      state: 'recoverable', profileKind: 'account', bindingCount: 1,
      persistenceGeneration: 11, sessionCount: 86, pluginCount: 6,
      compatibility: 'current', preflightDigest,
    })] })
    expect(JSON.stringify(inspected)).not.toContain(original.profileId)
    expect(JSON.stringify(inspected)).not.toContain('keychain:original')

    const candidate = inspected.candidates[0]!
    const recovered = await host.recoverOfflineAccountProfile({
      candidateId: candidate.candidateId, preflightDigest,
      keyHandle: 'keychain:original', unlockMaterial,
      operationId: randomUUID(), ownerId: 'connection-1',
    })
    expect(recovered).toMatchObject({
      state: 'offline_ready', profileId: original.profileId,
      accessScope: 'offline_local', persistenceGeneration: 11, runtimeGeneration: 5,
    })
    expect(workerStarts).toBe(1)

    await expect(host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connection-1',
    }))
      .resolves.toMatchObject({ profileId: original.profileId, accessScope: 'offline_local' })
    await expect(host.openProfile({
      authorityEnvironmentId: environmentId, accountBindingHandle: 'binding:original',
      authorityBindingVersion: 1, ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('does not grant or start a worker for a mismatched proof or stale preflight', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, {
      subject: 'original', keyHandle: 'keychain:original', bindingHandle: 'binding:original',
    })
    let workerStarts = 0
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
      ensureRecoveredProfileWorker: async () => { workerStarts += 1 },
    })
    const inspect = async () => (await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!

    const proofCandidate = await inspect()
    await expect(host.recoverOfflineAccountProfile({
      candidateId: proofCandidate.candidateId, preflightDigest,
      keyHandle: 'keychain:original', unlockMaterial: otherUnlockMaterial,
      operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'recovery_proof_mismatch' })

    const staleCandidate = await inspect()
    await registry.registerAccount({
      issuer: 'https://accounts.dsh.colorbuyai.com', subject: 'original',
      keyHandle: 'keychain:original', unlockMaterial,
      authorityEnvironmentId: environmentId, accountBindingHandle: 'binding:rotated',
      authorityBindingVersion: 2,
    })
    await expect(host.recoverOfflineAccountProfile({
      candidateId: staleCandidate.candidateId, preflightDigest,
      keyHandle: 'keychain:original', unlockMaterial,
      operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(workerStarts).toBe(0)
    await expect(host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connection-1',
    }))
      .rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('returns preflight stale when runtime inventory changes after confirmation is displayed', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    await account(registry, {
      subject: 'original', keyHandle: 'keychain:original', bindingHandle: 'binding:original',
    })
    let inspections = 0
    let workerStarts = 0
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest: (inspections += 1) === 1
          ? preflightDigest
          : 'b'.repeat(64),
      }),
      ensureRecoveredProfileWorker: async () => { workerStarts += 1 },
    })
    const candidate = (await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!
    await expect(host.recoverOfflineAccountProfile({
      candidateId: candidate.candidateId, preflightDigest,
      keyHandle: 'keychain:original', unlockMaterial,
      operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(workerStarts).toBe(0)
  })

  it('keeps connected and local grants out of the offline Account entry point', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, {
      subject: 'original', keyHandle: 'keychain:original', bindingHandle: 'binding:original',
    })
    const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined })
    await host.restoreProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration,
      authorityEnvironmentId: environmentId, accountBindingHandle: 'binding:original',
      authorityBindingVersion: 1, keyHandle: 'keychain:original', unlockMaterial,
      ownerId: 'connected-owner',
    })
    await expect(host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connected-owner',
    }))
      .rejects.toMatchObject({ code: 'profile_locked' })

    const local = await host.bootstrapLocalProfile({
      keyHandle: 'keychain:local', unlockMaterial, ownerId: 'local-owner',
    })
    await expect(host.openOfflineAccountProfile({
      profileId: local.profileId, bindingGeneration: local.bindingGeneration, ownerId: 'local-owner',
    }))
      .rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('serializes recovery per Profile, retries one operation idempotently, and revokes on disconnect', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, { subject: 'original', keyHandle: 'keychain:original' })
    let finishWorker!: () => void
    const workerReady = new Promise<void>((resolve) => { finishWorker = resolve })
    let workerStarts = 0
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
      ensureRecoveredProfileWorker: async () => { workerStarts += 1; await workerReady },
    })
    const candidate = (await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!
    const operationId = randomUUID()
    const input = {
      candidateId: candidate.candidateId, preflightDigest, keyHandle: 'keychain:original',
      unlockMaterial, operationId, ownerId: 'connection-1',
    }
    const first = host.recoverOfflineAccountProfile(input)
    const repeated = host.recoverOfflineAccountProfile(input)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(workerStarts).toBe(1)
    expect(host.getOfflineAccountRecoveryStatus({ operationId, ownerId: 'connection-1' }))
      .toEqual({ state: 'recovering' })
    await expect(host.recoverOfflineAccountProfile({ ...input, operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'recovery_in_progress' })

    finishWorker()
    const [firstResult, repeatedResult] = await Promise.all([first, repeated])
    expect(repeatedResult).toEqual(firstResult)
    expect(workerStarts).toBe(1)
    expect(host.getOfflineAccountRecoveryStatus({ operationId, ownerId: 'connection-1' }))
      .toEqual({ state: 'offline_ready' })

    host.revokeOwner('connection-1')
    expect(host.getOfflineAccountRecoveryStatus({ operationId, ownerId: 'connection-1' }))
      .toEqual({ state: 'unknown' })
    await expect(host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connection-1',
    }))
      .rejects.toMatchObject({ code: 'profile_locked' })
  })

  it('redacts worker failures, records a stable failed status, and never grants access', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, { subject: 'original', keyHandle: 'keychain:original' })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
      ensureRecoveredProfileWorker: async () => { throw new Error(`secret path ${fixtureRoot()}`) },
    })
    const candidate = (await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!
    const operationId = randomUUID()
    let failure: unknown
    try {
      await host.recoverOfflineAccountProfile({
        candidateId: candidate.candidateId, preflightDigest, keyHandle: 'keychain:original',
        unlockMaterial, operationId, ownerId: 'connection-1',
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'recovery_worker_failed' })
    expect(String(failure)).not.toContain('secret path')
    expect(host.getOfflineAccountRecoveryStatus({ operationId, ownerId: 'connection-1' }))
      .toEqual({ state: 'failed', reasonCode: 'recovery_worker_failed' })
    await expect(host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connection-1',
    }))
      .rejects.toMatchObject({ code: 'profile_locked' })
  })
})
