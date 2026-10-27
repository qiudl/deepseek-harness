import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const fsFaults = vi.hoisted(() => ({ failRename: false, shortRead: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const renameSync: typeof actual.renameSync = (oldPath, newPath) => {
    if (fsFaults.failRename) throw Object.assign(Error('rename failed'), { code: 'EIO' })
    actual.renameSync(oldPath, newPath)
  }
  const readSync = (...args: Parameters<typeof actual.readSync>) => fsFaults.shortRead ? 0 : actual.readSync(...args)
  return { ...actual, renameSync, readSync }
})
import { BUNDLED_ARCHIVE_DIRECTORY, BundledPluginCatalog, bundledDependencySpec, parseBundledPluginSpec } from '../src/bundled-plugins.ts'
import { isPinnedPluginSpec, runProfilePluginCommand } from '../src/plugin-command.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'

// POSIX uid evidence; on Windows the uid is only consulted behind platform gates.
const uid = process.getuid?.() ?? 0
const archive = Buffer.from('fixture archive bytes')
const digest = createHash('sha256').update(archive).digest('hex')
const row = { name: 'dsh-duet', version: '0.3.0', file: 'dsh-duet-0.3.0.tgz', sha256: digest,
  repository: 'https://github.com/qiudl/dsh-duet.git', sourceSha: 'a'.repeat(40), entryIds: ['duplex-harness-control'] }

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}
function embedding(catalog: unknown = { schemaVersion: 1, plugins: [row] }, bytes = archive): string {
  const root = join(temp('bundled-embedding-'), 'dsh-default-plugins'); mkdirSync(root, { mode: 0o755 })
  writeFileSync(join(root, 'catalog.v1.json'), JSON.stringify(catalog), { mode: 0o644 })
  writeFileSync(join(root, row.file), bytes, { mode: 0o644 })
  return root
}
function webRoot(): { profile: string; web: string } {
  const profile = temp('bundled-profile-'); const web = join(profile, 'profiles', 'web')
  mkdirSync(web, { recursive: true, mode: 0o700 })
  return { profile, web }
}

it('parses only exact bundled identities and treats them as pinned sources', () => {
  expect(parseBundledPluginSpec('bundled:dsh-duet@0.3.0')).toEqual({ name: 'dsh-duet', version: '0.3.0' })
  expect(parseBundledPluginSpec('bundled:@deepseek-ai/dsh-client-ui-voice@0.3.0'))
    .toEqual({ name: '@deepseek-ai/dsh-client-ui-voice', version: '0.3.0' })
  for (const spec of ['bundled:dsh-duet', 'bundled:dsh-duet@^0.3.0', 'bundled:dsh-duet@0.3.0-rc.1', 'bundled:../x@1.0.0',
    'file:/tmp/dsh-duet.tgz', 'dsh-duet@0.3.0', `bundled:${'a'.repeat(260)}@1.0.0`]) {
    expect(parseBundledPluginSpec(spec)).toBeUndefined()
  }
  expect(isPinnedPluginSpec('bundled:dsh-duet@0.3.0')).toBe(true)
  expect(isPinnedPluginSpec('bundled:dsh-duet@latest')).toBe(false)
})

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('loads the exact catalog schema and rejects unknown or unsafe embeddings', () => {
  const catalog = BundledPluginCatalog.load(embedding(), uid)
  expect(catalog.get('dsh-duet', '0.3.0')?.entryIds).toEqual(['duplex-harness-control'])
  expect(catalog.get('dsh-duet', '0.2.7')).toBeUndefined()
  for (const value of [null, [], { schemaVersion: 2, plugins: [row] }, { schemaVersion: 1, plugins: [] },
    { schemaVersion: 1, plugins: [row], extra: 1 }, { schemaVersion: 1, plugins: [{ ...row, extra: 1 }] },
    { schemaVersion: 1, plugins: [row, row] }, { schemaVersion: 1, plugins: [{ ...row, file: '../x.tgz' }] },
    { schemaVersion: 1, plugins: [{ ...row, version: '0.3' }] }, { schemaVersion: 1, plugins: [{ ...row, entryIds: 'x' }] },
    { schemaVersion: 1, plugins: [{ ...row, repository: 'http://x' }] }, { schemaVersion: 1, plugins: [{ ...row, sourceSha: 'x' }] }]) {
    expect(() => BundledPluginCatalog.load(embedding(value), uid)).toThrow('invalid_bundled_plugins')
  }
  expect(() => BundledPluginCatalog.load('relative', uid)).toThrow('unsafe_bundled_plugins')
  const writable = embedding(); chmodSync(writable, 0o777)
  expect(() => BundledPluginCatalog.load(writable, uid)).toThrow('unsafe_bundled_plugins')
  const linked = embedding(); const target = join(linked, '..', 'real.json')
  writeFileSync(target, JSON.stringify({ schemaVersion: 1, plugins: [row] }))
  rmSync(join(linked, 'catalog.v1.json')); symlinkSync(target, join(linked, 'catalog.v1.json'))
  expect(() => BundledPluginCatalog.load(linked, uid)).toThrow('unsafe_bundled_plugins')
})

