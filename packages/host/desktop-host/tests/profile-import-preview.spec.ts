import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { FileOwnerJsonlMigrationGenerationTarget } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { compressZstdFrame } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { compareProfileImportInventory, inspectProfileImportInventory,
  type ProfileImportInventory } from '../src/profile-import-preview.ts'
import { stageSelectedProfileImportSessions } from '../src/profile-import-stage.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { BUNDLED_ARCHIVE_DIRECTORY, BundledPluginCatalog, bundledDependencySpec } from '../src/bundled-plugins.ts'
import { inspectProfileImportPluginArchives, lockfileResolutionMatches } from '../src/profile-import-plugin-trust.ts'

const uid = process.getuid?.() ?? 0
const ownerState: MigrationOwnerStateBundle = { version: 1, documents: [
  { kind: 'settings', schemaVersion: 1, value: {} },
  { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
  { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
  { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
] }

function fencedStage() {
  const sourceProfileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120'
  const targetProfileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121'
  const operationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
  const markers = new Map<string, Buffer>()
  const fence = new ProfileImportWorkerFence({
    read: id => markers.get(id), replace: (id, bytes) => { markers.set(id, bytes) },
  })
  fence.reservePair(sourceProfileId, targetProfileId, operationId)
  return { sourceProfileId, targetProfileId, operationId, fence, assertQuiescent: async () => {} }
}

async function profile(root: string, name: string, dependencies: Record<string, string>,
  sessions: readonly Readonly<{ id: string; createdAt: number; cwd?: string }>[]) {
  const profileRoot = join(root, name)
  const webRoot = join(profileRoot, 'profiles', 'web')
  await mkdir(webRoot, { recursive: true, mode: 0o700 })
  const manifestPath = join(webRoot, 'package.json')
  await writeFile(manifestPath, JSON.stringify({ dependencies }), { mode: 0o600 })
  if (Object.keys(dependencies).length > 0) {
    await writeFile(join(webRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', { mode: 0o600 })
  }
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
  await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  for (const session of sessions) {
    await target.importSession(1, { version: SESSION_FORMAT_VERSION, id: SessionId(session.id),
      createdAt: session.createdAt, isSeeded: false,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }) }, [])
  }
  return { profileRoot, manifestPath, target }
}

describe.skipIf(process.platform === 'win32')('Slark Profile import preview inventory', () => {
  it('rejects malformed lockfile evidence and invalid archive selections', async () => {
    const archive = Buffer.from('trusted archive')
    expect(lockfileResolutionMatches(null, 'alpha', 'file:alpha.tgz', '1.0.0', archive)).toBe(false)
    expect(lockfileResolutionMatches('lockfileVersion: 8\n', 'alpha', 'file:alpha.tgz', '1.0.0', archive)).toBe(false)
    expect(lockfileResolutionMatches('invalid: [', 'alpha', 'file:alpha.tgz', '1.0.0', archive)).toBe(false)
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-plugin-selection-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const valid = { ...source, uid, expectedSnapshotDigest: 'a'.repeat(64), selectedPluginNames: [] }
    for (const invalid of [
      { ...valid, profileRoot: 'relative' },
      { ...valid, uid: -1 },
      { ...valid, expectedSnapshotDigest: 'bad' },
      { ...valid, selectedPluginNames: ['alpha', 'alpha'] },
      { ...valid, selectedPluginNames: Array.from({ length: 129 }, (_, index) => `plugin-${index}`) },
    ]) {
      await expect(inspectProfileImportPluginArchives(invalid))
        .rejects.toThrow('profile_import_plugin_selection_invalid')
    }
  })

  it('keeps equal existing sessions and plugins out of the conflict set', () => {
    const source: ProfileImportInventory = { generation: 1, snapshotDigest: 'a'.repeat(64),
      sessions: [{ id: 'same-session', createdAt: 1, eventCount: 2,
        semanticDigest: 'c'.repeat(64), revision: 'v1' }],
      plugins: [{ name: 'same-plugin', sourceDigest: 'd'.repeat(64), version: '1.0.0' }] }
    const target: ProfileImportInventory = { ...source, snapshotDigest: 'b'.repeat(64) }
    const preview = compareProfileImportInventory(source, target)
    expect(preview.sessions.map(row => row.state)).toEqual(['same'])
    expect(preview.plugins.map(row => row.state)).toEqual(['same'])
    expect(() => compareProfileImportInventory({ ...source, snapshotDigest: 'invalid' }, target))
      .toThrow('profile_import_inventory_invalid')
  })

  it('verifies only catalog-matched source archives and refuses changed or linked bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-plugin-trust-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const bytes = Buffer.from('fixture plugin archive')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const source = await profile(root, 'source', { alpha: bundledDependencySpec(sha), beta: '2.0.0' }, [])
    const archiveDirectory = join(source.profileRoot, 'profiles', 'web', BUNDLED_ARCHIVE_DIRECTORY)
    await mkdir(archiveDirectory, { mode: 0o700 })
    const archive = join(archiveDirectory, `${sha}.tgz`)
    await writeFile(archive, bytes, { mode: 0o600 })
    const embedding = join(root, 'embedding')
    await mkdir(embedding, { mode: 0o700 })
    await writeFile(join(embedding, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [{
      name: 'alpha', version: '1.0.0', file: 'alpha.tgz', sha256: sha, entryIds: [],
      repository: 'https://example.com/alpha', sourceSha: 'a'.repeat(40),
    }] }), { mode: 0o600 })
    await writeFile(join(embedding, 'alpha.tgz'), bytes, { mode: 0o600 })
    const catalog = BundledPluginCatalog.load(embedding, uid)
    const inventory = await inspectProfileImportInventory({ ...source, uid })
    const input = { ...source, uid, catalog, expectedSnapshotDigest: inventory.snapshotDigest,
      selectedPluginNames: ['alpha', 'beta'] }
    expect(await inspectProfileImportPluginArchives(input)).toEqual([
      { name: 'alpha', status: 'archive_verified', archiveDigest: sha, lockfileResolutionVerified: false },
      { name: 'beta', status: 'source_unverified' },
    ])
    expect(await readFile(archive)).toEqual(bytes)
    expect(await readFile(join(embedding, 'alpha.tgz'))).toEqual(bytes)
    const spec = bundledDependencySpec(sha)
    const key = `alpha@${spec}`
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    await writeFile(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n'
      + `importers:\n  .:\n    dependencies:\n      alpha:\n        specifier: ${JSON.stringify(spec)}\n`
      + `        version: ${JSON.stringify(spec)}\npackages:\n  ${JSON.stringify(key)}:\n`
      + `    resolution:\n      integrity: ${integrity}\n      tarball: ${JSON.stringify(spec)}\n`
      + `    version: 1.0.0\nsnapshots:\n  ${JSON.stringify(key)}: {}\n`, { mode: 0o600 })
    await expect(inspectProfileImportPluginArchives(input)).rejects.toThrow('profile_import_inventory_changed')
    const locked = await inspectProfileImportInventory({ ...source, uid })
    const lockedInput = { ...input, expectedSnapshotDigest: locked.snapshotDigest }
    expect(await inspectProfileImportPluginArchives(lockedInput)).toEqual([
      { name: 'alpha', status: 'archive_verified', archiveDigest: sha, lockfileResolutionVerified: true },
      { name: 'beta', status: 'source_unverified' },
    ])
    await expect(inspectProfileImportPluginArchives({ ...input, expectedSnapshotDigest: 'f'.repeat(64) }))
      .rejects.toThrow('profile_import_inventory_changed')
    await expect(inspectProfileImportPluginArchives({ ...lockedInput, selectedPluginNames: ['missing'] }))
      .rejects.toThrow('profile_import_plugin_selection_invalid')
    await writeFile(archive, 'tampered', { mode: 0o600 })
    await expect(inspectProfileImportPluginArchives(lockedInput)).rejects.toThrow('profile_import_plugin_archive_mismatch')
    await unlink(archive)
    await symlink(join(embedding, 'alpha.tgz'), archive)
    await expect(inspectProfileImportPluginArchives(lockedInput)).rejects.toThrow('profile_import_plugin_archive_unsafe')
  })

  it('compares source and nonempty target without exposing session events or plugin source strings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', { alpha: '1.0.0', beta: '2.0.0' }, [
      { id: 'same-id', createdAt: 1, cwd: '/source' }, { id: 'new-id', createdAt: 3 },
    ])
    const target = await profile(root, 'target', { alpha: '2.0.0', gamma: '3.0.0' }, [
      { id: 'same-id', createdAt: 1, cwd: '/target' },
    ])
    const before = await Promise.all([readdir(source.profileRoot), readdir(target.profileRoot)])
    const sourceInventory = await inspectProfileImportInventory({ ...source, uid })
    const targetInventory = await inspectProfileImportInventory({ ...target, uid })
    const preview = compareProfileImportInventory(sourceInventory, targetInventory)
    expect(preview.sessions.map(item => [item.source.id, item.state])).toEqual([
      ['new-id', 'new'], ['same-id', 'conflict'],
    ])
    expect(preview.plugins.map(item => [item.source.name, item.source.version, item.state])).toEqual([
      ['alpha', '1.0.0', 'conflict'], ['beta', '2.0.0', 'new'],
    ])
    expect(JSON.stringify(preview)).not.toContain('credentials')
    expect(JSON.stringify(preview)).not.toContain('file:')
    expect(await Promise.all([readdir(source.profileRoot), readdir(target.profileRoot)])).toEqual(before)
    expect(compareProfileImportInventory(sourceInventory, targetInventory).previewDigest).toBe(preview.previewDigest)
    await writeFile(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'),
      'lockfileVersion: 9\n# changed resolution\n', { mode: 0o600 })
    const changedSource = await inspectProfileImportInventory({ ...source, uid })
    expect(changedSource.plugins[0]?.sourceDigest).not.toBe(sourceInventory.plugins[0]?.sourceDigest)
    await writeFile(target.manifestPath, JSON.stringify({ dependencies: { alpha: '1.0.0' } }), { mode: 0o600 })
    const changedTarget = await inspectProfileImportInventory({ ...target, uid })
    expect(changedTarget.snapshotDigest).not.toBe(targetInventory.snapshotDigest)
  })

  it('rejects an unsafe plugin manifest and a changing persistence snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const existingManifest = await readFile(source.manifestPath)
    await unlink(source.manifestPath)
    const replacement = join(root, 'replacement.json')
    await writeFile(replacement, existingManifest, { mode: 0o600 })
    await symlink(replacement, source.manifestPath)
    await expect(inspectProfileImportInventory({ ...source, uid })).rejects.toThrow()
    await unlink(source.manifestPath)
    await writeFile(source.manifestPath, existingManifest, { mode: 0o600 })
    const inspect = vi.spyOn(source.target, 'inspectExistingPersistence')
    const actual = await source.target.inspectExistingPersistence()
    inspect.mockResolvedValueOnce(actual).mockResolvedValueOnce({ ...actual, inventoryDigest: 'a'.repeat(64) })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_changed')
  })

  it('uses the managed bundle roster instead of counting runtime dependencies as plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-bundles-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', { alpha: '1.0.0', 'runtime-library': '2.0.0' }, [])
    await writeFile(source.manifestPath, JSON.stringify({
      dependencies: { alpha: '1.0.0', 'runtime-library': '2.0.0' },
      dsh: { profile: { bundles: ['alpha'] } },
    }), { mode: 0o600 })
    expect((await inspectProfileImportInventory({ ...source, uid })).plugins.map(item => item.name))
      .toEqual(['alpha'])
    await writeFile(source.manifestPath, JSON.stringify({
      dependencies: { alpha: '1.0.0' }, dsh: { profile: { bundles: ['alpha', 'missing-plugin'] } },
    }), { mode: 0o600 })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_manifest_invalid')
    await writeFile(source.manifestPath, JSON.stringify({
      dependencies: { alpha: '1.0.0' }, dsh: { profile: { bundles: ['alpha', 'alpha'] } },
    }), { mode: 0o600 })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_manifest_invalid')
    await writeFile(source.manifestPath, JSON.stringify({ dependencies: { alpha: '1.0.0' } }), { mode: 0o600 })
    await unlink(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'))
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_manifest_invalid')
  })

  it('reports a missing generation owner record as an invalid inventory without creating a replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const active = await source.target.activePersistenceConfig()
    const ownerRecord = join(active.root, 'owner-state.json')
    await unlink(ownerRecord)
    const before = await readdir(active.root)
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_invalid')
    expect(await readdir(active.root)).toEqual(before)
  })

  it('rejects malformed old manifests and unsafe roots without changing their bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-invalid-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const invalid = [
      '{', 'null', '[]', '{}',
      JSON.stringify({ dependencies: [] }),
      JSON.stringify({ dependencies: {}, dsh: [] }),
      JSON.stringify({ dependencies: {}, dsh: { profile: [] } }),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: 'alpha' } } }),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [42] } } }),
    ]
    for (const manifest of invalid) {
      await writeFile(source.manifestPath, manifest, { mode: 0o600 })
      await expect(inspectProfileImportInventory({ ...source, uid }))
        .rejects.toThrow('profile_import_manifest_invalid')
      expect(await readFile(source.manifestPath, 'utf8')).toBe(manifest)
    }
    await writeFile(source.manifestPath, JSON.stringify({ dependencies: {}, dsh: {} }), { mode: 0o600 })
    expect((await inspectProfileImportInventory({ ...source, uid })).plugins).toEqual([])
    await unlink(source.manifestPath)
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_manifest_invalid')
    await writeFile(source.manifestPath, JSON.stringify({ dependencies: Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`plugin-${index}`, '1.0.0'])) }), { mode: 0o600 })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_too_large')
    await writeFile(join(source.profileRoot, 'profiles', 'web', 'pnpm-lock.yaml'),
      'lockfileVersion: 9\n', { mode: 0o600 })
    for (const dependencies of [{ 'INVALID!': '1.0.0' }, { alpha: 42 }]) {
      await writeFile(source.manifestPath, JSON.stringify({ dependencies }), { mode: 0o600 })
      await expect(inspectProfileImportInventory({ ...source, uid }))
        .rejects.toThrow('profile_import_manifest_invalid')
    }
    await writeFile(source.manifestPath, JSON.stringify({ dependencies: {} }), { mode: 0o600 })
    await expect(inspectProfileImportInventory({ ...source, profileRoot: 'relative', uid }))
      .rejects.toThrow('profile_import_inventory_invalid')
    await chmod(source.profileRoot, 0o777)
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_unsafe')
    await chmod(source.profileRoot, 0o700)
    const inspect = vi.spyOn(source.target, 'inspectExistingPersistence')
    inspect.mockRejectedValueOnce(Error('migration_generation_corrupt'))
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_invalid')
    inspect.mockRejectedValueOnce(Error('unexpected_inventory_failure'))
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('unexpected_inventory_failure')
    expect(await source.target.activeGeneration()).toBe(1)
  })

  it('bounds a decoded historical Session inventory before returning any preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-limit-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const before = await readFile(source.manifestPath)
    const scan = vi.spyOn(FileJsonlMigrationExportSource.prototype, 'listImportInventory')
      .mockResolvedValueOnce(Array.from({ length: 10_001 }, (_, index) => ({
        id: `session-${index}`, createdAt: index, eventCount: 0,
        semanticDigest: 'a'.repeat(64), revision: 'v1',
      })))
    onTestFinished(() => { scan.mockRestore() })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_too_large')
    expect(await readFile(source.manifestPath)).toEqual(before)
    expect(await source.target.activeGeneration()).toBe(1)
  })

  it('keeps owner-state reads unavailable during the read-only import preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-owner-state-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const scan = vi.spyOn(FileJsonlMigrationExportSource.prototype, 'listImportInventory')
      .mockImplementationOnce(async function (this: FileJsonlMigrationExportSource) {
        await this.readOwnerState()
        return []
      })
    onTestFinished(() => { scan.mockRestore() })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_owner_state_unavailable')
  })

  it('previews a released V3 compressed generation without modifying its bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-preview-v3-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const active = await source.target.activePersistenceConfig()
    const session = join(active.root, 'project', 'req0002-old-writer-history')
    await mkdir(session, { recursive: true, mode: 0o700 })
    const bytes = await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v3-old-writer.jsonl.zstd', import.meta.url))
    const log = join(session, 'session.v3.jsonl.zstd')
    await writeFile(log, bytes, { mode: 0o600 })
    const predecessor = join(session, 'session.jsonl.zstd')
    const predecessorBytes = await compressZstdFrame(JSON.stringify({
      type: 'session', version: 0, id: 'req0002-old-writer-history', createdAt: 1, delegationDepth: 0,
    }) + '\n')
    await writeFile(predecessor, predecessorBytes, { mode: 0o600 })
    const inventory = await inspectProfileImportInventory({ ...source, uid })
    expect(inventory.sessions).toMatchObject([{ id: 'req0002-old-writer-history' }])
    expect(await readFile(log)).toEqual(bytes)
    expect(await readFile(predecessor)).toEqual(predecessorBytes)
    const corruptSuccessor = join(session, 'session.v4.jsonl.zstd')
    await writeFile(corruptSuccessor, 'corrupt successor', { mode: 0o600 })
    await expect(inspectProfileImportInventory({ ...source, uid }))
      .rejects.toThrow('profile_import_inventory_invalid')
    expect(await readFile(log)).toEqual(bytes)
    expect(await readFile(predecessor)).toEqual(predecessorBytes)
  })
})

