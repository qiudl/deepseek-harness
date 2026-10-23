import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileProfileImportOperationJournal } from '../src/profile-import-operation-journal.ts'
import { FileProfileImportCandidateLease } from '../src/profile-import-candidate-lease.ts'
import { FileProfileImportRuntimePatch } from '../src/profile-import-runtime-patch.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import { existingProfilePatch } from '../src/offline-profile-recovery.ts'
import { compareProfileImportInventory, inspectProfileImportInventory } from '../src/profile-import-preview.ts'
import { ProfileImportSessionCoordinator } from '../src/profile-import-session-coordinator.ts'
import { FileProfileImportFenceFiles, ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { fingerprintProfileImportPluginWeb } from '../src/profile-import-plugin-publish-plan.ts'
import { FileProfileImportPluginPublishJournal } from '../src/profile-import-plugin-publish-journal.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'

const uid = process.getuid?.() ?? 0
const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
  { kind: 'settings', schemaVersion: 1, value: {} },
  { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
  { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
  { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
] }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-import-coordinator-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const createProfile = async (id: string, sessionId: string) => {
    const profileRoot = join(root, 'profiles', id)
    await mkdir(join(profileRoot, 'profiles', 'web'), { recursive: true, mode: 0o700 })
    await writeFile(join(profileRoot, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dependencies: {} }), { mode: 0o600 })
    const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
    await target.activePersistenceConfig()
    await target.importOwnerState(1, ownerState)
    const applicator = new MigrationOwnerStateApplicator(uid)
    const ownerPaths = await applicator.apply(profileRoot, 1, ownerState)
    await writeFile(join(profileRoot, 'cordis.patch.yml'),
      existingProfilePatch(profileRoot, await target.activePersistenceConfig(), ownerPaths), { mode: 0o600 })
    await target.importSession(1, { version: SESSION_FORMAT_VERSION, id: SessionId(sessionId),
      createdAt: 1, isSeeded: false }, [])
    return { profileId: id, profileRoot, target }
  }
  const source = await createProfile(randomUUID(), 'source-session')
  const target = await createProfile(randomUUID(), 'target-session')
  await mkdir(join(root, 'control'), { mode: 0o700 })
  const journal = new FileProfileImportOperationJournal(join(root, 'control', 'profile-import-operations'), uid)
  const fence = new ProfileImportWorkerFence(new FileProfileImportFenceFiles(join(root, 'profiles'), uid))
  const preview = compareProfileImportInventory(
    await inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target, uid }),
    await inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target, uid }),
  )
  const operationId = randomUUID()
  const base = { operationId, source, target, uid, expectedPreviewDigest: preview.previewDigest,
    selectedSessionIds: ['source-session'], selectedPluginNames: [], assertAuthority: async () => {} }
  return { root, source, target, journal, fence, base }
}