it('keeps historical signed versions addressable by exact archive digest', () => {
  const current = { ...row, version: '0.3.1', file: 'dsh-duet-0.3.1.tgz', sha256: 'b'.repeat(64) }
  const catalog = BundledPluginCatalog.load(embedding({ schemaVersion: 1, plugins: [current, row] }), uid)
  expect(catalog.get('dsh-duet', '0.3.0')?.sha256).toBe(digest)
  expect(catalog.getForDependency('dsh-duet', bundledDependencySpec(digest))?.version).toBe('0.3.0')
  expect(catalog.getForDependency('dsh-duet', bundledDependencySpec(current.sha256))?.version).toBe('0.3.1')
  expect(catalog.getForDependency('other', bundledDependencySpec(digest))).toBeUndefined()
  for (const duplicate of [{ ...row, file: 'other.tgz' }, { ...current, sha256: digest }]) {
    expect(() => BundledPluginCatalog.load(embedding({ schemaVersion: 1, plugins: [row, duplicate] }), uid))
      .toThrow('invalid_bundled_plugins')
  }
})

it('materializes verified archives into a content-addressed Profile directory without replacing content', () => {
  const catalog = BundledPluginCatalog.load(embedding(), uid)
  const plugin = catalog.get('dsh-duet', '0.3.0')!
  const { web } = webRoot()
  const path = catalog.materialize(plugin, web)
  expect(path).toBe(join(web, BUNDLED_ARCHIVE_DIRECTORY, `${digest}.tgz`))
  expect(readFileSync(path)).toEqual(archive)
  if (process.platform !== 'win32') {
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(web, BUNDLED_ARCHIVE_DIRECTORY)).mode & 0o777).toBe(0o700)
  }
  expect(catalog.materialize(plugin, web)).toBe(path)
  expect(readdirSync(join(web, BUNDLED_ARCHIVE_DIRECTORY))).toEqual([`${digest}.tgz`])
  writeFileSync(path, 'tampered')
  expect(() => catalog.materialize(plugin, web)).toThrow('bundled_plugin_conflict')
  expect(readFileSync(path, 'utf8')).toBe('tampered')
  expect(() => catalog.materialize({ ...plugin }, web)).toThrow('invalid_bundled_plugins')
})

it('anchors materialization in the ACL-protected parent chain where Windows reports mode 0666', () => {
  const root = embedding()
  // libuv reports every Windows-writable file as mode 0666; the POSIX mode-bit refusal must be
  // Windows-only, with ownership anchored by the verified private parent ACL chain instead.
  chmodSync(join(root, row.file), 0o666)
  chmodSync(root, 0o777)
  const { web } = webRoot()
  if (process.platform === 'win32') {
    const catalog = BundledPluginCatalog.load(root, uid)
    const path = catalog.materialize(catalog.get(row.name, row.version)!, web)
    expect(readFileSync(path)).toEqual(archive)
  } else {
    // On POSIX the permissive embedding root is refused at load time, before any copy runs.
    expect(() => BundledPluginCatalog.load(root, uid)).toThrow('unsafe_bundled_plugins')
  }
})

