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

  it('reports zero bindings for an unbound historical Account Profile', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    await account(registry, { subject: 'unbound', keyHandle: 'keychain:unbound' })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 0, pluginCount: 0, preflightDigest,
      }),
    })
    await expect(host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:unbound'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).resolves.toEqual({ candidates: [expect.objectContaining({ bindingCount: 0 })] })
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

    const opened = await host.openOfflineAccountProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration, ownerId: 'connection-1',
    })
    expect(opened).toMatchObject({ profileId: original.profileId, accessScope: 'offline_local' })
    expect(() => host.authorizeExtensionView({
      viewLeaseId: opened.viewLeaseId, leaseGeneration: opened.leaseGeneration,
      runtimeGeneration: 5, ownerId: 'connection-1',
    })).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    expect(() => host.authorizeAccountModelClaimView({
      viewLeaseId: opened.viewLeaseId, leaseGeneration: opened.leaseGeneration,
      runtimeGeneration: 5, ownerId: 'connection-1',
    })).toThrow(expect.objectContaining({ code: 'unauthorized' }))
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

  it('rejects invalid, unavailable, missing, ambiguous, and expired inspection candidates', async () => {
    let now = 1_000
    const clock = { now: () => now }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    await account(registry, { subject: 'original', keyHandle: 'keychain:original' })
    await account(registry, { subject: 'duplicate-a', keyHandle: 'keychain:duplicate' })
    await account(registry, { subject: 'duplicate-b', keyHandle: 'keychain:duplicate' })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
      ensureRecoveredProfileWorker: async () => undefined,
    })
    const inspect = (overrides: Partial<Parameters<typeof host.inspectOfflineAccountProfiles>[0]> = {}) =>
      host.inspectOfflineAccountProfiles({
        keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
        expectedSchemaGeneration: 3, ownerId: 'connection-1', ...overrides,
      })

    await expect(inspect({ keyHandles: [] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(inspect({ keyHandles: Array.from({ length: 129 }, (_, index) => `keychain:${index}`) }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(inspect({ keyHandles: ['keychain:original', 'keychain:original'] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(inspect({ expectedRuntimeGeneration: 4 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(inspect({ expectedSchemaGeneration: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(inspect({ keyHandles: ['keychain:missing'] })).rejects.toMatchObject({ code: 'profile_not_found' })
    await expect(inspect({ keyHandles: ['keychain:duplicate'] })).rejects.toMatchObject({ code: 'profile_ambiguous' })

    const candidate = (await inspect()).candidates[0]!
    now += 5 * 60_000
    await inspect()
    await expect(host.recoverOfflineAccountProfile({
      candidateId: candidate.candidateId, preflightDigest,
      keyHandle: 'keychain:original', unlockMaterial,
      operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'recovery_preflight_stale' })

    const unavailable = new DesktopHost({ registry, clock, runtimeGeneration: 5 })
    await expect(unavailable.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('validates every recovery preflight field before publishing a candidate', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    await account(registry, { subject: 'original', keyHandle: 'keychain:original' })
    const base = {
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
      sessionCount: 86, pluginCount: 6, preflightDigest,
    } as const
    const invalid = [
      { ...base, state: 'unknown' },
      { ...base, compatibility: 'unknown' },
      { ...base, persistenceGeneration: -1 },
      { ...base, sessionCount: -1 },
      { ...base, pluginCount: -1 },
      { ...base, preflightDigest: 'invalid' },
      { ...base, reasonCode: '' },
      { ...base, reasonCode: 'x'.repeat(129) },
    ]
    for (const preflight of invalid) {
      const host = new DesktopHost({
        registry, clock, runtimeGeneration: 5,
        inspectOfflineAccountProfile: async () => preflight as never,
        ensureRecoveredProfileWorker: async () => undefined,
      })
      await expect(host.inspectOfflineAccountProfiles({
        keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
        expectedSchemaGeneration: 3, ownerId: 'connection-1',
      })).rejects.toMatchObject({ code: 'profile_integrity_failed' })
    }
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

  it('rejects malformed, stale, incompatible, conflicting, and unsupported recovery requests', async () => {
    const clock = { now: () => 1_000 }
    const registry = new ProfileRegistry({ root: fixtureRoot(), deviceIndexKey: Buffer.alloc(32, 7), clock })
    const original = await account(registry, {
      subject: 'original', keyHandle: 'keychain:original', bindingHandle: 'binding:original',
    })
    let finishWorker!: () => void
    const workerReady = new Promise<void>((resolve) => { finishWorker = resolve })
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      ensureProfileWorker: async () => undefined,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
      ensureRecoveredProfileWorker: async () => { await workerReady },
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

    await expect(host.recoverOfflineAccountProfile({ ...input, operationId: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(host.recoverOfflineAccountProfile({ ...input, preflightDigest: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(host.recoverOfflineAccountProfile({ ...input, ownerId: 'connection-2' }))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await expect(host.recoverOfflineAccountProfile({ ...input, keyHandle: 'keychain:other' }))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await expect(host.recoverOfflineAccountProfile({ ...input, unlockMaterial: 'invalid' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(() => host.getOfflineAccountRecoveryStatus({ operationId: 'invalid', ownerId: 'connection-1' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }))

    const first = host.recoverOfflineAccountProfile(input)
    await new Promise<void>(resolve => setImmediate(resolve))
    await expect(host.recoverOfflineAccountProfile({ ...input, keyHandle: 'keychain:other' }))
      .rejects.toMatchObject({ code: 'idempotency_conflict' })
    host.revokeOwner('other-connection')
    host.revokeOwner('connection-1')
    finishWorker()
    await expect(first).rejects.toMatchObject({ code: 'recovery_worker_failed' })
    expect(host.getOfflineAccountRecoveryStatus({ operationId, ownerId: 'connection-1' }))
      .toEqual({ state: 'unknown' })

    const incompatible = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'compatibility_blocked', compatibility: 'legacy_runtime_required', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest, reasonCode: 'runtime_upgrade_required',
      }),
      ensureRecoveredProfileWorker: async () => undefined,
    })
    const blocked = (await incompatible.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!
    await expect(incompatible.recoverOfflineAccountProfile({
      candidateId: blocked.candidateId, preflightDigest, keyHandle: 'keychain:original',
      unlockMaterial, operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'runtime_incompatible' })

    const unsupported = new DesktopHost({
      registry, clock, runtimeGeneration: 5,
      inspectOfflineAccountProfile: async () => ({
        state: 'recoverable', compatibility: 'current', persistenceGeneration: 11,
        sessionCount: 86, pluginCount: 6, preflightDigest,
      }),
    })
    const unsupportedCandidate = (await unsupported.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connection-1',
    })).candidates[0]!
    await expect(unsupported.recoverOfflineAccountProfile({
      candidateId: unsupportedCandidate.candidateId, preflightDigest, keyHandle: 'keychain:original',
      unlockMaterial, operationId: randomUUID(), ownerId: 'connection-1',
    })).rejects.toMatchObject({ code: 'unavailable' })

    await host.restoreProfile({
      profileId: original.profileId, bindingGeneration: original.bindingGeneration,
      authorityEnvironmentId: environmentId, accountBindingHandle: 'binding:original',
      authorityBindingVersion: 1, keyHandle: 'keychain:original', unlockMaterial,
      ownerId: 'connected-owner',
    })
    const connectedCandidate = (await host.inspectOfflineAccountProfiles({
      keyHandles: ['keychain:original'], expectedRuntimeGeneration: 5,
      expectedSchemaGeneration: 3, ownerId: 'connected-owner',
    })).candidates[0]!
    await expect(host.recoverOfflineAccountProfile({
      candidateId: connectedCandidate.candidateId, preflightDigest, keyHandle: 'keychain:original',
      unlockMaterial, operationId: randomUUID(), ownerId: 'connected-owner',
    })).rejects.toMatchObject({ code: 'scope_mismatch' })
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
