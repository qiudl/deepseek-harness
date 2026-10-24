import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { create as createArchive, Header } from 'tar'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { verifyCopiedBundledPlugin } from '../src/bundled-plugin-recovery.ts'
import { compareProfileImportInventory, inspectProfileImportInventory } from '../src/profile-import-preview.ts'
import { inspectProfileImportPluginArchives } from '../src/profile-import-plugin-trust.ts'
import { planSelectedProfileImportPlugins } from '../src/profile-import-plugin-plan.ts'
import { inspectStagedProfileImportPluginArchives, stageSelectedProfileImportPluginArchives } from '../src/profile-import-plugin-stage.ts'
import { FileProfileImportOperationJournal } from '../src/profile-import-operation-journal.ts'
import { inspectIsolatedProfileImportPluginInstall, installStagedProfileImportPluginsInIsolation } from '../src/profile-import-plugin-isolated-install.ts'
import { planProfileImportPluginTargetManifest } from '../src/profile-import-plugin-target-manifest.ts'
import { inspectResolvedProfileImportTargetPluginsInIsolation, resolveProfileImportTargetPluginsInIsolation } from '../src/profile-import-plugin-target-resolution.ts'
import { inspectResolvedProfileImportTargetPluginLayer, installResolvedProfileImportTargetPlugins } from '../src/profile-import-plugin-target-install.ts'
import { inspectProfileImportPluginComposition } from '../src/profile-import-plugin-composition.ts'
import { inspectProfileImportPluginDirectoryState, inspectStagedProfileImportPluginPublishCandidate,
  planProfileImportPluginPublish,
  stageProfileImportPluginPublishCandidate } from '../src/profile-import-plugin-publish-plan.ts'
import { FileProfileImportPluginPublishJournal,
  inspectProfileImportPluginPublishRecovery } from '../src/profile-import-plugin-publish-journal.ts'
import { publishProfileImportPluginLayer, rollbackProfileImportPluginLayer } from '../src/profile-import-plugin-publisher.ts'
import { acquireSingleHostLock } from '../src/single-instance.ts'
import { inspectPreparedProfileImportPlugins,
  prepareSelectedProfileImportPlugins } from '../src/profile-import-plugin-preparation.ts'
import { ProfileImportWorkerFence } from '../src/profile-import-worker-fence.ts'
import { stageSelectedProfileImportSessions } from '../src/profile-import-stage.ts'
import { ProfileImportSessionCoordinator } from '../src/profile-import-session-coordinator.ts'
import { FileProfileImportCandidateLease } from '../src/profile-import-candidate-lease.ts'
import { FileProfileImportRuntimePatch } from '../src/profile-import-runtime-patch.ts'

const readFaults = vi.hoisted(() => new Map<string, 'short' | 'changed' | 'manyEntries'>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args)
    const fault = readFaults.get(String(args[0]))
    if (fault === 'short') vi.spyOn(handle, 'read').mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) })
    if (fault === 'changed') {
      const original = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(() => original()).mockImplementationOnce(async () => {
        const stat = await original()
        stat.mtimeMs += 1
        return stat
      })
    }
    return handle
  }
  const readdir = async (...args: Parameters<typeof actual.readdir>) => {
    const entries = await actual.readdir(...args)
    if (readFaults.get(String(args[0])) === 'manyEntries') {
      const file = entries.find(entry => entry.isFile())!
      return Array.from({ length: 8193 }, () => file)
    }
    return entries
  }
  return { ...actual, open, readdir }
})
import {
  FileOwnerJsonlMigrationGenerationTarget,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import type { MigrationOwnerStateBundle } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { MigrationOwnerStateApplicator } from '../src/migration-owner-state-applicator.ts'
import {
  existingProfilePatch,
  OfflineProfileRecoveryInspector,
  packagedRuntimeAppRoot,
} from '../src/offline-profile-recovery.ts'
import type { PersonProfileRecord } from '../src/types.ts'
import { BundledPluginCatalog, bundledDependencySpec } from '../src/bundled-plugins.ts'

const uid = process.getuid?.() ?? 0
const profileId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150'
const installationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3151'
const ownerState: MigrationOwnerStateBundle = {
  version: 1,
  documents: [
    { kind: 'settings', schemaVersion: 1, value: {} },
    { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
    { kind: 'workspace', schemaVersion: 1, value: { grants: [] } },
    { kind: 'profile', schemaVersion: 1, value: { name: 'web', customPlugins: [] } },
  ],
}

function profile(): PersonProfileRecord {
  return {
    profileId: profileId as PersonProfileRecord['profileId'], kind: 'account',
    personIndex: 'person-index', keyHandle: 'keychain:fixture', unlockVerifier: 'verifier',
    accountBindings: [], bindingGeneration: 3, createdAt: 1,
  }
}

async function fixture(externalRuntime = false) {
  // Keep the root short enough for macOS's 104-byte Unix-domain socket limit.
  const hostRoot = await realpath(await mkdtemp(join(tmpdir(), 'd-')))
  onTestFinished(async () => { await rm(hostRoot, { recursive: true, force: true }) })
  const profileRoot = join(hostRoot, 'profiles', profileId)
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
  const target = new FileOwnerJsonlMigrationGenerationTarget(join(profileRoot, 'persistence'), uid, 1)
  const persistence = await target.activePersistenceConfig()
  await target.importOwnerState(1, ownerState)
  const ownerStateApplicator = new MigrationOwnerStateApplicator(uid)
  const ownerPaths = await ownerStateApplicator.apply(profileRoot, 1, ownerState)
  await writeFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot, persistence, ownerPaths), { mode: 0o600 })
  const web = join(profileRoot, 'profiles', 'web')
  await mkdir(join(web, 'node_modules'), { recursive: true, mode: 0o700 })
  await writeFile(join(web, 'package.json'), `${JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } })}\n`)
  await writeFile(join(web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const currentRuntime = join(hostRoot, 'current', 'dsh-runtime', 'app')
  const legacyRuntime = join(hostRoot, 'legacy', 'dsh-runtime', 'app')
  const dependency = join(externalRuntime ? legacyRuntime : currentRuntime, 'node_modules', 'fixture-plugin')
  await mkdir(dependency, { recursive: true, mode: 0o700 })
  await symlink(dependency, join(web, 'node_modules', 'fixture-plugin'))
  const inspector = new OfflineProfileRecoveryInspector({
    hostRoot, installationId, expectedUid: uid, currentRuntimeAppRoot: currentRuntime,
    targetFor: () => target, ownerStateApplicator,
  })
  return { hostRoot, profileRoot, inspector, target, ownerStateApplicator, currentRuntime, legacyRuntime, web, persistence, ownerPaths }
}

async function releasedPatch(value: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  // Captured from the signed 0.1.6-alpha.2 baseline; only absolute paths are substituted.
  let text = await readFile(new URL('./fixtures/released-owner-settings.patch.yml', import.meta.url), 'utf8')
  const paths = {
    profileRoot: value.profileRoot, persistenceRoot: value.persistence.root,
    storageRoot: value.ownerPaths.storageRoot, settingsPath: value.ownerPaths.settingsPath,
    credentialsPath: value.ownerPaths.credentialsPath,
  }
  for (const [name, path] of Object.entries(paths)) text = text.replaceAll(`"{{${name}}}"`, JSON.stringify(path))
  return text
}

const bundledFiles = {
  'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', bundledDependencies: ['nested'] }),
  'index.js': 'export const fixture = true\n',
  'empty.js': '',
  'node_modules/nested/package.json': JSON.stringify({ name: 'nested', version: '1.0.0' }),
  'node_modules/nested/index.js': 'export const nested = true\n',
}