it('refuses an embedding archive whose bytes do not match the catalog and writes nothing', () => {
  const catalog = BundledPluginCatalog.load(embedding(undefined, Buffer.from('other bytes')), uid)
  const { web } = webRoot()
  expect(() => catalog.materialize(catalog.get('dsh-duet', '0.3.0')!, web)).toThrow('bundled_plugin_digest_mismatch')
  expect(existsSync(join(web, BUNDLED_ARCHIVE_DIRECTORY))).toBe(false)
})

it('reads only catalog-owned archive identities and refuses an empty archive', () => {
  const root = embedding()
  const catalog = BundledPluginCatalog.load(root, uid)
  const plugin = catalog.get('dsh-duet', '0.3.0')!
  expect(catalog.readArchive(plugin)).toEqual(archive)
  expect(() => catalog.readArchive({ ...plugin })).toThrow('invalid_bundled_plugins')
  writeFileSync(join(root, row.file), '')
  expect(() => catalog.readArchive(plugin)).toThrow('unsafe_bundled_plugins')
})

it('rejects an embedding archive truncated during its bounded read', () => {
  const catalog = BundledPluginCatalog.load(embedding(), uid)
  fsFaults.shortRead = true
  onTestFinished(() => { fsFaults.shortRead = false })
  expect(() => catalog.readArchive(catalog.get('dsh-duet', '0.3.0')!)).toThrow('bundled_plugin_digest_mismatch')
})

function commandFixture() {
  const root = temp('bundled-command-')
  const profile = join(root, 'profile'); const control = join(root, 'control')
  mkdirSync(join(profile, 'profiles', 'web', BUNDLED_ARCHIVE_DIRECTORY), { recursive: true, mode: 0o700 })
  mkdirSync(control, { mode: 0o700 })
  const cli = join(root, 'cli.cjs'); const pnpm = join(root, 'pnpm.cjs')
  writeFileSync(cli, "const {spawnSync}=require('node:child_process');const r=spawnSync('pnpm', process.argv.slice(5),{stdio:'inherit'});process.exit(r.status??1)")
  writeFileSync(pnpm, "require('node:fs').writeFileSync(process.env.DSH_HOME+'/observed.json',JSON.stringify(process.argv.slice(2)));")
  const archivePath = join(profile, 'profiles', 'web', BUNDLED_ARCHIVE_DIRECTORY, `${digest}.tgz`)
  writeFileSync(archivePath, archive, { mode: 0o600 })
  return { profile, archivePath, options: { nodeExecutablePath: process.execPath, dshEntrypointPath: cli, pnpmEntrypointPath: pnpm,
    profileRoot: profile, controlRoot: control, uid, signal: new AbortController().signal, guard() {} } }
}

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('installs a bundled source only from its Profile-owned archive, offline-first and without scripts', async () => {
  const f = commandFixture()
  await runProfilePluginCommand({ ...f.options, spec: 'bundled:dsh-duet@0.3.0', archivePath: f.archivePath })
  expect(JSON.parse(readFileSync(join(f.profile, 'observed.json'), 'utf8')))
    .toEqual(['add', `file:.bundled-plugins/${digest}.tgz`, '--save-exact', '--ignore-scripts', '--prefer-offline'])
})