async function stagedJointFixture(selectedSessionIds: string[] = ['source-session']) {
  const { root, source, target, journal, fence, base } = await fixture()
  await writeFile(join(source.profileRoot, 'profiles', 'web', 'package.json'),
    JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }), { mode: 0o600 })
  await writeFile(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n", { mode: 0o600 })
  const sourceInventory = await inspectProfileImportInventory({ profileRoot: source.profileRoot,
    target: source.target, uid })
  const targetInventory = await inspectProfileImportInventory({ profileRoot: target.profileRoot,
    target: target.target, uid })
  const preview = compareProfileImportInventory(sourceInventory, targetInventory)
  const jointBase = { ...base, expectedPreviewDigest: preview.previewDigest,
    selectedSessionIds, selectedPluginNames: ['fixture-plugin'] }
  const web = join(target.profileRoot, 'profiles', 'web')
  const stagedWeb = join(target.profileRoot, 'profiles', `.web-import-${base.operationId}`)
  const pluginJournal = new FileProfileImportPluginPublishJournal(
    join(target.profileRoot, 'profile-import-plugin-publish'), uid)
  const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
    revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
    settleHostOperations: async () => {},
  })
  await coordinator.prepareWithPlugins(jointBase, { journal: pluginJournal,
    prepare: async (fenced) => {
      expect(fenced.phase).toBe('fenced')
      await mkdir(stagedWeb, { mode: 0o700 })
      await writeFile(join(stagedWeb, 'package.json'),
        JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }), { mode: 0o600 })
      await writeFile(join(stagedWeb, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", { mode: 0o600 })
      const plan = { targetWebDigest: await fingerprintProfileImportPluginWeb(web, uid),
        candidateWebDigest: await fingerprintProfileImportPluginWeb(stagedWeb, uid),
        beforeEntryDigest: 'a'.repeat(64), afterEntryDigest: 'b'.repeat(64) }
      await pluginJournal.create({ operationId: base.operationId, sourceProfileId: source.profileId,
        targetProfileId: target.profileId, selectedPluginNames: ['fixture-plugin'], plan })
    } })
  const hostLock = await acquireSingleHostLock({ root: join(root, 'host-lock'),
    pid: process.pid, uid, processNonce: randomUUID() })
  const candidateLease = new FileProfileImportCandidateLease(target.profileRoot, base.operationId, uid)
  const runtimePatch = new FileProfileImportRuntimePatch(target.profileRoot, base.operationId,
    target.target, new MigrationOwnerStateApplicator(uid), uid)
  const input = { operationId: base.operationId, source, target, uid,
    assertAuthority: async () => {}, activateCandidate: async (_leaseFd: number) => {},
    candidateLease, runtimePatch, pluginJournal,
    pluginPublisher: { journal: pluginJournal, fence, hostLock, profileRoot: target.profileRoot,
      operationId: base.operationId, sourceProfileId: source.profileId,
      targetProfileId: target.profileId, uid, assertAuthority: async () => {},
      assertQuiescent: async () => {},
      assertPreparedCandidate: async () => {
        const record = await pluginJournal.load(base.operationId)
        expect(await fingerprintProfileImportPluginWeb(stagedWeb, uid))
          .toBe(record?.plan.candidateWebDigest)
      }, assertSessionPointerOld: async () => {} },
  }
  return { root, source, target, journal, fence, base: jointBase, web, stagedWeb,
    pluginJournal, hostLock, coordinator, input }
}