const runtimeBundledFiles = { ...bundledFiles,
  'package.json': JSON.stringify({ name: 'fixture-plugin', version: '1.0.0',
    bundledDependencies: ['nested'], dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  'cordis.patch.yml': '- insert:\n    - id: fixture-entry\n      name: fixture-plugin\n',
}

async function bundledFixture(archiveBytes?: Buffer, files = bundledFiles, withNewerVersion = false,
  entryIds: string[] = []) {
  const value = await fixture()
  const installed = join(value.web, 'node_modules', 'fixture-plugin')
  await unlink(installed)
  const source = join(value.hostRoot, 'archive-source')
  for (const [path, content] of Object.entries(files)) {
    for (const root of [join(source, 'package'), installed]) {
      await mkdir(join(root, path, '..'), { recursive: true, mode: 0o700 })
      await writeFile(join(root, path), content, { mode: 0o600 })
    }
  }
  const embedding = join(value.hostRoot, 'bundled')
  await mkdir(embedding, { mode: 0o700 })
  const archive = join(embedding, 'fixture.tgz')
  if (archiveBytes) await writeFile(archive, archiveBytes)
  else await createArchive({ gzip: true, cwd: source, file: archive }, ['package'])
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  const historical = {
    name: 'fixture-plugin', version: '1.0.0', file: 'fixture.tgz', sha256: digest,
    repository: 'https://example.com/fixture', sourceSha: 'a'.repeat(40), entryIds,
  }
  let newer: typeof historical | undefined
  if (withNewerVersion) {
    await writeFile(join(source, 'package', 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '2.0.0' }))
    const currentArchive = join(embedding, 'fixture-2.tgz')
    await createArchive({ gzip: true, cwd: source, file: currentArchive }, ['package'])
    newer = { ...historical, version: '2.0.0', file: 'fixture-2.tgz',
      sha256: createHash('sha256').update(await readFile(currentArchive)).digest('hex') }
  }
  await writeFile(join(embedding, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1,
    plugins: newer ? [newer, historical] : [historical] }))
  await mkdir(join(value.web, '.bundled-plugins'), { mode: 0o700 })
  await writeFile(join(value.web, '.bundled-plugins', `${digest}.tgz`), await readFile(archive), { mode: 0o600 })
  await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': bundledDependencySpec(digest) } }))
  const options = {
    hostRoot: value.hostRoot, installationId, expectedUid: uid, currentRuntimeAppRoot: value.currentRuntime,
    targetFor: () => value.target, ownerStateApplicator: value.ownerStateApplicator,
    bundledCatalog: BundledPluginCatalog.load(embedding, uid),
  }
  return { ...value, installed, archive, digest, inspector: new OfflineProfileRecoveryInspector(options), files,
    catalog: options.bundledCatalog }
}

function verifyBundle(value: Awaited<ReturnType<typeof bundledFixture>>) {
  return verifyCopiedBundledPlugin(value.catalog, value.catalog.get('fixture-plugin', '1.0.0')!, value.web, uid)
}