it('rejects bundled sources without a verified archive and archives for other sources', async () => {
  const f = commandFixture()
  const outside = join(f.profile, `${digest}.tgz`); writeFileSync(outside, archive)
  const renamed = join(f.profile, 'profiles', 'web', BUNDLED_ARCHIVE_DIRECTORY, 'plugin.tgz'); writeFileSync(renamed, archive)
  const linked = join(f.profile, 'profiles', 'web', BUNDLED_ARCHIVE_DIRECTORY, `${'b'.repeat(64)}.tgz`); symlinkSync(outside, linked)
  for (const input of [
    { spec: 'bundled:dsh-duet@0.3.0' },
    { spec: 'dsh-duet@0.3.0', archivePath: f.archivePath },
    { spec: 'bundled:dsh-duet@0.3.0', archivePath: outside },
    { spec: 'bundled:dsh-duet@0.3.0', archivePath: renamed },
    { spec: 'bundled:dsh-duet@0.3.0', archivePath: linked },
    { spec: 'bundled:dsh-duet@0.3.0', archivePath: f.archivePath, allowBuild: 'dsh-duet@0.3.0' },
  ]) {
    await expect(runProfilePluginCommand({ ...f.options, ...input })).rejects.toThrow('invalid_plugin_command')
  }
  expect(existsSync(join(f.profile, 'observed.json'))).toBe(false)
})

function executorFixture(options: { catalog?: boolean; composed?: string[] } = {}) {
  const { profile, web } = webRoot()
  writeFileSync(join(web, 'package.json'), '{}', { mode: 0o600 })
  const install = vi.fn(async () => {})
  const executor = new ProfilePluginExecutor({
    resolve: () => profile, uid, install, acknowledge: async () => {},
    inspectScripts: async () => { throw Error('network preflight must not run for bundled sources') },
    ...(options.catalog === false ? {} : {
      bundledPlugin: (name: string, version: string) => name === 'dsh-duet' && version === '0.3.0'
        ? { entryIds: ['duplex-harness-control'], dependency: `file:.bundled-plugins/${digest}.tgz` } : undefined,
      composedEntryIds: () => new Set(options.composed ?? ['ui-conversation']),
    }),
  })
  return { executor, profileId: randomUUID(), install }
}
const bundledPayload = JSON.stringify({ packageName: 'dsh-duet', spec: 'bundled:dsh-duet@0.3.0' })

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('validates bundled installs against the embedding catalog and composed entry IDs', async () => {
  const ok = executorFixture()
  expect(() => { ok.executor.validate(ok.profileId, 'plugin', bundledPayload) }).not.toThrow()
  await expect(ok.executor.preflight(ok.profileId, 'plugin', bundledPayload)).resolves.toBeUndefined()
  expect(() => { ok.executor.validate(ok.profileId, 'plugin', JSON.stringify({ packageName: 'other', spec: 'bundled:dsh-duet@0.3.0' })) })
    .toThrow('invalid_plugin_input')
  expect(() => { ok.executor.validate(ok.profileId, 'plugin', JSON.stringify({ packageName: 'dsh-duet', spec: 'bundled:dsh-duet@0.2.7' })) })
    .toThrow('bundled_plugin_unavailable')
  const conflict = executorFixture({ composed: ['duplex-harness-control'] })
  expect(() => { conflict.executor.validate(conflict.profileId, 'plugin', bundledPayload) }).toThrow('plugin_entry_conflict')
  const legacy = executorFixture({ catalog: false })
  expect(() => { legacy.executor.validate(legacy.profileId, 'plugin', bundledPayload) }).toThrow('upgrade_required')
  expect(ok.install).not.toHaveBeenCalled()
})

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('accepts root-owned embeddings and refuses files owned by another user', () => {
  expect(() => BundledPluginCatalog.load('/usr', uid + 1)).toThrow(/ENOENT/u)
  expect(() => BundledPluginCatalog.load(embedding(), uid + 1)).toThrow('unsafe_bundled_plugins')
})

it('refuses non-object rows and empty or oversized catalogs', () => {
  expect(() => BundledPluginCatalog.load(embedding({ schemaVersion: 1, plugins: [null] }), uid)).toThrow('invalid_bundled_plugins')
  const empty = embedding(); writeFileSync(join(empty, 'catalog.v1.json'), '')
  expect(() => BundledPluginCatalog.load(empty, uid)).toThrow('invalid_bundled_plugins')
  const large = embedding(); writeFileSync(join(large, 'catalog.v1.json'), ' '.repeat(65_537))
  expect(() => BundledPluginCatalog.load(large, uid)).toThrow('invalid_bundled_plugins')
})