describe.skipIf(process.platform === 'win32')('private Profile import session coordination', () => {
  it('restores status after restart only while the same pair remains authorized', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    await coordinator.prepare(base)
    const restored = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    let checks = 0
    const status = await restored.listStatus({ sourceProfileId: source.profileId,
      targetProfileId: target.profileId, operationOffset: 0, assertAuthority: async () => { checks++ } })
    expect(checks).toBe(2)
    expect(status).toEqual({ operations: [{ operationId: base.operationId, phase: 'staged', revision: 3,
      sessionCount: 1, pluginCount: 0 }], nextOperationOffset: null })
    await expect(restored.listStatus({ sourceProfileId: source.profileId,
      targetProfileId: target.profileId, operationOffset: 0,
      assertAuthority: async () => { throw Error('revoked') } }))
      .rejects.toThrow('revoked')
    expect(await restored.listStatus({ sourceProfileId: target.profileId,
      targetProfileId: source.profileId, operationOffset: 0,
      assertAuthority: async () => {} })).toEqual({ operations: [], nextOperationOffset: null })
  })

  it('pages a large durable operation history without exceeding one control frame', async () => {
    const { source, target, journal, fence } = await fixture()
    const previewDigest = createHash('sha256').update(JSON.stringify(['a'.repeat(64), 'b'.repeat(64)]))
      .digest('hex')
    for (let index = 0; index < 65; index++) await journal.create({
      operationId: randomUUID(), sourceProfileId: source.profileId, targetProfileId: target.profileId,
      sourceSnapshotDigest: 'a'.repeat(64), targetSnapshotDigest: 'b'.repeat(64),
      previewDigest,
      selectedSessionIds: [], selectedPluginNames: [], targetGeneration: 1, stagedGeneration: 2,
    })
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    const input = { sourceProfileId: source.profileId, targetProfileId: target.profileId,
      assertAuthority: async () => {} }
    const first = await coordinator.listStatus({ ...input, operationOffset: 0 })
    expect(first.operations).toHaveLength(64)
    expect(first.nextOperationOffset).toBe(64)
    const second = await coordinator.listStatus({ ...input, operationOffset: 64 })
    expect(second.operations).toHaveLength(1)
    expect(second.nextOperationOffset).toBeNull()
    expect(new Set([...first.operations, ...second.operations].map(row => row.operationId)).size).toBe(65)
  })
  it('records intent, fences both workers, stages without publishing, and durably aborts', async () => {
    const { root, source, target, journal, fence, base } = await fixture()
    const calls: string[] = []
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: (id) => { calls.push(`revoke:${id}`) }, stop: async (id) => { calls.push(`stop:${id}`) },
      settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    const staged = await coordinator.prepare(base)
    expect(staged.phase).toBe('staged')
    expect(staged.revision).toBe(3)
    expect(calls).toEqual([`revoke:${source.profileId}`, `revoke:${target.profileId}`,
      `stop:${source.profileId}`, `stop:${target.profileId}`])
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1', '2'])
    const aborted = await coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} })
    expect(aborted.phase).toBe('aborted')
    expect((await journal.load(base.operationId))?.phase).toBe('aborted')
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    expect(await coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} }))
      .toEqual(aborted)
    expect(await readdir(join(root, 'control', 'profile-import-operations'))).toHaveLength(4)
  })

  it('leaves a failed stop fenced and recoverable from its prepared intent', async () => {
    const { source, target, journal, fence, base } = await fixture()
    let failStop = true
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined,
      stop: async (id) => { if (id === target.profileId && failStop) throw new Error('target stop failed') },
      settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await expect(coordinator.prepare(base)).rejects.toThrow('target stop failed')
    expect((await journal.load(base.operationId))?.phase).toBe('prepared')
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    await expect(coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} }))
      .rejects.toThrow('target stop failed')
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    failStop = false
    await coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} })
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('keeps both workers fenced until extension jobs have settled', async () => {
    const { source, target, journal, fence, base } = await fixture()
    let unsettled = true
    let hostWork = true
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined,
      settleExtensions: async (id) => { if (id === target.profileId && unsettled) throw Error('extension still running') },
      settleHostOperations: async (id) => { if (id === target.profileId && hostWork) throw Error('host operation still running') },
    })
    await expect(coordinator.prepare(base)).rejects.toThrow('extension still running')
    expect((await journal.load(base.operationId))?.phase).toBe('prepared')
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    await expect(coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} }))
      .rejects.toThrow('extension still running')
    unsettled = false
    await expect(coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} }))
      .rejects.toThrow('host operation still running')
    hostWork = false
    await coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} })
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('refuses plugin choices before intent or fencing', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => { throw new Error('should not revoke') }, stop: async () => { throw new Error('should not stop') },
      settleExtensions: async () => { throw new Error('should not settle') },
      settleHostOperations: async () => { throw new Error('should not settle') },
    })
    await expect(coordinator.prepare({ ...base, selectedPluginNames: ['dsh-duet'] }))
      .rejects.toThrow('profile_import_plugins_unavailable')
    expect(await journal.load(base.operationId)).toBeNull()
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('keeps a failed plugin preparation fenced until the inactive Session generation is aborted', async () => {
    const { source, target, journal, fence, base } = await fixture()
    await writeFile(join(source.profileRoot, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }), { mode: 0o600 })
    await writeFile(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n", { mode: 0o600 })
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target, uid }),
      await inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target, uid }))
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    const pluginJournal = new FileProfileImportPluginPublishJournal(
      join(target.profileRoot, 'profile-import-plugin-publish'), uid)
    await expect(coordinator.prepareWithPlugins({ ...base,
      expectedPreviewDigest: preview.previewDigest, selectedPluginNames: ['fixture-plugin'] },
    { journal: pluginJournal, prepare: async () => { throw Error('simulated plugin preparation failure') } }))
      .rejects.toThrow('simulated plugin preparation failure')
    expect((await journal.load(base.operationId))?.phase).toBe('fenced')
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1', '2'])
    const aborted = await coordinator.abort({ operationId: base.operationId, target,
      assertAuthority: async () => {} })
    expect(aborted.phase).toBe('aborted')
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('commits an already staged Session and plugin layer under one fenced operation', async () => {
    const { source, target, journal, fence, base, web, hostLock, coordinator, input } = await stagedJointFixture()
    const failedPointer = vi.spyOn(target.target, 'commitGeneration')
      .mockRejectedValueOnce(Error('simulated pointer failure'))
    await expect(coordinator.commitWithPlugins(input)).rejects.toThrow('simulated pointer failure')
    failedPointer.mockRestore()
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(join(web, 'package.json'), 'utf8')).toContain('fixture-plugin')
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    const failedReceipt = vi.spyOn(journal, 'advance')
      .mockRejectedValueOnce(Error('simulated journal failure'))
    await expect(coordinator.commitWithPlugins(input)).rejects.toThrow('simulated journal failure')
    failedReceipt.mockRestore()
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(2)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    await expect(coordinator.abortWithPlugins(input)).rejects.toThrow('profile_import_generation_changed')
    const committed = await coordinator.commitWithPlugins(input)
    expect(committed.phase).toBe('committed')
    expect(await target.target.activeGeneration()).toBe(2)
    expect(await readFile(join(web, 'package.json'), 'utf8')).toContain('fixture-plugin')
    expect(await coordinator.commitWithPlugins(input)).toEqual(committed)
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('checks candidate activation after both publications and before clearing either fence', async () => {
    const { target, fence, hostLock, coordinator, input, web } = await stagedJointFixture()
    const activateCandidate = vi.fn(async () => {
      expect(await target.target.activeGeneration()).toBe(2)
      expect(await readFile(join(web, 'package.json'), 'utf8')).toContain('fixture-plugin')
      expect(await readFile(join(target.profileRoot, 'cordis.patch.yml'), 'utf8'))
        .toContain('/migration-owner-state/2/')
      expect(() => fence.assertOpen(target.profileId)).toThrow()
    })
    expect((await coordinator.commitWithPlugins({ ...input, activateCandidate })).phase).toBe('committed')
    expect(activateCandidate).toHaveBeenCalledOnce()
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('does not enter committing when the candidate lifetime witness cannot be acquired', async () => {
    const { target, journal, fence, hostLock, coordinator, input } = await stagedJointFixture()
    const acquire = vi.spyOn(input.candidateLease, 'acquireForSpawn')
      .mockRejectedValueOnce(Error('candidate lease unavailable'))
    await expect(coordinator.commitWithPlugins(input)).rejects.toThrow('candidate lease unavailable')
    acquire.mockRestore()
    expect((await journal.load(input.operationId))?.phase).toBe('staged')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    await hostLock.release()
  })

  it('rolls back a published plugin layer before aborting an uncommitted Session generation', async () => {
    const { source, target, journal, fence, base, web, hostLock, coordinator, input } = await stagedJointFixture()
    const originalManifest = await readFile(join(web, 'package.json'))
    const failedPointer = vi.spyOn(target.target, 'commitGeneration')
      .mockRejectedValueOnce(Error('simulated pointer failure'))
    await expect(coordinator.commitWithPlugins(input)).rejects.toThrow('simulated pointer failure')
    failedPointer.mockRestore()
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(join(web, 'package.json'), 'utf8')).toContain('fixture-plugin')
    const failedAbort = vi.spyOn(target.target, 'abortGeneration')
      .mockRejectedValueOnce(Error('simulated abort failure'))
    await expect(coordinator.abortWithPlugins(input)).rejects.toThrow('simulated abort failure')
    failedAbort.mockRestore()
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(await readFile(join(web, 'package.json'))).toEqual(originalManifest)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    const aborted = await coordinator.abortWithPlugins(input)
    expect(aborted.phase).toBe('aborted')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    expect(await readFile(join(web, 'package.json'))).toEqual(originalManifest)
    expect(await coordinator.abortWithPlugins(input)).toEqual(aborted)
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('reverses a switched candidate only after failed activation is stopped', async () => {
    const { source, target, journal, fence, base, web, hostLock, coordinator, input } = await stagedJointFixture()
    const originalManifest = await readFile(join(web, 'package.json'))
    const originalPatch = await readFile(join(target.profileRoot, 'cordis.patch.yml'))
    await expect(coordinator.commitWithPlugins({ ...input,
      activateCandidate: async () => { throw Error('activation failed') },
    })).rejects.toThrow('activation failed')
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(2)
    const running = await input.candidateLease.acquireForSpawn()
    await expect(coordinator.rollbackFailedActivationWithPlugins(input))
      .rejects.toThrow('profile_import_candidate_running')
    await running.close()
    expect(await target.target.activeGeneration()).toBe(2)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    const aborted = await coordinator.rollbackFailedActivationWithPlugins(input)
    expect(aborted.phase).toBe('aborted')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(join(web, 'package.json'))).toEqual(originalManifest)
    expect(await readFile(join(target.profileRoot, 'cordis.patch.yml'))).toEqual(originalPatch)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it.runIf(process.platform === 'darwin')('stops an attested candidate before crash recovery reverses the pointer', async () => {
    const { root, target, journal, fence, hostLock, coordinator, input, web } = await stagedJointFixture()
    const entrypoint = join(root, 'candidate.mjs')
    await writeFile(entrypoint, "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)")
    let child: ChildProcess | undefined
    onTestFinished(() => { child?.kill('SIGKILL') })
    await expect(coordinator.commitWithPlugins({ ...input,
      activateCandidate: async (fd) => {
        child = spawn(process.execPath, [entrypoint, '--profile', 'web', '--no-open',
          '--host', '127.0.0.1', '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore', fd] })
        await once(child.stdout!, 'data')
        throw Error('Host crashed after candidate launch')
      },
    })).rejects.toThrow('Host crashed after candidate launch')
    expect((await journal.load(input.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(2)
    await expect(input.candidateLease.assertStopped()).rejects.toThrow('profile_import_candidate_running')
    const restartedFence = new ProfileImportWorkerFence(new FileProfileImportFenceFiles(
      join(root, 'profiles'), uid))
    const restarted = new ProfileImportSessionCoordinator(journal, restartedFence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    const recovery = { ...input, pluginPublisher: { ...input.pluginPublisher, fence: restartedFence } }
    const manifestPath = join(web, 'package.json')
    const publishedManifest = await readFile(manifestPath)
    const altered = vi.spyOn(input.candidateLease, 'stopOrphan').mockImplementationOnce(async (options) => {
      await options.assertAuthority()
      await writeFile(manifestPath, '{}')
      try {
        await expect(options.assertAuthority()).rejects.toThrow(/profile_import_plugin_publish_/u)
      } finally { await writeFile(manifestPath, publishedManifest) }
      throw Error('publication changed before signal')
    })
    await expect(restarted.recoverFailedActivationWithPlugins({ ...recovery,
      nodeExecutablePath: process.execPath, dshEntrypointPath: entrypoint }))
      .rejects.toThrow('publication changed before signal')
    altered.mockRestore()
    expect(child?.exitCode).toBeNull()
    await expect(restarted.recoverFailedActivationWithPlugins({ ...recovery,
      pluginPublisher: { ...recovery.pluginPublisher, operationId: randomUUID() },
      nodeExecutablePath: process.execPath, dshEntrypointPath: entrypoint }))
      .rejects.toThrow('profile_import_operation_not_recoverable')
    await expect(restarted.recoverFailedActivationWithPlugins({ ...recovery,
      nodeExecutablePath: process.execPath, dshEntrypointPath: join(root, 'wrong.mjs') }))
      .rejects.toThrow('profile_import_candidate_holder_unsafe')
    expect(child?.exitCode).toBeNull()
    expect(await target.target.activeGeneration()).toBe(2)
    const exited = once(child!, 'exit')
    expect((await restarted.recoverFailedActivationWithPlugins({ ...recovery,
      nodeExecutablePath: process.execPath, dshEntrypointPath: entrypoint })).phase).toBe('aborted')
    await exited
    await input.candidateLease.assertStopped()
    expect(await target.target.activeGeneration()).toBe(1)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('restores the old patch after a crash between Session switch and patch publication', async () => {
    const { target, journal, fence, hostLock, coordinator, input } = await stagedJointFixture()
    const patchPath = join(target.profileRoot, 'cordis.patch.yml')
    const originalPatch = await readFile(patchPath)
    const failedPatch = vi.spyOn(input.runtimePatch, 'publishCandidate')
      .mockRejectedValueOnce(Error('crash before patch publication'))
    await expect(coordinator.commitWithPlugins(input)).rejects.toThrow('crash before patch publication')
    failedPatch.mockRestore()
    expect((await journal.load(input.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(2)
    expect(await readFile(patchPath)).toEqual(originalPatch)
    expect((await coordinator.rollbackFailedActivationWithPlugins(input)).phase).toBe('aborted')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(patchPath)).toEqual(originalPatch)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('repairs the candidate patch on ordinary abort after pointer reversal was interrupted', async () => {
    const { target, fence, hostLock, coordinator, input } = await stagedJointFixture()
    const patchPath = join(target.profileRoot, 'cordis.patch.yml')
    const originalPatch = await readFile(patchPath)
    await expect(coordinator.commitWithPlugins({ ...input,
      activateCandidate: async () => { throw Error('activation failed') },
    })).rejects.toThrow('activation failed')
    const failedRestore = vi.spyOn(input.runtimePatch, 'restoreOld')
      .mockRejectedValueOnce(Error('crash before patch restore'))
    await expect(coordinator.rollbackFailedActivationWithPlugins(input))
      .rejects.toThrow('crash before patch restore')
    failedRestore.mockRestore()
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(patchPath, 'utf8')).toContain('/migration-owner-state/2/')
    expect((await coordinator.abortWithPlugins(input)).phase).toBe('aborted')
    expect(await readFile(patchPath)).toEqual(originalPatch)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('recovers a crash after reversing the candidate pointer but before plugin rollback', async () => {
    const { target, pluginJournal, fence, hostLock, coordinator, input, web } = await stagedJointFixture()
    const originalManifest = await readFile(join(web, 'package.json'))
    const originalPatch = await readFile(join(target.profileRoot, 'cordis.patch.yml'))
    await expect(coordinator.commitWithPlugins({ ...input,
      activateCandidate: async () => { throw Error('activation failed') },
    })).rejects.toThrow('activation failed')
    const failRollback = vi.spyOn(pluginJournal, 'advance')
      .mockRejectedValueOnce(Error('crash after pointer reversal'))
    await expect(coordinator.rollbackFailedActivationWithPlugins(input))
      .rejects.toThrow('crash after pointer reversal')
    failRollback.mockRestore()
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readFile(join(target.profileRoot, 'cordis.patch.yml'))).toEqual(originalPatch)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    expect(await coordinator.abortWithPlugins(input)).toMatchObject({ phase: 'aborted' })
    expect(await readFile(join(web, 'package.json'))).toEqual(originalManifest)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('aborts a prepared plugin layer without ever replacing the live web directory', async () => {
    const { source, target, fence, web, hostLock, coordinator, input } = await stagedJointFixture()
    const originalManifest = await readFile(join(web, 'package.json'))
    const aborted = await coordinator.abortWithPlugins(input)
    expect(aborted.phase).toBe('aborted')
    expect(await readFile(join(web, 'package.json'))).toEqual(originalManifest)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('permits a plugin-only import with no selected source Sessions', async () => {
    const { source, target, fence, hostLock, coordinator, input } = await stagedJointFixture([])
    expect((await coordinator.commitWithPlugins(input)).phase).toBe('committed')
    const inventory = await inspectProfileImportInventory({ profileRoot: target.profileRoot,
      target: target.target, uid })
    expect(inventory.sessions.map(row => row.id)).toEqual(['target-session'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    await hostLock.release()
  })

  it('leaves a changed preview fenced until an explicit abort removes its intent', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined,
      stop: async (id) => {
        if (id === source.profileId) await writeFile(join(source.profileRoot, 'profiles', 'web', 'package.json'),
          JSON.stringify({ dependencies: {}, changed: true }), { mode: 0o600 })
      },
      settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await expect(coordinator.prepare(base)).rejects.toThrow('profile_import_inventory_changed')
    expect((await journal.load(base.operationId))?.phase).toBe('fenced')
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    await coordinator.abort({ operationId: base.operationId, target, assertAuthority: async () => {} })
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('reads crash recovery evidence before and after a pointer switch without releasing fences', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    const staged = await coordinator.prepare(base)
    const committing = await journal.advance(staged, 'committing')
    const input = { operationId: base.operationId, source, target, uid, assertAuthority: async () => {} }
    expect(await coordinator.inspectCommitting(input)).toEqual({
      operation: committing, pointer: 'old', sessionCount: 2,
    })
    await target.target.commitGeneration(1, 2)
    expect(await coordinator.inspectCommitting(input)).toEqual({
      operation: committing, pointer: 'staged', sessionCount: 2,
    })
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
  })

  it('refuses a changed staged owner state during committing recovery', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await journal.advance(await coordinator.prepare(base), 'committing')
    await writeFile(join(target.target.generationRoot(2), 'owner-state.json'),
      JSON.stringify({ ...ownerState, documents: ownerState.documents.map(row => row.kind === 'profile'
        ? { ...row, value: { name: 'headless', customPlugins: [] } } : row) }), { mode: 0o600 })
    await expect(coordinator.inspectCommitting({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })).rejects.toThrow('profile_import_stage_mismatch')
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
  })

  it('inspects a released compressed V3 old target without requiring migration metadata', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const oldSession = join(target.target.generationRoot(1), 'project', 'req0002-old-writer-history')
    await mkdir(oldSession, { recursive: true, mode: 0o700 })
    const bytes = await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v3-old-writer.jsonl.zstd', import.meta.url))
    await writeFile(join(oldSession, 'session.v3.jsonl.zstd'), bytes, { mode: 0o600 })
    const predecessor = await compressZstdFrame(JSON.stringify({
      type: 'session', version: 0, id: 'req0002-old-writer-history', createdAt: 1, delegationDepth: 0,
    }) + '\n')
    await writeFile(join(oldSession, 'session.jsonl.zstd'), predecessor, { mode: 0o600 })
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target, uid }),
      await inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target, uid }),
    )
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await journal.advance(await coordinator.prepare({ ...base, expectedPreviewDigest: preview.previewDigest }), 'committing')
    expect(await coordinator.inspectCommitting({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })).toMatchObject({ pointer: 'old', sessionCount: 3 })
    expect(await readFile(join(oldSession, 'session.v3.jsonl.zstd'))).toEqual(bytes)
  })

  it('commits selected sessions while retaining source and nonempty target history', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await coordinator.prepare(base)
    const committed = await coordinator.commit({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })
    expect(committed.phase).toBe('committed')
    expect(await target.target.activeGeneration()).toBe(2)
    expect((await inspectProfileImportInventory({ profileRoot: target.profileRoot, target: target.target, uid }))
      .sessions.map(row => row.id)).toEqual(['source-session', 'target-session'])
    expect(await source.target.activeGeneration()).toBe(1)
    expect((await inspectProfileImportInventory({ profileRoot: source.profileRoot, target: source.target, uid }))
      .sessions.map(row => row.id)).toEqual(['source-session'])
    expect((await journal.load(base.operationId))?.phase).toBe('committed')
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
    expect(await coordinator.commit({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })).toEqual(committed)
  })

  it('recovers a pointer switch whose response was lost after a Host restart', async () => {
    const { root, source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await coordinator.prepare(base)
    const actual = target.target.commitGeneration.bind(target.target)
    const commit = vi.spyOn(target.target, 'commitGeneration').mockImplementationOnce(async (...args) => {
      await actual(...args)
      throw Error('lost pointer response')
    })
    const input = { operationId: base.operationId, source, target, uid, assertAuthority: async () => {} }
    await expect(coordinator.commit(input)).rejects.toThrow('lost pointer response')
    expect((await journal.load(base.operationId))?.phase).toBe('committing')
    expect(await target.target.activeGeneration()).toBe(2)
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    const restartedTarget = { ...target, target: new FileOwnerJsonlMigrationGenerationTarget(
      join(target.profileRoot, 'persistence'), uid, 1) }
    const restartedJournal = new FileProfileImportOperationJournal(
      join(root, 'control', 'profile-import-operations'), uid)
    const restartedFence = new ProfileImportWorkerFence(new FileProfileImportFenceFiles(join(root, 'profiles'), uid))
    const restarted = new ProfileImportSessionCoordinator(restartedJournal, restartedFence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    expect((await restarted.commit({ ...input, target: restartedTarget })).phase).toBe('committed')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1', '2'])
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('recovers a durable committing intent before its pointer switch', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await journal.advance(await coordinator.prepare(base), 'committing')
    expect(await target.target.activeGeneration()).toBe(1)
    expect((await coordinator.commit({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })).phase).toBe('committed')
    expect(await target.target.activeGeneration()).toBe(2)
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('rechecks committed data before releasing markers left by a failed clear', async () => {
    const { root, source, target, journal, fence, base } = await fixture()
    const workers = { revoke: () => undefined, stop: async () => undefined,
      settleExtensions: async () => undefined, settleHostOperations: async () => undefined }
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, workers)
    await coordinator.prepare(base)
    vi.spyOn(fence, 'clearPair').mockImplementationOnce(() => { throw Error('marker write failed') })
    const input = { operationId: base.operationId, source, target, uid, assertAuthority: async () => {} }
    await expect(coordinator.commit(input)).rejects.toThrow('marker write failed')
    expect((await journal.load(base.operationId))?.phase).toBe('committed')
    expect(() => fence.assertOpen(target.profileId)).toThrow()
    const restarted = new ProfileImportSessionCoordinator(new FileProfileImportOperationJournal(
      join(root, 'control', 'profile-import-operations'), uid),
    new ProfileImportWorkerFence(new FileProfileImportFenceFiles(join(root, 'profiles'), uid)), workers)
    expect((await restarted.commit(input)).phase).toBe('committed')
    fence.assertOpen(source.profileId)
    fence.assertOpen(target.profileId)
  })

  it('keeps the old pointer and both fences when staged data changes before commit', async () => {
    const { source, target, journal, fence, base } = await fixture()
    const coordinator = new ProfileImportSessionCoordinator(journal, fence, {
      revoke: () => undefined, stop: async () => undefined, settleExtensions: async () => undefined,
      settleHostOperations: async () => undefined,
    })
    await coordinator.prepare(base)
    await writeFile(join(target.target.generationRoot(2), 'owner-state.json'),
      JSON.stringify({ ...ownerState, documents: ownerState.documents.map(row => row.kind === 'profile'
        ? { ...row, value: { name: 'headless', customPlugins: [] } } : row) }), { mode: 0o600 })
    await expect(coordinator.commit({ operationId: base.operationId, source, target, uid,
      assertAuthority: async () => {} })).rejects.toThrow('profile_import_stage_mismatch')
    expect((await journal.load(base.operationId))?.phase).toBe('staged')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(() => fence.assertOpen(source.profileId)).toThrow()
    expect(() => fence.assertOpen(target.profileId)).toThrow()
  })
})
