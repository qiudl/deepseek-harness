import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { MigrationOwnerStateApplicator, migrationOwnerStateObject } from '../src/migration-owner-state-applicator.ts'
import { MaterializedMigrationOwnerStateSource } from '../src/materialized-migration-owner-state-source.ts'
import { restrictedProfileOwnerState } from '../src/restricted-profile-owner-state.ts'
import { stageRestrictedProfile } from '../src/restricted-profile-staging.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { startRestrictedProfileReader } from '../src/restricted-profile-reader.ts'

const uid = process.getuid?.() ?? 0
const inspectFixture = (root: string, compression: 'none' | 'zstd' = 'none') => async () =>
  ({ root, compression, generation: 5, sessionCount: 0, inventoryDigest: 'a'.repeat(64) })

function state(defaultPreset = 'workspace-write'): MigrationOwnerStateBundle {
  return {
    version: 1,
    documents: [
      { kind: 'settings', schemaVersion: 1, value: { permission: { defaultPreset } } },
      { kind: 'credentials', schemaVersion: 1, value: { refs: { DEEPSEEK_API_KEY: 'sk-private' }, records: {} } },
      { kind: 'workspace', schemaVersion: 1, value: {
        grants: ['/workspace'],
        storage: {
          unit: { name: 'workspace', version: 2 },
          global: { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: [] },
          tables: { workspaces: { 'workspace-1': {
            path: '/workspace', title: 'Fixture', sessionIds: [], createdAt: 'now', updatedAt: 'now',
          } } },
        },
      } },
      { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
    ],
  }
}

describe('migration owner-state generation applicator', () => {
  it('stages a private restricted Profile with no original credentials or plugin configuration', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const stagingParent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const settingsBefore = await readFile(paths.settingsPath)
    const credentialsBefore = await readFile(paths.credentialsPath)
    const storageBefore = await readFile(join(paths.storageRoot, 'workspace.json'))
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(stagingParent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    let checks = 0
    const staged = await stageRestrictedProfile({ stagingParent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' },
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      ownership, assertCurrent: () => { checks += 1 }, signal: new AbortController().signal })
    expect(checks).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(staged.root, 'cordis.patch.yml'), 'utf8')).toContain(persistenceRoot)
    expect(await readFile(join(staged.root, 'profiles/web/package.json'), 'utf8')).not.toContain('fixture-plugin')
    expect(await readFile(staged.ownerPaths.settingsPath, 'utf8')).not.toContain('workspace-write')
    expect(await readFile(staged.ownerPaths.credentialsPath, 'utf8')).not.toContain('sk-private')
    expect(await readFile(join(staged.ownerPaths.storageRoot, 'workspace.json'), 'utf8')).toContain('Fixture')
    await staged.dispose()
    await expect(access(staged.root)).rejects.toMatchObject({ code: 'ENOENT' })
    const compressed = await stageRestrictedProfile({ stagingParent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'zstd' },
      inspectPersistence: inspectFixture(persistenceRoot, 'zstd'),
      ownership, assertCurrent: () => {}, signal: new AbortController().signal })
    expect(await readFile(join(compressed.root, 'cordis.patch.yml'), 'utf8')).toContain('compression: zstd')
    await compressed.dispose()
    expect(await readFile(paths.settingsPath)).toEqual(settingsBefore)
    expect(await readFile(paths.credentialsPath)).toEqual(credentialsBefore)
    expect(await readFile(join(paths.storageRoot, 'workspace.json'))).toEqual(storageBefore)
  })

  it('rejects unsafe staging parents and removes a cancelled staged copy', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    const input = { stagingParent: parent, expectedUid: uid, profileRoot: source, ownerPaths: paths,
      persistence: { root: persistenceRoot, compression: 'none' as const },
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      ownership, assertCurrent: () => {}, signal: new AbortController().signal }
    await expect(stageRestrictedProfile({ ...input, stagingParent: source })).rejects.toMatchObject({ code: 'invalid_input' })
    const link = join(parent, 'linked-parent')
    await symlink(parent, link)
    await expect(stageRestrictedProfile({ ...input, stagingParent: link })).rejects.toMatchObject({ code: 'profile_integrity_failed' })
    await chmod(parent, 0o755)
    await expect(stageRestrictedProfile(input)).rejects.toMatchObject({ code: 'profile_integrity_failed' })
    await chmod(parent, 0o700)
    await expect(stageRestrictedProfile({ ...input, ownerPaths: { ...paths, generation: 6 } })).rejects.toThrow()
    await chmod(source, 0o755)
    await expect(stageRestrictedProfile(input)).rejects.toMatchObject({ code: 'profile_integrity_failed' })
    await chmod(source, 0o700)
    let checks = 0
    await expect(stageRestrictedProfile({ ...input, assertCurrent: () => {
      if (++checks === 3) throw new Error('owner_revoked')
    } })).rejects.toThrow('owner_revoked')
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
    await expect(access(paths.settingsPath)).resolves.toBeUndefined()
    await ownership.release()
    await expect(stageRestrictedProfile(input)).rejects.toMatchObject({ code: 'stale' })
  })

  it('does not delete a staged Profile after losing its Host lock', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    const staged = await stageRestrictedProfile({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      assertCurrent: () => {}, signal: new AbortController().signal })
    onTestFinished(() => rm(staged.root, { recursive: true, force: true }))
    await ownership.release()
    await expect(staged.dispose()).rejects.toMatchObject({ code: 'stale' })
    await expect(access(staged.root)).resolves.toBeUndefined()
  })

  it('refuses a workspace snapshot changed while the restricted Profile is staged', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    const file = join(paths.storageRoot, 'workspace.json')
    const original = JSON.parse(await readFile(file, 'utf8'))
    let checks = 0
    await expect(stageRestrictedProfile({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      signal: new AbortController().signal, assertCurrent: () => {
        if (++checks === 2) writeFileSync(file, JSON.stringify({ ...original, extra: 'concurrent-change' }))
      } })).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
  })

  it('refuses a persistence generation that changes while the restricted Profile is staged', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    let inspections = 0
    await expect(stageRestrictedProfile({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: async () => ({ root: persistenceRoot, compression: 'none', generation: 5,
        sessionCount: 1, inventoryDigest: (++inspections === 1 ? 'a' : 'b').repeat(64) }),
      signal: new AbortController().signal, assertCurrent: () => {} }))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
  })

  it('does not publish a restricted reader if workspace state changes while its worker starts', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    const file = join(paths.storageRoot, 'workspace.json')
    const original = JSON.parse(await readFile(file, 'utf8'))
    await expect(startRestrictedProfileReader({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot), profileId: 'profile', credentialHandle: 'fixture',
      signal: new AbortController().signal, onCleanupFailure: () => {}, assertCurrent: () => {},
      createWorker: async () => {
        writeFileSync(file, JSON.stringify({ ...original, extra: 'concurrent-change' }))
        return { closeNotifications() {}, abort() {}, done: Promise.resolve() }
      },
    })).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
  })

  it('withholds an in-flight restricted response after Profile authorization changes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let authorized = true
    const reader = await startRestrictedProfileReader({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      profileId: 'profile', credentialHandle: 'fixture', signal: new AbortController().signal, onCleanupFailure: () => {},
      assertCurrent: () => { if (!authorized) throw new Error('owner_revoked') },
      createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve(),
        remoteSession: async () => { await new Promise<void>(resolve => { release = resolve; entered() }); return { items: ['private'] } } }),
    })
    onTestFinished(() => reader.close())
    const pending = reader.read({ operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as never },
      new AbortController().signal)
    await started
    authorized = false
    release()
    await expect(pending).rejects.toThrow('owner_revoked')
    await reader.close()
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
  })

  it('stops the restricted worker when its owning connection is cancelled', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    onTestFinished(() => ownership.release())
    const connection = new AbortController()
    const abort = vi.fn()
    const cleanupFailed = vi.fn()
    const reader = await startRestrictedProfileReader({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      profileId: 'profile', credentialHandle: 'fixture', signal: connection.signal, onCleanupFailure: cleanupFailed,
      assertCurrent: () => {}, createWorker: async () => ({ closeNotifications() {}, abort, done: Promise.resolve() }),
    })
    onTestFinished(() => reader.close())
    connection.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(abort).toHaveBeenCalledOnce()
    await reader.close()
    expect((await readdir(parent)).filter(name => name.startsWith('restricted-'))).toEqual([])
    expect(cleanupFailed).not.toHaveBeenCalled()
  })

  it('reports cleanup failure and retains the staged data when Host ownership is lost', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-restricted-source-'))
    const parent = await mkdtemp(join(tmpdir(), 'dsh-restricted-parent-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(source, 5, state())
    const persistenceRoot = join(source, 'sessions')
    await mkdir(persistenceRoot, { mode: 0o700 })
    const ownership = await acquireSingleHostLock({ root: join(parent, 'lock'), pid: process.pid, uid,
      processNonce: 'restricted-fixture-lock' })
    const connection = new AbortController()
    const cleanupFailed = vi.fn()
    const reader = await startRestrictedProfileReader({ stagingParent: parent, expectedUid: uid, profileRoot: source,
      ownerPaths: paths, persistence: { root: persistenceRoot, compression: 'none' }, ownership,
      inspectPersistence: inspectFixture(persistenceRoot, 'none'),
      profileId: 'profile', credentialHandle: 'fixture', signal: connection.signal, onCleanupFailure: cleanupFailed,
      assertCurrent: () => {}, createWorker: async () => ({ closeNotifications() {}, abort() {}, done: Promise.resolve() }),
    })
    const stagedName = (await readdir(parent)).find(name => name.startsWith('restricted-'))!
    onTestFinished(() => rm(join(parent, stagedName), { recursive: true, force: true }))
    await ownership.release()
    connection.abort()
    await expect(reader.close()).rejects.toMatchObject({ code: 'stale' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(cleanupFailed).toHaveBeenCalledOnce()
    await expect(access(join(parent, stagedName))).resolves.toBeUndefined()
  })
  it('reads workspace metadata without opening settings or credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-workspace-only-'))
    const paths = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await writeFile(paths.settingsPath, 'invalid: [')
    await writeFile(paths.credentialsPath, 'invalid: [')
    const workspace = await new MaterializedMigrationOwnerStateSource(paths, uid).readWorkspace()
    expect(workspace).toMatchObject({ kind: 'workspace', schemaVersion: 1, value: { grants: ['/workspace'] } })
    const restricted = await restrictedProfileOwnerState(new MaterializedMigrationOwnerStateSource(paths, uid))
    expect(restricted.documents.find(document => document.kind === 'workspace')).toEqual(workspace)
    expect(restricted.documents.find(document => document.kind === 'credentials')?.value).toEqual({ refs: {}, records: {} })
    expect(restricted.documents.find(document => document.kind === 'settings')?.value).toEqual({})
    expect(restricted.documents.find(document => document.kind === 'profile')?.value).toEqual({ name: 'web', customPlugins: [] })
    await expect(new MaterializedMigrationOwnerStateSource(paths, uid).read()).rejects.toThrow()
  })
  it('rejects invalid owners, generations, object shapes, and incomplete workspace state', async () => {
    expect(() => new MigrationOwnerStateApplicator(-1)).toThrow(/owner_invalid/u)
    for (const value of [null, [], 'object']) expect(() => migrationOwnerStateObject(value)).toThrow(/state_invalid/u)
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-input-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await expect(applicator.apply(root, 0, state())).rejects.toThrow(/generation_invalid/u)
    await expect(applicator.inspectExisting(root, 0)).rejects.toThrow(/generation_invalid/u)

    const incomplete = state()
    const incompleteState = {
      ...incomplete,
      documents: incomplete.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { grants: ['/workspace'] } }
        : document),
    }
    await expect(applicator.apply(root, 5, incompleteState)).rejects.toThrow(/workspace_incomplete/u)

    const wrongUnit = state()
    const wrongUnitState = {
      ...wrongUnit,
      documents: wrongUnit.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { ...(document.value as object), storage: {
          unit: { name: 'other', version: 2 }, tables: { workspaces: {} },
        } } }
        : document),
    }
    await expect(applicator.apply(root, 5, wrongUnitState)).rejects.toThrow(/state_invalid/u)
  })

  it('writes provider-owned strict YAML inputs under one immutable generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5)).resolves.toEqual(result)
    expect(JSON.parse(await readFile(result.settingsPath, 'utf8'))).toMatchObject({
      permission: { defaultPreset: 'workspace-write' },
    })
    expect(JSON.parse(await readFile(result.credentialsPath, 'utf8'))).toEqual({
      version: 1, refs: { DEEPSEEK_API_KEY: 'sk-private' }, records: {},
    })
    expect(JSON.parse(await readFile(join(result.storageRoot, 'workspace.json'), 'utf8'))).toMatchObject({
      unit: { name: 'workspace', version: 2 },
    })
    const sessions = join(root, 'sessions')
    await mkdir(sessions, { mode: 0o700 })
    const live = new MaterializedMigrationOwnerStateSource(result, uid)
    const exportSource = new FileJsonlMigrationExportSource(sessions, uid, live)
    const initialDigest = await exportSource.inventoryDigest()
    await writeFile(result.credentialsPath, '{"version":1,"refs":{"UPDATED":"value"},"records":{}}\n')
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).resolves.toEqual(result)
    expect(await readFile(result.credentialsPath, 'utf8')).toContain('UPDATED')
    const updated = await live.read()
    expect(updated.documents.find(document => document.kind === 'credentials')?.value).toMatchObject({
      refs: { UPDATED: 'value' },
    })
    expect(await exportSource.inventoryDigest()).not.toBe(initialDigest)
  })

  it('uses an empty workspace store when the validated grant list is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-empty-workspace-'))
    const source = state()
    const withoutStorage = {
      ...source,
      documents: source.documents.map(document => document.kind === 'workspace'
        ? { ...document, value: { grants: [] } }
        : document),
    }
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, withoutStorage)
    await expect(new MaterializedMigrationOwnerStateSource(result, uid).read()).resolves.toMatchObject({ version: 1 })
  })

  it('accepts an identical generation won by a concurrent publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-publish-race-'))
    const source = state()
    let competed = false
    const applicator = new MigrationOwnerStateApplicator(uid, async () => {
      if (competed) return
      competed = true
      await new MigrationOwnerStateApplicator(uid).apply(root, 5, source)
    })
    await expect(applicator.apply(root, 5, source)).resolves.toMatchObject({ generation: 5 })
    expect(competed).toBe(true)
  })

  it.each([
    ['non-private settings', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await chmod(result.settingsPath, 0o644)
    }],
    ['invalid settings YAML', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(result.settingsPath, '[\n')
    }],
    ['unexpected credential fields', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(result.credentialsPath, '{"version":1,"refs":{},"records":{},"extra":true}\n')
    }],
    ['wrong workspace unit', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"other","version":2},"tables":{"workspaces":{}}}\n')
    }],
    ['relative workspace grant', async (result: Awaited<ReturnType<MigrationOwnerStateApplicator['apply']>>) => {
      await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{"workspaces":{"one":{"path":"relative"}}}}\n')
    }],
  ])('rejects unsafe or malformed live owner state: %s', async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await mutate(result)
    await expect(new MaterializedMigrationOwnerStateSource(result, uid).read())
      .rejects.toThrow(/migration_owner_state_/u)
  })

  it('normalizes empty YAML and omitted credential/workspace maps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-empty-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await writeFile(result.settingsPath, 'null\n')
    await writeFile(result.credentialsPath, '{"version":1}\n')
    await writeFile(join(result.storageRoot, 'workspace.json'), '{"unit":{"name":"workspace","version":2},"tables":{}}\n')
    const loaded = await new MaterializedMigrationOwnerStateSource(result, uid).read()
    expect(loaded.documents.find(document => document.kind === 'settings')?.value).toEqual({})
    expect(loaded.documents.find(document => document.kind === 'credentials')?.value).toEqual({ refs: {}, records: {} })
    expect(loaded.documents.find(document => document.kind === 'workspace')?.value).toMatchObject({ grants: [] })
  })

  it('rejects owner state whose metadata changes while a bounded file is read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-race-live-'))
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await writeFile(result.settingsPath, JSON.stringify({ padding: 'x'.repeat(15 * 1024 * 1024) }))
    let touching = true
    let tick = 0
    const changes = (async () => {
      while (touching) {
        const changed = new Date(1_700_000_000_000 + tick++ * 1_000)
        await utimes(result.settingsPath, changed, changed)
      }
    })()
    try {
      await expect(new MaterializedMigrationOwnerStateSource(result, uid).read())
        .rejects.toThrow(/migration_owner_state_changed/u)
    } finally {
      touching = false
      await changes
    }
  })

  it('does not materialize a missing owner-state generation during existing-only inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-inspect-missing-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await expect(applicator.inspectExisting(root, 5)).rejects.toThrow()
    await expect(access(join(root, 'migration-owner-state'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing generation below an existing owner-state parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-inspect-generation-missing-'))
    await mkdir(join(root, 'migration-owner-state'), { mode: 0o700 })
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5))
      .rejects.toThrow(/migration_owner_state_missing/u)
  })

  it('rejects unsafe owner directories and generation files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-unsafe-'))
    await chmod(root, 0o755)
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).rejects.toThrow(/state_unsafe/u)
    await chmod(root, 0o700)
    const result = await new MigrationOwnerStateApplicator(uid).apply(root, 5, state())
    await chmod(result.settingsPath, 0o644)
    await expect(new MigrationOwnerStateApplicator(uid).inspectExisting(root, 5)).rejects.toThrow(/state_conflict/u)
  })

  it('propagates unsafe generation shapes and directory creation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-unsafe-shape-'))
    const parent = join(root, 'migration-owner-state')
    await mkdir(parent, { mode: 0o700 })
    await writeFile(join(parent, '5'), 'not a directory', { mode: 0o600 })
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).rejects.toThrow(/state_unsafe/u)

    const readOnly = await mkdtemp(join(tmpdir(), 'dsh-owner-state-read-only-'))
    await chmod(readOnly, 0o500)
    try {
      await expect(new MigrationOwnerStateApplicator(uid).apply(readOnly, 5, state())).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(readOnly, 0o700)
    }
  })

  it('reopens a secure legacy generation after its mutable owner documents diverge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-restart-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    const result = await applicator.apply(root, 5, state())
    await writeFile(result.settingsPath, '{"permission":{"defaultPreset":"read-only"}}\n')
    await expect(applicator.apply(root, 5, state('full-access'))).resolves.toEqual(result)
    expect(await readFile(result.settingsPath, 'utf8')).toContain('read-only')
  })

  it('rejects a malformed legacy generation seed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-invalid-seed-'))
    const applicator = new MigrationOwnerStateApplicator(uid)
    await applicator.apply(root, 5, state())
    await writeFile(join(root, 'migration-owner-state', '5', '.migration-seed.sha256'), 'invalid\n')
    await expect(applicator.apply(root, 5, state())).rejects.toThrow(/migration_owner_state_conflict/u)
  })

  it('never returns a partial generation after an injected crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-owner-state-crash-'))
    const applicator = new MigrationOwnerStateApplicator(uid, () => { throw new Error('injected_owner_state_crash') })
    await expect(applicator.apply(root, 5, state())).rejects.toThrow(/injected_owner_state_crash/u)
    await expect(new MigrationOwnerStateApplicator(uid).apply(root, 5, state())).resolves
      .toMatchObject({ generation: 5 })
  })
})