async function pluginPlanFixture(runtime = false) {
  const source = await bundledFixture(undefined, runtime ? runtimeBundledFiles : bundledFiles,
    false, runtime ? ['fixture-entry'] : [])
  const target = await fixture()
  await writeFile(join(target.web, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
  await unlink(join(target.web, 'node_modules', 'fixture-plugin'))
  const spec = bundledDependencySpec(source.digest)
  const key = `fixture-plugin@${spec}`
  const integrity = `sha512-${createHash('sha512').update(await readFile(source.archive)).digest('base64')}`
  await writeFile(join(source.web, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\n'
    + `importers:\n  .:\n    dependencies:\n      fixture-plugin:\n        specifier: ${JSON.stringify(spec)}\n`
    + `        version: ${JSON.stringify(spec)}\npackages:\n  ${JSON.stringify(key)}:\n`
    + `    resolution:\n      integrity: ${integrity}\n      tarball: ${JSON.stringify(spec)}\n`
    + `    version: 1.0.0\nsnapshots:\n  ${JSON.stringify(key)}: {}\n`, { mode: 0o600 })
  const sourceProfileId = randomUUID(); const targetProfileId = randomUUID(); const operationId = randomUUID()
  const markers = new Map<string, Buffer>()
  const fence = new ProfileImportWorkerFence({ read: id => markers.get(id),
    replace: (id, bytes) => { markers.set(id, bytes) } })
  fence.reservePair(sourceProfileId, targetProfileId, operationId)
  const sourceProfile = { profileId: sourceProfileId, profileRoot: source.profileRoot, target: source.target }
  const targetProfile = { profileId: targetProfileId, profileRoot: target.profileRoot, target: target.target }
  const inspect = async () => compareProfileImportInventory(
    await inspectProfileImportInventory({ ...sourceProfile, uid }),
    await inspectProfileImportInventory({ ...targetProfile, uid }))
  const preview = await inspect()
  const input = { source: sourceProfile, target: targetProfile, uid, operationId, fence,
    catalog: source.catalog, expectedPreviewDigest: preview.previewDigest,
    selectedPluginNames: ['fixture-plugin'], composedEntryIds: () => new Set<string>(),
    assertQuiescent: async () => {} }
  return { source, target, input, inspect }
}

function unsafeArchive(path: string, type: 'File' | 'SymbolicLink' | 'CharacterDevice' | 'ExtendedHeader' = 'File', size = 1, includeBase = true): Buffer {
  const valid: Buffer[] = []
  for (const [name, content] of Object.entries(includeBase ? bundledFiles : {})) {
    const data = Buffer.from(content)
    const header = new Header({ path: `package/${name}`, type: 'File', size: data.length, mode: 0o600, uid, gid: uid })
    const block = Buffer.alloc(512)
    header.encode(block)
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512)
    data.copy(padded)
    valid.push(block, padded)
  }
  const header = new Header({ path, type, size, mode: 0o600, uid, gid: uid,
    ...(type === 'SymbolicLink' ? { linkpath: 'index.js' } : {}) })
  const block = Buffer.alloc(512)
  header.encode(block)
  return gzipSync(Buffer.concat([...valid, block, Buffer.alloc(512), Buffer.alloc(1024)]))
}

async function treeInventory(root: string): Promise<unknown[]> {
  const result: unknown[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const stat = await lstat(path)
      result.push([path, stat.mode, stat.size, stat.mtimeMs, stat.isFile()
        ? createHash('sha256').update(await readFile(path)).digest('hex') : null])
      if (stat.isDirectory()) await visit(path)
    }
  }
  await visit(root)
  return result
}

describe('offline Profile existing-only inspector', () => {
  async function releasedEmptyProfile() {
    const value = await fixture()
    await rm(join(value.web, 'node_modules'), { recursive: true })
    await unlink(join(value.web, 'pnpm-lock.yaml'))
    // Signed macOS 0.4.23 layout; the anonymous package name carries no identity.
    const manifest = await readFile(new URL('./fixtures/released-empty-profile.package.json', import.meta.url))
    await writeFile(join(value.web, 'package.json'), manifest)
    return value
  }

  it('recovers the released empty-plugin Profile without creating a lockfile', async () => {
    const value = await releasedEmptyProfile()
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 0 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('previews the released empty-plugin Profile with installation-owned web bundles', async () => {
    const value = await releasedEmptyProfile()
    const before = await treeInventory(value.profileRoot)
    const inventory = await inspectProfileImportInventory({ profileRoot: value.profileRoot,
      target: value.target, uid })
    expect(inventory.plugins).toEqual([])
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('binds lockfile absence separately from a subsequently installed lockfile', async () => {
    const value = await releasedEmptyProfile()
    const absent = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const before = await treeInventory(value.profileRoot)
    const installed = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(installed.preflightDigest).not.toBe(absent.preflightDigest)
    await expect(value.inspector.prepareConfirmedProfile(profile(), absent))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each(['node_modules', '.bundled-plugins'])('rejects a missing lock with retained %s installation state', async (name) => {
    const value = await releasedEmptyProfile()
    await mkdir(join(value.web, name), { mode: 0o700 })
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each([[], null, { 'fixture-plugin': '1.0.0' }])('rejects a missing lock with invalid or nonempty dependencies: %j', async (dependencies) => {
    const value = await releasedEmptyProfile()
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies }))
    const before = await treeInventory(value.profileRoot)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each([
    unsafeArchive('package/../outside'), unsafeArchive('/package/index.js'),
    unsafeArchive('package/index.js'),
    unsafeArchive('package/node_modules/link', 'SymbolicLink', 0),
    unsafeArchive('package/device', 'CharacterDevice', 0),
    unsafeArchive('package/huge', 'File', 128 * 1024 * 1024 + 1),
    unsafeArchive('package/truncated', 'File', 4096),
    unsafeArchive('package/meta', 'ExtendedHeader', 65537),
    Buffer.from('invalid archive'),
    unsafeArchive('package/index.js', 'File', 1, false),
  ])('rejects an unsafe archive even when its digest is catalog-pinned %#', async (archive) => {
    const value = await bundledFixture(archive)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('bounds copied package enumeration even if the filesystem keeps returning entries', async () => {
    const value = await bundledFixture()
    readFaults.set(value.installed, 'manyEntries')
    onTestFinished(() => { readFaults.delete(value.installed) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['short', 'changed'] as const)('rejects a plugin file with a %s read', async (fault) => {
    const value = await bundledFixture()
    const path = join(value.installed, 'index.js')
    readFaults.set(path, fault)
    onTestFinished(() => { readFaults.delete(path) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it.each(['file-mode', 'directory-mode', 'archive-directory-mode', 'extra-directory'])
  ('rejects unsafe copied package metadata: %s', async (kind) => {
    const value = await bundledFixture()
    if (kind === 'file-mode') await chmod(join(value.installed, 'index.js'), 0o666)
    if (kind === 'directory-mode') await chmod(value.installed, 0o777)
    if (kind === 'archive-directory-mode') await chmod(join(value.web, '.bundled-plugins'), 0o777)
    if (kind === 'extra-directory') await mkdir(join(value.installed, 'extra'), { mode: 0o700 })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects an archive whose package identity does not match the catalog', async () => {
    const value = await bundledFixture(undefined, { ...bundledFiles,
      'package.json': JSON.stringify({ name: 'other-plugin', version: '1.0.0' }) })
    await expect(verifyBundle(value)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recovers copied catalog plugins including bundled nested dependencies without writing Profile files', async () => {
    const value = await bundledFixture()
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    for (const [path, content] of Object.entries(value.files)) {
      expect(await readFile(join(value.installed, path), 'utf8')).toBe(content)
    }
    await expect(readFile(join(value.profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it('proves copied legacy installation bytes for import, and rejects later tampering', async () => {
    const value = await bundledFixture()
    const before = await treeInventory(value.profileRoot)
    const inventory = await inspectProfileImportInventory({ profileRoot: value.profileRoot, target: value.target, uid })
    const input = { profileRoot: value.profileRoot, target: value.target, uid,
      expectedSnapshotDigest: inventory.snapshotDigest, selectedPluginNames: ['fixture-plugin'], catalog: value.catalog }
    expect(await inspectProfileImportPluginArchives(input)).toEqual([
      { name: 'fixture-plugin', status: 'installed_verified', archiveDigest: value.digest,
        lockfileResolutionVerified: false },
    ])
    expect(await treeInventory(value.profileRoot)).toEqual(before)
    await writeFile(join(value.installed, 'index.js'), 'tampered', { mode: 0o600 })
    await expect(inspectProfileImportPluginArchives(input)).rejects.toThrow('profile_import_plugin_install_unsafe')
  })

  it('plans only an installed archive with a matching direct lockfile resolution without writing either Profile', async () => {
    const value = await pluginPlanFixture()
    const beforeSource = await treeInventory(value.source.profileRoot)
    const beforeTarget = await treeInventory(value.target.profileRoot)
    expect(await planSelectedProfileImportPlugins(value.input)).toMatchObject({
      plugins: [{ name: 'fixture-plugin', version: '1.0.0', archiveDigest: value.source.digest, entryIds: [] }],
    })
    expect(await treeInventory(value.source.profileRoot)).toEqual(beforeSource)
    expect(await treeInventory(value.target.profileRoot)).toEqual(beforeTarget)
  })

  it('rejects empty, repeated, or oversized plugin selections before reading either Profile', async () => {
    const value = await pluginPlanFixture()
    for (const selectedPluginNames of [[], ['fixture-plugin', 'fixture-plugin'],
      Array.from({ length: 129 }, (_, index) => `plugin-${index}`)]) {
      await expect(planSelectedProfileImportPlugins({ ...value.input, selectedPluginNames }))
        .rejects.toThrow('profile_import_plugin_selection_invalid')
    }
  })

  it('rejects a selected plugin whose entry conflicts with the target composition', async () => {
    const value = await pluginPlanFixture(true)
    await expect(planSelectedProfileImportPlugins({ ...value.input,
      composedEntryIds: () => new Set(['fixture-entry']) }))
      .rejects.toThrow('profile_import_plugin_entry_conflict')
    await expect(planSelectedProfileImportPlugins({ ...value.input,
      composedEntryIds: () => new Set([123 as unknown as string]) }))
      .rejects.toThrow('profile_import_plugin_target_conflict')
  })

  it('rejects an unlisted target dependency and an unlisted installed tree occupying the plugin name', async () => {
    const value = await pluginPlanFixture()
    await writeFile(join(value.target.web, 'package.json'), JSON.stringify({ dependencies: {},
      devDependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: [] } } }))
    const occupied = { ...value.input, expectedPreviewDigest: (await value.inspect()).previewDigest }
    await expect(planSelectedProfileImportPlugins(occupied)).rejects.toThrow('profile_import_plugin_target_conflict')
    await writeFile(join(value.target.web, 'package.json'), JSON.stringify({ dependencies: {},
      dsh: { profile: { bundles: [] } } }))
    await mkdir(join(value.target.web, 'node_modules', 'fixture-plugin'))
    const installed = { ...value.input, expectedPreviewDigest: (await value.inspect()).previewDigest }
    await expect(planSelectedProfileImportPlugins(installed)).rejects.toThrow('profile_import_plugin_target_conflict')
  })

  it('rejects stale previews and missing direct lockfile evidence', async () => {
    const value = await pluginPlanFixture()
    await expect(planSelectedProfileImportPlugins({ ...value.input, expectedPreviewDigest: 'f'.repeat(64) }))
      .rejects.toThrow('profile_import_inventory_changed')
    await writeFile(join(value.source.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    await expect(planSelectedProfileImportPlugins({ ...value.input,
      expectedPreviewDigest: (await value.inspect()).previewDigest }))
      .rejects.toThrow('profile_import_plugin_source_unverified')
  })

  it('binds target plugin policy and patch state even when the import inventory is unchanged', async () => {
    const value = await pluginPlanFixture()
    const before = await planSelectedProfileImportPlugins(value.input)
    await writeFile(join(value.target.web, '.npmrc'), 'ignore-scripts=true\n', { mode: 0o600 })
    expect((await value.inspect()).previewDigest).toBe(before.previewDigest)
    const after = await planSelectedProfileImportPlugins(value.input)
    expect(after.targetPluginStateDigest).not.toBe(before.targetPluginStateDigest)
  })

  it('plans an additive target manifest while retaining existing dependency and bundle order', async () => {
    const value = await pluginPlanFixture()
    const current = { name: 'target', private: true, note: { keep: 1 },
      dependencies: { 'baseline-plugin': '1.2.3' },
      dsh: { note: 'keep', profile: { patchReload: 'restart', bundles: ['baseline-plugin'] } } }
    const path = join(value.target.web, 'package.json')
    await writeFile(path, JSON.stringify(current))
    const input = { ...value.input, expectedPreviewDigest: (await value.inspect()).previewDigest }
    const plan = await planSelectedProfileImportPlugins(input)
    const before = await readFile(path)
    const merged = await planProfileImportPluginTargetManifest({ ...input, plan })
    expect(JSON.parse(merged.nextManifest)).toEqual({ ...current,
      dependencies: { ...current.dependencies, 'fixture-plugin': bundledDependencySpec(value.source.digest) },
      dsh: { ...current.dsh, profile: { ...current.dsh.profile,
        bundles: ['baseline-plugin', 'fixture-plugin'] } } })
    expect(merged.addedBundleNames).toEqual(['fixture-plugin'])
    expect(await readFile(path)).toEqual(before)
    await writeFile(join(value.target.web, '.npmrc'), 'changed=true\n')
    await expect(planProfileImportPluginTargetManifest({ ...input, plan }))
      .rejects.toThrow('profile_import_plugin_target_plan_changed')
  })

  it.skipIf(process.platform === 'win32')('resolves selected plugins beside an existing catalog-backed target plugin without changing live files', async () => {
    const value = await pluginPlanFixture(true)
    const baselineSource = join(value.target.hostRoot, 'baseline-source')
    await mkdir(join(baselineSource, 'package'), { recursive: true })
    await writeFile(join(baselineSource, 'package', 'package.json'),
      JSON.stringify({ name: 'baseline-plugin', version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(baselineSource, 'package', 'index.js'), 'export const baseline = true\n')
    await writeFile(join(baselineSource, 'package', 'cordis.patch.yml'),
      '- insert:\n    - id: baseline-entry\n      name: baseline-plugin\n')
    const baselineArchive = join(value.target.hostRoot, 'baseline.tgz')
    await createArchive({ gzip: true, cwd: baselineSource, file: baselineArchive }, ['package'])
    const baselineBytes = await readFile(baselineArchive)
    const baselineDigest = createHash('sha256').update(baselineBytes).digest('hex')
    const catalogRoot = join(value.source.hostRoot, 'bundled')
    const catalogPath = join(catalogRoot, 'catalog.v1.json')
    const catalogJson = JSON.parse(await readFile(catalogPath, 'utf8')) as { plugins: unknown[] }
    catalogJson.plugins.push({ name: 'baseline-plugin', version: '1.0.0', file: 'baseline.tgz',
      sha256: baselineDigest, repository: 'https://example.com/baseline',
      sourceSha: 'b'.repeat(40), entryIds: ['baseline-entry'] })
    await writeFile(catalogPath, JSON.stringify(catalogJson))
    await writeFile(join(catalogRoot, 'baseline.tgz'), baselineBytes)
    const catalog = BundledPluginCatalog.load(catalogRoot, uid)
    const targetArchives = join(value.target.web, '.bundled-plugins')
    await mkdir(targetArchives, { mode: 0o700 })
    await writeFile(join(targetArchives, `${baselineDigest}.tgz`), baselineBytes, { mode: 0o600 })
    const baselineSpec = bundledDependencySpec(baselineDigest)
    await writeFile(join(value.target.web, 'package.json'), JSON.stringify({ name: 'target', private: true,
      dependencies: { 'baseline-plugin': baselineSpec },
      dsh: { profile: { bundles: ['baseline-plugin'] } } }))
    await writeFile(join(value.target.web, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    await writeFile(join(value.target.web, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(value.target.web, 'compatibility.json'), '{}\n')
    const pnpmEntrypointPath = await realpath(process.env.npm_execpath!)
    const targetInstall = spawnSync(process.execPath, [pnpmEntrypointPath, 'install', '--offline',
      '--ignore-scripts', '--package-import-method=copy', '--store-dir', join(value.target.hostRoot, 'store')],
    { cwd: value.target.web, encoding: 'utf8' })
    expect(targetInstall.status, targetInstall.stderr).toBe(0)
    expect((await lstat(join(value.target.web, 'node_modules', 'baseline-plugin', 'index.js'))).nlink).toBe(1)
    expect((await lstat(join(value.target.web, 'node_modules', 'baseline-plugin', 'package.json'))).nlink).toBe(1)
    const targetManifestBefore = await readFile(join(value.target.web, 'package.json'))
    const targetLockBefore = await readFile(join(value.target.web, 'pnpm-lock.yaml'))
    const baselineInstalledBefore = await readFile(join(value.target.web, 'node_modules', 'baseline-plugin', 'index.js'))
    const input = { ...value.input, catalog, expectedPreviewDigest: (await value.inspect()).previewDigest }
    const plan = await planSelectedProfileImportPlugins(input)
    const manifestPlan = await planProfileImportPluginTargetManifest({ ...input, plan })
    const journal = new FileProfileImportOperationJournal(
      join(value.target.profileRoot, 'profile-import-journal'), uid)
    const targetInventory = await inspectProfileImportInventory({ profileRoot: value.target.profileRoot,
      target: value.target.target, uid })
    const prepared = await journal.create({ operationId: input.operationId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
      sourceSnapshotDigest: plan.sourceSnapshotDigest, targetSnapshotDigest: plan.targetSnapshotDigest,
      previewDigest: plan.previewDigest, selectedSessionIds: [], selectedPluginNames: ['fixture-plugin'],
      targetGeneration: targetInventory.generation, stagedGeneration: targetInventory.generation + 1 })
    const fenced = await journal.advance(prepared, 'fenced')
    await stageSelectedProfileImportPluginArchives({ ...input, journal, plan })
    await installStagedProfileImportPluginsInIsolation({ target: input.target,
      sourceProfileId: input.source.profileId, uid, operationId: input.operationId,
      fence: input.fence, journal, catalog, plan, nodeExecutablePath: process.execPath, pnpmEntrypointPath })
    const resolutionInput = { ...input, journal, plan, manifestPlan }
    const resolved = await resolveProfileImportTargetPluginsInIsolation({ ...resolutionInput,
      nodeExecutablePath: process.execPath, pnpmEntrypointPath })
    expect(await inspectResolvedProfileImportTargetPluginsInIsolation(resolutionInput)).toEqual(resolved)
    const lock = await readFile(join(resolved.resolutionRoot, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).toContain(`baseline-plugin@${baselineSpec}`)
    expect(lock).toContain(`fixture-plugin@${bundledDependencySpec(value.source.digest)}`)
    expect(await readFile(join(resolved.resolutionRoot, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(await readFile(join(resolved.resolutionRoot, 'compatibility.json'), 'utf8')).toBe('{}\n')
    const receiptPath = join(resolved.resolutionRoot, 'resolution-receipt.json')
    const receipt = await readFile(receiptPath)
    await unlink(receiptPath)
    await expect(inspectResolvedProfileImportTargetPluginsInIsolation(resolutionInput))
      .rejects.toThrow('profile_import_plugin_target_resolution_incomplete')
    await writeFile(receiptPath, receipt, { mode: 0o600 })
    const mergedLockPath = join(resolved.resolutionRoot, 'pnpm-lock.yaml')
    const extraResolution = lock.replace('packages:\n', 'packages:\n  unrelated@1.0.0:\n    version: 1.0.0\n')
    await writeFile(mergedLockPath, extraResolution)
    await writeFile(receiptPath, `${JSON.stringify({ ...JSON.parse(receipt.toString()),
      lockfileDigest: createHash('sha256').update(extraResolution).digest('hex') })}\n`)
    await expect(inspectResolvedProfileImportTargetPluginsInIsolation(resolutionInput))
      .rejects.toThrow('profile_import_plugin_target_resolution_changed')
    await writeFile(mergedLockPath, lock)
    await writeFile(receiptPath, receipt)
    const baselineInstalledPath = join(value.target.web, 'node_modules', 'baseline-plugin', 'index.js')
    await writeFile(baselineInstalledPath, 'tampered')
    await expect(inspectResolvedProfileImportTargetPluginsInIsolation(resolutionInput)).rejects.toThrow()
    await writeFile(baselineInstalledPath, baselineInstalledBefore)
    expect(await inspectResolvedProfileImportTargetPluginsInIsolation(resolutionInput)).toEqual(resolved)
    const layer = await installResolvedProfileImportTargetPlugins({ ...resolutionInput,
      nodeExecutablePath: process.execPath, pnpmEntrypointPath })
    expect(layer.installationRoot).toBe(resolved.resolutionRoot)
    expect(await inspectResolvedProfileImportTargetPluginLayer(resolutionInput)).toEqual(layer)
    const addedInstalledPath = join(layer.installationRoot, 'node_modules', 'fixture-plugin', 'index.js')
    const addedBytes = await readFile(addedInstalledPath)
    await writeFile(addedInstalledPath, 'tampered')
    await expect(inspectResolvedProfileImportTargetPluginLayer(resolutionInput)).rejects.toThrow()
    await writeFile(addedInstalledPath, addedBytes)
    expect(await inspectResolvedProfileImportTargetPluginLayer(resolutionInput)).toEqual(layer)
    expect(await inspectProfileImportPluginComposition({ ...resolutionInput,
      installAnchor: join(process.cwd(), 'apps', 'cli', 'package.json') })).toMatchObject({
      addedEntryIds: ['fixture-entry'],
    })
    const shadowRoot = join(value.target.hostRoot, 'shadow-installation')
    await mkdir(join(shadowRoot, 'node_modules'), { recursive: true })
    await writeFile(join(shadowRoot, 'package.json'), '{}\n')
    await symlink(value.source.installed, join(shadowRoot, 'node_modules', 'fixture-plugin'))
    await expect(inspectProfileImportPluginComposition({ ...resolutionInput,
      installAnchor: join(shadowRoot, 'package.json') }))
      .rejects.toThrow('profile_import_plugin_composition_shadowed')
    const publishInput = { ...resolutionInput,
      installAnchor: join(process.cwd(), 'apps', 'cli', 'package.json') }
    const publishPlan = await planProfileImportPluginPublish(publishInput)
    expect(publishPlan.targetWebDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(publishPlan.candidateWebDigest).toMatch(/^[a-f0-9]{64}$/u)
    const staged = await stageProfileImportPluginPublishCandidate(publishInput, publishPlan)
    expect(staged.stagedWebDigest).toBe(publishPlan.candidateWebDigest)
    expect(await readFile(join(staged.stagedWeb, 'node_modules', 'baseline-plugin', 'index.js')))
      .toEqual(baselineInstalledBefore)
    expect(await inspectStagedProfileImportPluginPublishCandidate(publishInput, publishPlan))
      .toEqual(staged)
    const stagedSessions = await stageSelectedProfileImportSessions({
      source: input.source, target: input.target, sourceProfileId: input.source.profileId,
      targetProfileId: input.target.profileId, operationId: input.operationId, fence: input.fence,
      uid, expectedPreviewDigest: plan.previewDigest, selectedSessionIds: [],
      assertQuiescent: input.assertQuiescent,
    })
    expect(stagedSessions.generation).toBe(targetInventory.generation + 1)
    const stagedOperation = await journal.advance(fenced, 'staged')
    await journal.advance(stagedOperation, 'committing')
    const stagedPlugin = join(staged.stagedWeb, 'node_modules', 'baseline-plugin', 'index.js')
    await writeFile(stagedPlugin, 'tampered')
    await expect(inspectStagedProfileImportPluginPublishCandidate(publishInput, publishPlan))
      .rejects.toThrow('profile_import_plugin_publish_changed')
    await writeFile(stagedPlugin, baselineInstalledBefore)
    expect(await inspectStagedProfileImportPluginPublishCandidate(publishInput, publishPlan))
      .toEqual(staged)
    await expect(stageProfileImportPluginPublishCandidate(publishInput, publishPlan))
      .rejects.toMatchObject({ code: 'EEXIST' })
    await writeFile(join(value.target.web, 'unexpected.txt'), 'preserve me')
    await expect(planProfileImportPluginPublish(publishInput))
      .rejects.toThrow('profile_import_plugin_publish_layout_unsupported')
    await unlink(join(value.target.web, 'unexpected.txt'))
    expect(await readFile(join(value.target.web, 'package.json'))).toEqual(targetManifestBefore)
    expect(await readFile(join(value.target.web, 'pnpm-lock.yaml'))).toEqual(targetLockBefore)
    expect(await readFile(join(value.target.web, 'node_modules', 'baseline-plugin', 'index.js')))
      .toEqual(baselineInstalledBefore)
    const directoryState = () => inspectProfileImportPluginDirectoryState({
      profileRoot: value.target.profileRoot, operationId: input.operationId, uid, plan: publishPlan,
    })
    expect(await directoryState()).toBe('prepared')
    const publishJournal = new FileProfileImportPluginPublishJournal(
      join(value.target.profileRoot, 'profile-import-plugin-publish'), uid)
    await publishJournal.create({ operationId: input.operationId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
      selectedPluginNames: ['fixture-plugin'], plan: publishPlan })
    const recovery = () => inspectProfileImportPluginPublishRecovery({ journal: publishJournal,
      profileRoot: value.target.profileRoot, operationId: input.operationId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId, uid })
    expect((await recovery()).action).toBe('ready')
    const sessionCoordinator = new ProfileImportSessionCoordinator(journal, input.fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    const jointInput = { operationId: input.operationId, source: input.source,
      target: input.target, uid, assertAuthority: async () => {}, pluginJournal: publishJournal }
    expect((await sessionCoordinator.inspectCommittingWithPlugins(jointInput)).pluginAction).toBe('ready')
    const wrongSelectionJournal = new FileProfileImportPluginPublishJournal(
      join(value.target.profileRoot, 'profile-import-plugin-wrong-selection'), uid)
    await wrongSelectionJournal.create({ operationId: input.operationId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
      selectedPluginNames: ['different-plugin'], plan: publishPlan })
    await expect(sessionCoordinator.inspectCommittingWithPlugins({ ...jointInput,
      pluginJournal: wrongSelectionJournal })).rejects.toThrow('profile_import_plugin_publish_changed')
    const hostLock = await acquireSingleHostLock({ root: join(value.target.hostRoot, 'publish-host-lock'),
      pid: process.pid, uid, processNonce: randomUUID() })
    const publishOperation = { journal: publishJournal, fence: input.fence, hostLock,
      profileRoot: value.target.profileRoot, operationId: input.operationId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId, uid,
      assertAuthority: async () => {}, assertQuiescent: input.assertQuiescent,
      assertPreparedCandidate: async () => {
        expect(await inspectStagedProfileImportPluginPublishCandidate(publishInput, publishPlan))
          .toEqual(staged)
      },
      assertSessionPointerOld: async () => {},
    }
    await expect(publishProfileImportPluginLayer({ ...publishOperation,
      assertSessionPointerOld: async () => { throw Error('session_pointer_changed') } }))
      .rejects.toThrow('session_pointer_changed')
    expect(await directoryState()).toBe('prepared')
    const published = await publishProfileImportPluginLayer(publishOperation)
    expect(published.phase).toBe('published')
    expect(await directoryState()).toBe('candidate_published')
    expect((await recovery()).action).toBe('published')
    expect((await sessionCoordinator.inspectCommittingWithPlugins(jointInput)).pluginAction)
      .toBe('published')
    expect(await readFile(join(value.target.web, 'node_modules', 'baseline-plugin', 'index.js')))
      .toEqual(baselineInstalledBefore)
    await writeFile(join(value.target.web, 'unexpected.txt'), 'unknown')
    await expect(directoryState()).rejects.toThrow('profile_import_plugin_publish_layout_unsupported')
    await unlink(join(value.target.web, 'unexpected.txt'))
    await expect(rollbackProfileImportPluginLayer({ ...publishOperation,
      assertSessionPointerOld: async () => { throw Error('session_pointer_changed') } }))
      .rejects.toThrow('session_pointer_changed')
    expect(await directoryState()).toBe('candidate_published')
    const rolledBack = await rollbackProfileImportPluginLayer(publishOperation)
    expect(rolledBack.phase).toBe('rolled_back')
    expect(await directoryState()).toBe('prepared')
    expect((await recovery()).action).toBe('rolled_back')
    expect((await sessionCoordinator.inspectCommittingWithPlugins(jointInput)).pluginAction)
      .toBe('rolled_back')
    expect(await readFile(join(value.target.web, 'package.json'))).toEqual(targetManifestBefore)
    const resumedId = randomUUID()
    input.fence.clearPair(input.source.profileId, input.target.profileId, input.operationId)
    input.fence.reservePair(input.source.profileId, input.target.profileId, resumedId)
    const resumedStaged = join(value.target.profileRoot, 'profiles', `.web-import-${resumedId}`)
    const resumedBackup = join(value.target.profileRoot, 'profiles', `.web-import-backup-${resumedId}`)
    await rename(staged.stagedWeb, resumedStaged)
    const resumedPrepared = await publishJournal.create({ operationId: resumedId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
      selectedPluginNames: ['fixture-plugin'], plan: publishPlan })
    await publishJournal.advance(resumedPrepared, 'switching')
    await rename(value.target.web, resumedBackup)
    const resumedOperation = { ...publishOperation, operationId: resumedId,
      assertPreparedCandidate: async () => { throw Error('unexpected_prepared_check') } }
    expect((await inspectProfileImportPluginPublishRecovery(resumedOperation)).action)
      .toBe('publish_candidate')
    expect((await publishProfileImportPluginLayer(resumedOperation)).phase).toBe('published')
    expect((await rollbackProfileImportPluginLayer(resumedOperation)).phase).toBe('rolled_back')
    expect(await readFile(join(value.target.web, 'package.json'))).toEqual(targetManifestBefore)
    const afterSecondRenameId = randomUUID()
    input.fence.clearPair(input.source.profileId, input.target.profileId, resumedId)
    input.fence.reservePair(input.source.profileId, input.target.profileId, afterSecondRenameId)
    const afterSecondStaged = join(value.target.profileRoot, 'profiles',
      `.web-import-${afterSecondRenameId}`)
    const afterSecondBackup = join(value.target.profileRoot, 'profiles',
      `.web-import-backup-${afterSecondRenameId}`)
    await rename(resumedStaged, afterSecondStaged)
    const afterSecondPrepared = await publishJournal.create({ operationId: afterSecondRenameId,
      sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
      selectedPluginNames: ['fixture-plugin'], plan: publishPlan })
    await publishJournal.advance(afterSecondPrepared, 'switching')
    await rename(value.target.web, afterSecondBackup)
    await rename(afterSecondStaged, value.target.web)
    const afterSecondOperation = { ...publishOperation, operationId: afterSecondRenameId,
      assertPreparedCandidate: async () => { throw Error('unexpected_prepared_check') } }
    expect((await inspectProfileImportPluginPublishRecovery(afterSecondOperation)).action)
      .toBe('record_published')
    const afterSecondPublished = await publishProfileImportPluginLayer(afterSecondOperation)
    expect(afterSecondPublished.phase).toBe('published')
    await publishJournal.advance(afterSecondPublished, 'rolling_back')
    await rename(value.target.web, afterSecondStaged)
    expect((await inspectProfileImportPluginPublishRecovery(afterSecondOperation)).action)
      .toBe('restore_old')
    expect((await rollbackProfileImportPluginLayer(afterSecondOperation)).phase).toBe('rolled_back')
    expect(await readFile(join(value.target.web, 'package.json'))).toEqual(targetManifestBefore)
    await rename(afterSecondStaged, staged.stagedWeb)
    input.fence.clearPair(input.source.profileId, input.target.profileId, afterSecondRenameId)
    input.fence.reservePair(input.source.profileId, input.target.profileId, input.operationId)
    await input.target.target.commitGeneration(targetInventory.generation, stagedSessions.generation)
    await expect(sessionCoordinator.inspectCommittingWithPlugins(jointInput))
      .rejects.toThrow('profile_import_plugin_publish_changed')
    await hostLock.release()
  }, 120_000)

  it.skipIf(process.platform === 'win32')('prepares and jointly commits a complete plugin layer from an empty target web', async () => {
    const value = await pluginPlanFixture(true)
    await writeFile(join(value.target.web, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    await writeFile(join(value.target.web, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n")
    await writeFile(join(value.target.web, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(value.target.web, 'compatibility.json'), '{}\n')
    const originalManifest = await readFile(join(value.target.web, 'package.json'))
    const originalLock = await readFile(join(value.target.web, 'pnpm-lock.yaml'))
    const preview = await value.inspect()
    const input = { ...value.input, expectedPreviewDigest: preview.previewDigest }
    const journal = new FileProfileImportOperationJournal(
      join(value.target.profileRoot, 'profile-import-journal'), uid)
    const publishJournal = new FileProfileImportPluginPublishJournal(
      join(value.target.profileRoot, 'profile-import-plugin-publish'), uid)
    const installAnchor = join(process.cwd(), 'apps', 'cli', 'package.json')
    const preparedInput = { ...input, journal, publishJournal, installAnchor }
    const coordinator = new ProfileImportSessionCoordinator(journal, input.fence, {
      revoke: () => {}, stop: async () => {}, settleExtensions: async () => {},
      settleHostOperations: async () => {},
    })
    const staged = await coordinator.prepareWithPlugins({ ...input, selectedSessionIds: [],
      assertAuthority: async () => {} }, { journal: publishJournal,
      prepare: async () => prepareSelectedProfileImportPlugins({ ...preparedInput,
        nodeExecutablePath: process.execPath,
        pnpmEntrypointPath: await realpath(process.env.npm_execpath!) }) })
    expect(staged.phase).toBe('staged')
    const publishRecord = await publishJournal.load(input.operationId)
    expect(publishRecord?.phase).toBe('prepared')
    expect((await inspectProfileImportPluginDirectoryState({ profileRoot: value.target.profileRoot,
      operationId: input.operationId, uid, plan: publishRecord!.plan }))).toBe('prepared')
    expect(await readFile(join(value.target.web, 'package.json'))).toEqual(originalManifest)
    expect(await readFile(join(value.target.web, 'pnpm-lock.yaml'))).toEqual(originalLock)
    expect((await journal.load(input.operationId))?.phase).toBe('staged')
    await inspectPreparedProfileImportPlugins(preparedInput)
    const missingRecord = vi.spyOn(publishJournal, 'load').mockResolvedValueOnce(null)
    await expect(inspectPreparedProfileImportPlugins(preparedInput))
      .rejects.toThrow('profile_import_plugin_publish_changed')
    missingRecord.mockRestore()
    const changedRecord = vi.spyOn(publishJournal, 'load').mockResolvedValueOnce({
      ...publishRecord!, plan: { ...publishRecord!.plan, targetWebDigest: '0'.repeat(64) },
    })
    await expect(inspectPreparedProfileImportPlugins(preparedInput))
      .rejects.toThrow('profile_import_plugin_publish_changed')
    changedRecord.mockRestore()
    const hostLock = await acquireSingleHostLock({ root: join(value.target.hostRoot, 'publish-host-lock'),
      pid: process.pid, uid, processNonce: randomUUID() })
    const committed = await coordinator.commitWithPlugins({ operationId: input.operationId,
      source: input.source, target: input.target, uid, assertAuthority: async () => {},
      activateCandidate: async () => {},
      candidateLease: new FileProfileImportCandidateLease(input.target.profileRoot, input.operationId, uid),
      runtimePatch: new FileProfileImportRuntimePatch(input.target.profileRoot, input.operationId,
        input.target.target, new MigrationOwnerStateApplicator(uid), uid),
      pluginJournal: publishJournal,
      pluginPublisher: { journal: publishJournal, fence: input.fence, hostLock,
        profileRoot: input.target.profileRoot, operationId: input.operationId,
        sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId, uid,
        assertAuthority: async () => {}, assertQuiescent: input.assertQuiescent,
        assertPreparedCandidate: () => inspectPreparedProfileImportPlugins(preparedInput),
        assertSessionPointerOld: async () => {} } })
    expect(committed.phase).toBe('committed')
    expect(await input.target.target.activeGeneration()).toBe(staged.stagedGeneration)
    expect(await readFile(join(value.target.web, 'package.json'), 'utf8')).toContain('fixture-plugin')
    expect(await readFile(join(value.target.web, 'pnpm-lock.yaml'))).not.toEqual(originalLock)
    await hostLock.release()
  }, 30_000)

  it('stages verified archives under a fenced private operation without changing live plugin files', async () => {
    const value = await pluginPlanFixture()
    const outerWorkspace = join(value.target.profileRoot, 'pnpm-workspace.yaml')
    await writeFile(outerWorkspace, "packages:\n  - 'profiles/*'\n", { mode: 0o600 })
    const plan = await planSelectedProfileImportPlugins(value.input)
    const journal = new FileProfileImportOperationJournal(
      join(value.target.profileRoot, 'profile-import-journal'), uid)
    const targetInventory = await inspectProfileImportInventory({ profileRoot: value.target.profileRoot,
      target: value.target.target, uid })
    const prepared = await journal.create({ operationId: value.input.operationId,
      sourceProfileId: value.input.source.profileId, targetProfileId: value.input.target.profileId,
      sourceSnapshotDigest: plan.sourceSnapshotDigest, targetSnapshotDigest: plan.targetSnapshotDigest,
      previewDigest: plan.previewDigest, selectedSessionIds: [], selectedPluginNames: ['fixture-plugin'],
      targetGeneration: targetInventory.generation, stagedGeneration: targetInventory.generation + 1 })
    await journal.advance(prepared, 'fenced')
    const beforeSource = await treeInventory(value.source.profileRoot)
    const beforeWeb = await treeInventory(value.target.web)
    const input = { ...value.input, journal, plan }
    const result = await stageSelectedProfileImportPluginArchives(input)
    expect(await readFile(join(result.stageRoot, `${value.source.digest}.tgz`))).toEqual(await readFile(value.source.archive))
    expect(JSON.parse(await readFile(join(result.stageRoot, 'receipt.json'), 'utf8'))).toMatchObject({
      operationId: value.input.operationId, previewDigest: plan.previewDigest,
      archives: [{ name: 'fixture-plugin', digest: value.source.digest }],
    })
    expect(await treeInventory(value.source.profileRoot)).toEqual(beforeSource)
    expect(await treeInventory(value.target.web)).toEqual(beforeWeb)
    const recovery = { target: value.input.target, sourceProfileId: value.input.source.profileId,
      uid, operationId: value.input.operationId, fence: value.input.fence, journal,
      catalog: value.input.catalog, plan }
    expect(await inspectStagedProfileImportPluginArchives(recovery)).toMatchObject({ stageRoot: result.stageRoot })
    if (process.platform !== 'win32') {
      const pnpmEntrypointPath = await realpath(process.env.npm_execpath!)
      const installed = await installStagedProfileImportPluginsInIsolation({ ...recovery,
        nodeExecutablePath: process.execPath, pnpmEntrypointPath })
      expect(installed.lockfileDigest).toMatch(/^[a-f0-9]{64}$/u)
      expect(await readFile(join(installed.sandboxRoot, 'install-receipt.json'), 'utf8'))
        .toContain(value.source.digest)
      expect(await inspectIsolatedProfileImportPluginInstall(recovery)).toEqual(installed)
      const lockfilePath = join(installed.sandboxRoot, 'pnpm-lock.yaml')
      const lockfile = await readFile(lockfilePath)
      await writeFile(lockfilePath, 'tampered')
      await expect(inspectIsolatedProfileImportPluginInstall(recovery))
        .rejects.toThrow('profile_import_plugin_isolated_incomplete')
      await writeFile(lockfilePath, lockfile)
      const receiptPath = join(installed.sandboxRoot, 'install-receipt.json')
      const receipt = await readFile(receiptPath)
      const extraResolution = lockfile.toString().replace('packages:\n',
        'packages:\n  unrelated@1.0.0:\n    version: 1.0.0\n')
      await writeFile(lockfilePath, extraResolution)
      await writeFile(receiptPath, `${JSON.stringify({ ...JSON.parse(receipt.toString()),
        lockfileDigest: createHash('sha256').update(extraResolution).digest('hex') })}\n`)
      await expect(inspectIsolatedProfileImportPluginInstall(recovery))
        .rejects.toThrow('profile_import_plugin_isolated_resolution_invalid')
      await writeFile(lockfilePath, lockfile)
      await writeFile(receiptPath, receipt)
      expect(await treeInventory(value.target.web)).toEqual(beforeWeb)
      expect(await readFile(outerWorkspace, 'utf8')).toBe("packages:\n  - 'profiles/*'\n")
      await expect(lstat(join(value.target.profileRoot, 'pnpm-lock.yaml')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
    await writeFile(join(result.stageRoot, `${value.source.digest}.tgz`), 'tampered', { mode: 0o600 })
    await expect(inspectStagedProfileImportPluginArchives(recovery))
      .rejects.toThrow('profile_import_plugin_stage_archive_changed')
    await unlink(join(result.stageRoot, 'receipt.json'))
    await expect(inspectStagedProfileImportPluginArchives(recovery))
      .rejects.toThrow('profile_import_plugin_stage_incomplete')
    await expect(stageSelectedProfileImportPluginArchives(input)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('requires a durable fenced intent before creating a plugin archive stage', async () => {
    const value = await pluginPlanFixture()
    const plan = await planSelectedProfileImportPlugins(value.input)
    const journal = new FileProfileImportOperationJournal(
      join(value.target.profileRoot, 'profile-import-journal'), uid)
    await expect(stageSelectedProfileImportPluginArchives({ ...value.input, journal, plan }))
      .rejects.toThrow('profile_import_plugin_stage_intent_invalid')
    await expect(lstat(join(value.target.profileRoot, 'profile-import-plugin-staging')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects source drift after planning before creating a private archive stage', async () => {
    const value = await pluginPlanFixture()
    const plan = await planSelectedProfileImportPlugins(value.input)
    const journal = new FileProfileImportOperationJournal(
      join(value.target.profileRoot, 'profile-import-journal'), uid)
    const targetInventory = await inspectProfileImportInventory({ profileRoot: value.target.profileRoot,
      target: value.target.target, uid })
    const prepared = await journal.create({ operationId: value.input.operationId,
      sourceProfileId: value.input.source.profileId, targetProfileId: value.input.target.profileId,
      sourceSnapshotDigest: plan.sourceSnapshotDigest, targetSnapshotDigest: plan.targetSnapshotDigest,
      previewDigest: plan.previewDigest, selectedSessionIds: [], selectedPluginNames: ['fixture-plugin'],
      targetGeneration: targetInventory.generation, stagedGeneration: targetInventory.generation + 1 })
    await journal.advance(prepared, 'fenced')
    await writeFile(join(value.source.installed, 'index.js'), 'changed', { mode: 0o600 })
    await expect(stageSelectedProfileImportPluginArchives({ ...value.input, journal, plan }))
      .rejects.toThrow('profile_import_plugin_install_unsafe')
    await expect(lstat(join(value.target.profileRoot, 'profile-import-plugin-staging')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a linked legacy installation outside the private pnpm layout', async () => {
    const value = await bundledFixture()
    const inventory = await inspectProfileImportInventory({ profileRoot: value.profileRoot, target: value.target, uid })
    await rm(value.installed, { recursive: true })
    await symlink(join(value.hostRoot, 'archive-source', 'package'), value.installed)
    await expect(inspectProfileImportPluginArchives({ profileRoot: value.profileRoot, target: value.target, uid,
      expectedSnapshotDigest: inventory.snapshotDigest, selectedPluginNames: ['fixture-plugin'], catalog: value.catalog }))
      .rejects.toThrow('profile_import_plugin_install_unsafe')
  })

  it('verifies a pnpm linked installation within its content-addressed private layout', async () => {
    const value = await bundledFixture()
    const folder = `fixture-plugin@file+.bundled-plugins+${value.digest}.tgz`
    const physical = join(value.web, 'node_modules', '.pnpm', folder, 'node_modules', 'fixture-plugin')
    await mkdir(join(value.web, 'node_modules', '.pnpm', folder, 'node_modules'),
      { recursive: true, mode: 0o700 })
    await rename(value.installed, physical)
    // pnpm 11.28.5 uses this exact relative direct-dependency link for a local tarball.
    await symlink(join('.pnpm', folder, 'node_modules', 'fixture-plugin'), value.installed)
    const inventory = await inspectProfileImportInventory({ profileRoot: value.profileRoot, target: value.target, uid })
    const input = { profileRoot: value.profileRoot, target: value.target, uid,
      expectedSnapshotDigest: inventory.snapshotDigest, selectedPluginNames: ['fixture-plugin'], catalog: value.catalog }
    expect(await inspectProfileImportPluginArchives(input)).toEqual([
      { name: 'fixture-plugin', status: 'installed_verified', archiveDigest: value.digest,
        lockfileResolutionVerified: false },
    ])
    await writeFile(join(physical, 'index.js'), 'tampered', { mode: 0o600 })
    await expect(inspectProfileImportPluginArchives(input)).rejects.toThrow('profile_import_plugin_install_unsafe')
    await writeFile(join(physical, 'index.js'), value.files['index.js'], { mode: 0o600 })
    await unlink(value.installed)
    await symlink(`.pnpm/${folder}/node_modules/../node_modules/fixture-plugin`, value.installed)
    await expect(inspectProfileImportPluginArchives(input)).rejects.toThrow('profile_import_plugin_install_unsafe')
  })

  it.each(['private-store', 'installed-package'] as const)
  ('rejects a writable directory in a pnpm linked installation: %s', async (kind) => {
    const value = await bundledFixture()
    const folder = `fixture-plugin@file+.bundled-plugins+${value.digest}.tgz`
    const store = join(value.web, 'node_modules', '.pnpm')
    const physical = join(store, folder, 'node_modules', 'fixture-plugin')
    await mkdir(join(store, folder, 'node_modules'), { recursive: true, mode: 0o700 })
    await rename(value.installed, physical)
    await symlink(join('.pnpm', folder, 'node_modules', 'fixture-plugin'), value.installed)
    await chmod(kind === 'private-store' ? store : physical, 0o777)
    await expect(verifyCopiedBundledPlugin(value.catalog, value.catalog.get('fixture-plugin', '1.0.0')!,
      value.web, uid, 'pnpm_link')).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recovers the historical archive when the catalog also ships a newer version', async () => {
    const value = await bundledFixture(undefined, bundledFiles, true)
    const before = await treeInventory(value.profileRoot)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    expect(await treeInventory(value.profileRoot)).toEqual(before)
  })

  it.each(['modified', 'missing', 'extra', 'symlink', 'profile-archive', 'embedding-archive'])
  ('rejects a copied bundled dependency with %s content', async (kind) => {
    const value = await bundledFixture()
    const nested = join(value.installed, 'node_modules', 'nested', 'index.js')
    if (kind === 'modified') await writeFile(nested, 'tampered')
    if (kind === 'missing') await unlink(nested)
    if (kind === 'extra') await writeFile(join(value.installed, 'node_modules', 'nested', 'extra.js'), 'extra')
    if (kind === 'symlink') { await unlink(nested); await symlink(join(value.installed, 'index.js'), nested) }
    if (kind === 'profile-archive') await writeFile(join(value.web, '.bundled-plugins', `${value.digest}.tgz`), 'tampered')
    if (kind === 'embedding-archive') await writeFile(value.archive, 'tampered')
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects a copied plugin changed after its confirmed preflight', async () => {
    const value = await bundledFixture()
    const preflight = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.installed, 'node_modules', 'nested', 'index.js'), 'tampered')
    await expect(value.inspector.prepareConfirmedProfile(profile(), preflight))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it('keeps copied dependencies blocked when their source is not the exact catalog archive', async () => {
    const value = await bundledFixture()
    await writeFile(join(value.web, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'compatibility_blocked', compatibility: 'read_only_export_only' })
  })

  it.skipIf(process.platform === 'win32')('rejects a group-writable copied dependency', async () => {
    const value = await bundledFixture()
    await chmod(join(value.installed, 'index.js'), 0o666)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('accepts the exact released settings-owner patch without modifying it during preflight', async () => {
    const value = await fixture()
    const path = join(value.profileRoot, 'cordis.patch.yml')
    const patch = await releasedPatch(value)
    await writeFile(path, patch, { mode: 0o600 })
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'recoverable', persistenceGeneration: 1 })
    expect(await readFile(path, 'utf8')).toBe(patch)
  })

  it('rejects a released patch with redirected owner paths', async () => {
    const value = await fixture()
    const patch = (await releasedPatch(value)).replace(JSON.stringify(value.ownerPaths.settingsPath), JSON.stringify('/outside/settings.yaml'))
    await writeFile(join(value.profileRoot, 'cordis.patch.yml'), patch, { mode: 0o600 })
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('reports current compatible plugin inventory without modifying Profile files', async () => {
    const { profileRoot, inspector } = await fixture()
    const patchBefore = await readFile(join(profileRoot, 'cordis.patch.yml'))
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 1,
      sessionCount: 0, pluginCount: 1,
    })
    expect(inspected.preflightDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(join(profileRoot, 'cordis.patch.yml'))).toEqual(patchBefore)
    await expect(inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
  })

  it('needs no compatibility materialization when the Profile has no runtime dependencies', async () => {
    const value = await fixture()
    await unlink(join(value.web, 'node_modules', 'fixture-plugin'))
    await writeFile(join(value.web, 'package.json'), `${JSON.stringify({ dependencies: {} })}\n`)
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'current', persistenceGeneration: 1,
      sessionCount: 0, pluginCount: 0,
    })
    await expect(value.inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
    await expect(readFile(join(value.profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects an intact dependency closure owned by a different packaged runtime', async () => {
    const { profileRoot, inspector } = await fixture(true)
    const inspected = await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    expect(inspected).toMatchObject({
      state: 'recoverable', compatibility: 'legacy_runtime_required', pluginCount: 1,
    })
    await inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(profileRoot, 'profiles', 'web', 'node_modules', 'fixture-plugin'))
    expect(dependency).toContain(`${join(profileRoot, 'runtime-compat', 'closures')}/`)
    expect(JSON.parse(await readFile(
      join(profileRoot, 'runtime-compat', 'journals', `${inspected.preflightDigest}.json`), 'utf8',
    ))).toMatchObject({ state: 'committed', rewriteCount: 1 })
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ state: 'recoverable', compatibility: 'current', pluginCount: 1 })
  })

  it('rejects a broken plugin dependency without creating a replacement', async () => {
    const { profileRoot, inspector } = await fixture()
    await symlink('/missing/dsh-runtime/app/plugin', join(profileRoot, 'profiles', 'web', 'node_modules', 'broken'))
    await expect(inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('recognizes only packaged runtime app paths', () => {
    expect(packagedRuntimeAppRoot('/Applications/Slark.app/Contents/Resources/dsh-runtime/app/bin/dsh.mjs'))
      .toBe('/Applications/Slark.app/Contents/Resources/dsh-runtime/app')
    expect(packagedRuntimeAppRoot('/tmp/dsh.mjs')).toBeUndefined()
    expect(packagedRuntimeAppRoot('relative/dsh-runtime/app/dsh.mjs')).toBeUndefined()
  })

  it.each([
    ['unsafe Profile directory', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(value.profileRoot, 0o777)],
    ['changed worker patch', async (value: Awaited<ReturnType<typeof fixture>>) => writeFile(join(value.profileRoot, 'cordis.patch.yml'), 'changed\n')],
    ['unsafe manifest', async (value: Awaited<ReturnType<typeof fixture>>) => chmod(join(value.web, 'package.json'), 0o666)],
    ['unsafe ordinary plugin-tree entry', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.web, 'unsafe.txt'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
  ])('rejects %s without preparing a worker', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it.each([
    ['invalid JSON', '{'],
    ['array root', '[]'],
    ['missing dependencies', '{}'],
    ['array dependencies', '{"dependencies":[]}'],
  ])('rejects a manifest with %s', async (_name, manifest) => {
    const value = await fixture()
    await writeFile(join(value.web, 'package.json'), manifest)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })

  it('classifies file and link-shaped dependencies but rejects a link outside any DSH runtime', async () => {
    const value = await fixture()
    const file = join(value.currentRuntime, 'file-plugin')
    await writeFile(file, 'plugin')
    await symlink(file, join(value.web, 'node_modules', 'file-plugin'))
    const intermediate = join(value.currentRuntime, 'link-plugin')
    await symlink(file, intermediate)
    await symlink(intermediate, join(value.web, 'node_modules', 'link-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({ compatibility: 'current' })
    const outside = join(value.hostRoot, 'outside-plugin')
    await writeFile(outside, 'outside')
    await symlink(outside, join(value.web, 'node_modules', 'outside'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('rejects dependencies split across two legacy runtimes', async () => {
    const value = await fixture(true)
    const other = join(value.hostRoot, 'other', 'dsh-runtime', 'app', 'node_modules', 'other-plugin')
    await mkdir(other, { recursive: true })
    await symlink(other, join(value.web, 'node_modules', 'other-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('binds plan replacement and rejects missing, cross-Profile, changed-runtime, and stale-link plans', async () => {
    const value = await fixture(true)
    const first = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await writeFile(join(value.web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nchanged: true\n')
    const second = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await expect(value.inspector.prepareConfirmedProfile(profile(), first))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await expect(value.inspector.prepareConfirmedProfile(
      { ...profile(), profileId: '018f0f4c-87f8-4e2d-a2f8-7b93d34e3159' as PersonProfileRecord['profileId'] },
      second,
    )).rejects.toMatchObject({ code: 'recovery_preflight_stale' })
    await writeFile(join(value.legacyRuntime, 'changed'), 'after-inspection')
    await expect(value.inspector.prepareConfirmedProfile(profile(), second))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })

    const fresh = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    const dependencyPath = join(value.web, 'node_modules', 'fixture-plugin')
    await unlink(dependencyPath)
    await symlink(join(value.legacyRuntime, 'node_modules', 'different'), dependencyPath)
    await expect(value.inspector.prepareConfirmedProfile(profile(), fresh))
      .rejects.toMatchObject({ code: 'recovery_preflight_stale' })
  })

  it('rewrites internal absolute runtime links and reuses a verified published closure', async () => {
    const value = await fixture(true)
    const internalTarget = join(value.legacyRuntime, 'node_modules', 'fixture-plugin')
    await symlink(internalTarget, join(value.legacyRuntime, 'internal-link'))
    await symlink('node_modules/fixture-plugin', join(value.legacyRuntime, 'relative-link'))
    const inspected = await value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await value.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(value.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = dependency.slice(0, dependency.indexOf('/node_modules/'))
    expect(await readlink(join(publishedApp, 'internal-link'))).toBe(join(publishedApp, 'node_modules', 'fixture-plugin'))
    expect(await readlink(join(publishedApp, 'relative-link'))).toBe('node_modules/fixture-plugin')
    await expect(value.inspector.prepareConfirmedProfile(profile(), inspected)).resolves.toBeUndefined()
  })

  it.each([
    ['escaping runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside'); await writeFile(outside, 'outside')
      await symlink(outside, join(value.currentRuntime, 'escape'))
    }],
    ['runtime link escaping through an internal hop', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const outside = join(value.hostRoot, 'outside-directory')
      await mkdir(outside)
      await writeFile(join(outside, 'plugin.js'), 'outside')
      await symlink(outside, join(value.currentRuntime, 'internal-hop'))
      await symlink('internal-hop/plugin.js', join(value.currentRuntime, 'escape-through-hop'))
    }],
    ['broken internal runtime link', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await symlink('missing-plugin', join(value.currentRuntime, 'broken-internal'))
    }],
    ['unsafe runtime directory', async (value: Awaited<ReturnType<typeof fixture>>) => {
      await chmod(join(value.currentRuntime, 'node_modules'), 0o777)
    }],
    ['unsafe runtime file', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const path = join(value.currentRuntime, 'unsafe'); await writeFile(path, 'unsafe'); await chmod(path, 0o666)
    }],
    ['special runtime inode', async (value: Awaited<ReturnType<typeof fixture>>) => {
      const server = createServer()
      onTestFinished(async () => {
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(join(value.currentRuntime, 'socket'), resolve)
      })
      await symlink(join(value.currentRuntime, 'socket'), join(value.web, 'node_modules', 'socket-plugin'))
    }],
  ])('rejects %s during runtime content inspection', async (_name, mutate) => {
    const value = await fixture()
    await mutate(value)
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('blocks a Profile-contained dependency whose runtime compatibility cannot be proven', async () => {
    const value = await fixture()
    await unlink(join(value.web, 'node_modules', 'fixture-plugin'))
    await mkdir(join(value.web, 'node_modules', 'fixture-plugin'))
    const containedPlugin = join(value.web, 'contained-plugin')
    await mkdir(containedPlugin)
    await symlink(containedPlugin, join(value.web, 'node_modules', 'contained-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .resolves.toMatchObject({
        state: 'compatibility_blocked',
        compatibility: 'read_only_export_only',
        pluginCount: 1,
        reasonCode: 'dsh_recovery_runtime_incompatible',
      })
  })

  it('rejects a published closure whose directory name does not match its content digest', async () => {
    const value = await fixture()
    const closure = join(value.profileRoot, 'runtime-compat', 'closures', 'a'.repeat(64), 'app')
    const plugin = join(closure, 'node_modules', 'published-plugin')
    await mkdir(plugin, { recursive: true })
    await symlink(plugin, join(value.web, 'node_modules', 'published-plugin'))
    await expect(value.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('redacts unexpected adapter errors as Profile integrity failures', async () => {
    const value = await fixture()
    const inspector = new OfflineProfileRecoveryInspector({
      hostRoot: value.hostRoot, installationId, expectedUid: uid,
      currentRuntimeAppRoot: value.currentRuntime,
      targetFor: () => ({ inspectExistingPersistence: async () => { throw new Error('private path') } }) as never,
      ownerStateApplicator: value.ownerStateApplicator,
    })
    try {
      await inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
      throw new Error('expected inspection to reject')
    } catch (error) {
      expect(error).toMatchObject({ code: 'profile_integrity_failed' })
      expect(String(error)).not.toContain('private path')
    }
  })

  it('rejects a corrupted or unsafe already-published closure on retry', async () => {
    const first = await fixture(true)
    const inspected = await first.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await first.inspector.prepareConfirmedProfile(profile(), inspected)
    const dependency = await readlink(join(first.web, 'node_modules', 'fixture-plugin'))
    await writeFile(join(dependency, 'corrupt'), 'corrupt')
    await expect(first.inspector.prepareConfirmedProfile(profile(), inspected))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })

    const second = await fixture(true)
    const secondInspection = await second.inspector.inspect(profile(), { runtimeGeneration: 5, schemaGeneration: 1 })
    await second.inspector.prepareConfirmedProfile(profile(), secondInspection)
    const secondDependency = await readlink(join(second.web, 'node_modules', 'fixture-plugin'))
    const publishedApp = secondDependency.slice(0, secondDependency.indexOf('/node_modules/'))
    await chmod(publishedApp, 0o777)
    await expect(second.inspector.prepareConfirmedProfile(profile(), secondInspection))
      .rejects.toMatchObject({ code: 'profile_integrity_failed' })
  })
})