describe.skipIf(process.platform === 'win32')('inactive Profile import session stage', () => {
  it('preserves existing target sessions and owner state while adding only selected new sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-stage-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [
      { id: 'new-id', createdAt: 3 }, { id: 'unselected-id', createdAt: 4 },
    ])
    const target = await profile(root, 'target', {}, [{ id: 'existing-id', createdAt: 1 }])
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ ...source, uid }),
      await inspectProfileImportInventory({ ...target, uid }),
    )
    const staged = await stageSelectedProfileImportSessions({ ...fencedStage(), source, target, uid,
      expectedPreviewDigest: preview.previewDigest, selectedSessionIds: ['new-id'],
    })
    expect(staged.stagedSessionCount).toBe(2)
    expect(await target.target.activeGeneration()).toBe(1)
    expect(JSON.parse(await readFile(join(target.target.generationRoot(staged.generation), 'owner-state.json'), 'utf8')))
      .toEqual(ownerState)
    expect((await inspectProfileImportInventory({ ...target, uid })).snapshotDigest)
      .toBe(preview.targetSnapshotDigest)
    const logs = await readdir(target.target.generationRoot(staged.generation), { recursive: true })
    expect(logs.some(name => name.includes('existing-id'))).toBe(true)
    expect(logs.some(name => name.includes('new-id'))).toBe(true)
    expect(logs.some(name => name.includes('unselected-id'))).toBe(false)
    await target.target.abortGeneration(staged.generation)
  })

  it('rejects a stale preview and conflicting selection before staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-stage-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [{ id: 'same-id', createdAt: 2 }])
    const target = await profile(root, 'target', {}, [{ id: 'same-id', createdAt: 1 }])
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ ...source, uid }),
      await inspectProfileImportInventory({ ...target, uid }),
    )
    const base = { ...fencedStage(), source, target, uid, selectedSessionIds: ['same-id'] }
    await expect(stageSelectedProfileImportSessions({ ...base, expectedPreviewDigest: '0'.repeat(64) }))
      .rejects.toThrow('profile_import_inventory_changed')
    await expect(stageSelectedProfileImportSessions({ ...base, expectedPreviewDigest: preview.previewDigest }))
      .rejects.toThrow('profile_import_selection_invalid')
    const released = fencedStage()
    released.fence.clearPair(released.sourceProfileId, released.targetProfileId, released.operationId)
    await expect(stageSelectedProfileImportSessions({ ...base, ...released,
      expectedPreviewDigest: preview.previewDigest })).rejects.toThrow(/conflict/u)
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
  })

  it('removes an inactive generation if the source changes during staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-stage-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [{ id: 'new-id', createdAt: 2 }])
    const target = await profile(root, 'target', {}, [{ id: 'existing-id', createdAt: 1 }])
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ ...source, uid }),
      await inspectProfileImportInventory({ ...target, uid }),
    )
    let calls = 0
    await expect(stageSelectedProfileImportSessions({ ...fencedStage(), source, target, uid,
      expectedPreviewDigest: preview.previewDigest, selectedSessionIds: ['new-id'],
      assertQuiescent: async () => {
        calls += 1
        if (calls === 4) await writeFile(source.manifestPath, JSON.stringify({ dependencies: {}, changed: true }), { mode: 0o600 })
      },
    })).rejects.toThrow('profile_import_inventory_changed')
    expect(await target.target.activeGeneration()).toBe(1)
    expect(await readdir(join(target.profileRoot, 'persistence', 'generations'))).toEqual(['1'])
  })

  it('stages a released compressed V3 session while retaining its source bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-stage-v3-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const target = await profile(root, 'target', {}, [{ id: 'existing-id', createdAt: 1 }])
    const sourceActive = await source.target.activePersistenceConfig()
    const fixture = await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v3-old-writer.jsonl.zstd', import.meta.url))
    const fixturePath = join(sourceActive.root, 'project', 'req0002-old-writer-history', 'session.v3.jsonl.zstd')
    await mkdir(join(sourceActive.root, 'project', 'req0002-old-writer-history'), { recursive: true, mode: 0o700 })
    await writeFile(fixturePath, fixture, { mode: 0o600 })
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ ...source, uid }),
      await inspectProfileImportInventory({ ...target, uid }),
    )
    const staged = await stageSelectedProfileImportSessions({ ...fencedStage(), source, target, uid,
      expectedPreviewDigest: preview.previewDigest, selectedSessionIds: ['req0002-old-writer-history'],
    })
    expect(staged.stagedSessionCount).toBe(2)
    expect(await readFile(fixturePath)).toEqual(fixture)
    expect(await target.target.activeGeneration()).toBe(1)
    await target.target.abortGeneration(staged.generation)
  })

  it('stages a physical V4 session written by the released rc.2 backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-import-stage-v4-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = await profile(root, 'source', {}, [])
    const target = await profile(root, 'target', {}, [{ id: 'existing-id', createdAt: 1 }])
    const sourceActive = await source.target.activePersistenceConfig()
    const fixture = await readFile(new URL('../../../session/session-persistence-jsonl/tests/fixtures/released-v4-rc2-writer.jsonl', import.meta.url))
    const directory = join(sourceActive.root, '_no-cwd', 'req0022-released-v4')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const fixturePath = join(directory, 'session.v4.jsonl')
    await writeFile(fixturePath, fixture, { mode: 0o600 })
    const preview = compareProfileImportInventory(
      await inspectProfileImportInventory({ ...source, uid }),
      await inspectProfileImportInventory({ ...target, uid }),
    )
    expect(preview.sessions).toMatchObject([{ state: 'new', source: { id: 'req0022-released-v4', eventCount: 6 } }])
    const staged = await stageSelectedProfileImportSessions({ ...fencedStage(), source, target, uid,
      expectedPreviewDigest: preview.previewDigest, selectedSessionIds: ['req0022-released-v4'],
    })
    expect(staged.stagedSessionCount).toBe(2)
    expect(await readFile(fixturePath)).toEqual(fixture)
    expect(await target.target.activeGeneration()).toBe(1)
    await target.target.abortGeneration(staged.generation)
  })
})