it('degrades to no catalog when the embedding is absent or damaged', () => {
  expect(BundledPluginCatalog.tryLoad(undefined, uid)).toBeUndefined()
  expect(BundledPluginCatalog.tryLoad(embedding({ schemaVersion: 9 }), uid)).toBeUndefined()
  expect(BundledPluginCatalog.tryLoad(embedding(), uid)?.get('dsh-duet', '0.3.0')?.sha256).toBe(digest)
})

it('resolves only exact bundled sources to materialized archives', () => {
  const catalog = BundledPluginCatalog.load(embedding(), uid)
  const { web } = webRoot()
  expect(catalog.archiveFor('dsh-duet@0.3.0', web)).toBeUndefined()
  expect(() => catalog.archiveFor('bundled:dsh-duet@0.2.7', web)).toThrow('bundled_plugin_unavailable')
  expect(catalog.archiveFor('bundled:dsh-duet@0.3.0', web)).toBe(join(web, BUNDLED_ARCHIVE_DIRECTORY, `${digest}.tgz`))
})

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('refuses missing or unsafe Profile archive directories and leaves no partial archive', () => {
  const catalog = BundledPluginCatalog.load(embedding(), uid)
  const plugin = catalog.get('dsh-duet', '0.3.0')!
  expect(() => catalog.materialize(plugin, join(temp('bundled-missing-'), 'absent', 'web'))).toThrow(/ENOENT/u)
  const unsafe = webRoot(); const unsafeArchives = join(unsafe.web, BUNDLED_ARCHIVE_DIRECTORY)
  mkdirSync(unsafeArchives); chmodSync(unsafeArchives, 0o777)
  expect(() => catalog.materialize(plugin, unsafe.web)).toThrow('unsafe_bundled_plugins')
  const faulty = webRoot()
  fsFaults.failRename = true
  onTestFinished(() => { fsFaults.failRename = false })
  expect(() => catalog.materialize(plugin, faulty.web)).toThrow('rename failed')
  expect(readdirSync(join(faulty.web, BUNDLED_ARCHIVE_DIRECTORY))).toEqual([])
})

// POSIX uid/mode security semantics; Windows anchors ownership in the ACL-verified parent chain.
it.runIf(process.platform !== 'win32')('allows bundled updates only for archives the embedding ships', () => {
  const { profile, web } = webRoot()
  writeFileSync(join(web, 'package.json'), JSON.stringify({ dependencies: { 'dsh-duet': '0.2.7' }, dsh: { profile: { bundles: ['dsh-duet'] } } }), { mode: 0o600 })
  const executor = new ProfilePluginExecutor({ resolve: () => profile, uid, install: async () => {}, acknowledge: async () => {},
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }), acknowledgeToggle: async () => {},
    bundledPlugin: (name, version) => version === '0.3.0' ? { entryIds: ['duplex-harness-control'], dependency: `file:.bundled-plugins/${name}.tgz` } : undefined })
  const update = (version: string) => JSON.stringify({ action: 'update', packageName: 'dsh-duet', spec: `bundled:dsh-duet@${version}` })
  expect(() => { executor.validate(randomUUID(), 'plugin', update('0.3.0')) }).not.toThrow()
  expect(() => { executor.validate(randomUUID(), 'plugin', update('0.3.1')) }).toThrow('bundled_plugin_unavailable')
})

