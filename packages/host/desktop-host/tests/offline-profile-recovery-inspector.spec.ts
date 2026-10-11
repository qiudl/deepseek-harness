import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { create as createArchive, Header } from 'tar'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { verifyCopiedBundledPlugin } from '../src/bundled-plugin-recovery.ts'

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

async function bundledFixture(archiveBytes?: Buffer, files = bundledFiles) {
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
  await writeFile(join(embedding, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [{
    name: 'fixture-plugin', version: '1.0.0', file: 'fixture.tgz', sha256: digest,
    repository: 'https://example.com/fixture', sourceSha: 'a'.repeat(40), entryIds: [],
  }] }))
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