it.runIf(process.platform !== 'win32')('keeps a temporary Bot team intact across interrupted bundled update and explicit completion', async () => {
  const oldBytes = Buffer.from('historical ds-bot archive')
  const nextBytes = Buffer.from('candidate ds-bot archive')
  const oldDigest = createHash('sha256').update(oldBytes).digest('hex')
  const nextDigest = createHash('sha256').update(nextBytes).digest('hex')
  const old = { ...row, name: 'ds-bot', version: '0.2.0', file: 'ds-bot-0.2.0.tgz', sha256: oldDigest, entryIds: ['bot'] }
  const next = { ...old, version: '0.2.3', file: 'ds-bot-0.2.3.tgz', sha256: nextDigest }
  const embeddingRoot = join(temp('bot-upgrade-embedding-'), 'dsh-default-plugins')
  mkdirSync(embeddingRoot, { mode: 0o755 })
  writeFileSync(join(embeddingRoot, 'catalog.v1.json'), JSON.stringify({ schemaVersion: 1, plugins: [next, old] }), { mode: 0o644 })
  writeFileSync(join(embeddingRoot, old.file), oldBytes, { mode: 0o644 })
  writeFileSync(join(embeddingRoot, next.file), nextBytes, { mode: 0o644 })
  const catalog = BundledPluginCatalog.load(embeddingRoot, uid)
  const { profile, web } = webRoot()
  catalog.materialize(catalog.get('ds-bot', '0.2.0')!, web)
  const manifest = join(web, 'package.json')
  const team = join(web, 'bot-team.fixture.json')
  const teamBytes = '{"bots":["Thanos"],"memory":"keep"}'
  writeFileSync(team, teamBytes, { mode: 0o600 })
  const original = { dependencies: { 'ds-bot': bundledDependencySpec(oldDigest), keep: '1.0.0' },
    dsh: { profile: { bundles: ['ds-bot', 'keep'] } } }
  writeFileSync(manifest, JSON.stringify(original), { mode: 0o600 })
  const control = join(profile, 'control'); mkdirSync(control, { mode: 0o700 })
  const profileId = randomUUID(); const authority = () => profileId
  let commands = 0; let ready = false
  const executor = new ProfilePluginExecutor({ resolve: () => profile, uid,
    install: async () => {
      commands++
      catalog.materialize(catalog.get('ds-bot', '0.2.3')!, web)
      writeFileSync(manifest, JSON.stringify({ ...original, dependencies: { ...original.dependencies,
        'ds-bot': bundledDependencySpec(nextDigest) } }), { mode: 0o600 })
      if (commands === 1) throw Error('interrupted after package write')
    },
    acknowledge: async () => { if (!ready) throw Error('worker not confirmed') },
    togglePlan: () => ({ patch: '', expected: [], disabled: [], previousExpected: [], previousDisabled: [] }),
    acknowledgeToggle: async () => {},
    bundledPlugin: (name, version) => {
      const plugin = catalog.get(name, version)
      return plugin ? { entryIds: plugin.entryIds, dependency: bundledDependencySpec(plugin.sha256) } : undefined
    },
  })
  const operations = new ProfileExtensionOperations(new FileExtensionReceipts(join(control, 'extension-receipts'), uid),
    executor, { now: Date.now })
  onTestFinished(async () => { await operations.dispose() })
  const payload = JSON.stringify({ action: 'update', packageName: 'ds-bot', spec: 'bundled:ds-bot@0.2.3' })
  const plan = await operations.prepare(authority, 'plugin', payload)
  const id = randomUUID()
  operations.commit(authority, plan.planId, id); await operations.settled()
  expect(operations.status(authority, id)).toMatchObject({ state: 'unknown', canComplete: true,
    pluginPackage: { action: 'update', spec: 'bundled:ds-bot@0.2.3' } })
  expect(readFileSync(team, 'utf8')).toBe(teamBytes)
  expect(readdirSync(join(web, BUNDLED_ARCHIVE_DIRECTORY)).sort()).toEqual([`${oldDigest}.tgz`, `${nextDigest}.tgz`].sort())
  ready = true
  const completion = await operations.prepare(authority, 'plugin', JSON.stringify({ action: 'complete-package', operationId: id }))
  const completionId = randomUUID()
  operations.commit(authority, completion.planId, completionId); await operations.settled()
  expect(operations.status(authority, completionId)).toMatchObject({ state: 'succeeded', restores: id })
  expect(operations.status(authority, id)).toMatchObject({ state: 'unknown', completedBy: completionId })
  expect((await executor.inventory(profileId)).find(entry => entry.name === 'ds-bot')?.plugin_archive_sha256).toBe(nextDigest)
  expect(readFileSync(team, 'utf8')).toBe(teamBytes)
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ dependencies: { keep: '1.0.0' } })
})
