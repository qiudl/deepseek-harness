import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { inspectExistingPluginClosure, type ExistingPluginRecoveryOptions } from '../src/existing-plugin-recovery.ts'

const faults = vi.hoisted(() => ({ paths: new Map<string, 'denied' | 'uncoded' | 'nonerror'>(), rootFiles: new Set<string>() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    realpath: async (path: string) => {
      const fault = faults.paths.get(path)
      if (fault === 'denied') throw Object.assign(Error('private filesystem detail'), { code: 'EACCES' })
      if (fault === 'uncoded') throw Error('private filesystem detail')
      if (fault === 'nonerror') throw 'private filesystem detail'
      return actual.realpath(path)
    },
    lstat: async (path: string) => {
      const value = await actual.lstat(path)
      if (faults.rootFiles.has(path)) value.uid = 0
      return value
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (faults.rootFiles.has(String(args[0]))) {
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementation(async () => { const value = await stat(); value.uid = 0; return value })
      }
      return handle
    },
  }
})

const uid = process.getuid?.() ?? 0
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-closure-')))
  onTestFinished(async () => { faults.paths.clear(); faults.rootFiles.clear(); await rm(root, { recursive: true, force: true }) })
  const web = join(root, 'web')
  await mkdir(join(web, 'node_modules'), { recursive: true, mode: 0o700 })
  const options: ExistingPluginRecoveryOptions = { webRoot: web, expectedUid: uid,
    dependencies: { a: '1.0.0' }, names: ['a'], runtimeRoots: [],
    digestTree: async () => ({ digest: 'a'.repeat(64), entries: 1, bytes: 1 }) }
  const save = async (dependencies: Record<string, unknown> = { a: '1.0.0' }) => {
    await writeFile(join(web, 'package.json'), JSON.stringify({ dependencies }))
    await writeFile(join(web, 'pnpm-lock.yaml'), JSON.stringify({ lockfileVersion: '9.0', importers: {
      '.': { dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, specifier]) => [name, { specifier }])) },
    } }))
  }
  const pkg = async (name: string, manifest: Record<string, unknown> = { name, version: '1.0.0' }) => {
    const path = join(web, 'node_modules', name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await writeFile(join(path, 'package.json'), JSON.stringify(manifest))
    return path
  }
  await save(); await pkg('a')
  return { root, web, options, save, pkg }
}

describe('existing plugin recovery input and resource boundaries', () => {
  it('binds multiple declarations and rejects an absent installed package', async () => {
    const value = await fixture()
    await value.save({ a: '1.0.0', b: '1.0.0' }); await value.pkg('b')
    await expect(inspectExistingPluginClosure({ ...value.options, dependencies: { a: '1.0.0', b: '1.0.0' }, names: ['b', 'a'] })).resolves.toMatch(/^[a-f0-9]{64}$/u)
    await rm(join(value.web, 'node_modules/a'), { recursive: true })
    await expect(inspectExistingPluginClosure(value.options)).resolves.toBeUndefined()
  })

  it.each(['array', 'empty', 'directory', 'linked', 'hardlinked', 'public', 'setuid', 'oversized', 'foreign'])('rejects %s manifest metadata', async (kind) => {
    const value = await fixture(); const path = join(value.web, 'package.json')
    if (kind === 'array') await writeFile(path, '[]')
    if (kind === 'empty') await writeFile(path, '')
    if (kind === 'directory') { await rm(path); await mkdir(path) }
    if (kind === 'linked') { await rm(path); await symlink(join(value.web, 'pnpm-lock.yaml'), path) }
    if (kind === 'hardlinked') await link(path, join(value.root, 'hardlink'))
    if (kind === 'public') await chmod(path, 0o666)
    if (kind === 'setuid') await chmod(path, 0o4600)
    if (kind === 'oversized') await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1))
    await expect(inspectExistingPluginClosure(kind === 'foreign' ? { ...value.options, expectedUid: uid + 1 } : value.options))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('allows root-owned manifests only inside the packaged runtime', async () => {
    const value = await fixture()
    for (const path of [join(value.web, 'package.json'), join(value.web, 'pnpm-lock.yaml'), join(value.web, 'node_modules/a/package.json')]) faults.rootFiles.add(path)
    await expect(inspectExistingPluginClosure({ ...value.options, runtimeRoots: [value.web] })).resolves.toMatch(/^[a-f0-9]{64}$/u)
    faults.rootFiles.clear()
    await expect(inspectExistingPluginClosure({ ...value.options, expectedUid: uid + 1, runtimeRoots: [value.web] })).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['null-lock', 'numeric-spec', 'manifest-mismatch'])('keeps %s unsupported', async (kind) => {
    const value = await fixture()
    if (kind === 'null-lock') await writeFile(join(value.web, 'pnpm-lock.yaml'), 'null')
    if (kind === 'numeric-spec') await value.save({ a: 42 })
    if (kind === 'manifest-mismatch') await value.save({ a: '2.0.0' })
    await expect(inspectExistingPluginClosure({ ...value.options, dependencies: kind === 'numeric-spec' ? { a: 42 } : value.options.dependencies })).resolves.toBeUndefined()
  })

  it('rejects invalid names, identities and version mismatches', async () => {
    const value = await fixture()
    await expect(inspectExistingPluginClosure({ ...value.options, names: ['../escape'] })).rejects.toMatchObject({ code: 'runtime_incompatible' })
    await value.pkg('a', { name: 'a', version: '2.0.0' })
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('allows a declared internal link and refuses undeclared external targets', async () => {
    const value = await fixture(); const installed = join(value.web, 'node_modules/a'); const inside = join(value.web, 'source')
    await mkdir(inside); await writeFile(join(inside, 'package.json'), '{"name":"a","version":"1.0.0"}')
    await rm(installed, { recursive: true }); await symlink(inside, installed)
    const spec = 'link:source'; await value.save({ a: spec })
    await expect(inspectExistingPluginClosure({ ...value.options, dependencies: { a: spec } })).resolves.toMatch(/^[a-f0-9]{64}$/u)
    const outside = join(value.root, 'outside'); await mkdir(outside)
    await rm(installed); await symlink(outside, installed)
    await expect(inspectExistingPluginClosure({ ...value.options, dependencies: { a: spec } })).rejects.toMatchObject({ code: 'runtime_incompatible' })
    await value.save()
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['entries', 'bytes'])('bounds aggregate closure %s', async (kind) => {
    const value = await fixture()
    await expect(inspectExistingPluginClosure({ ...value.options, digestTree: async () => ({ digest: 'a'.repeat(64),
      entries: kind === 'entries' ? 100_001 : 1, bytes: kind === 'bytes' ? 2 * 1024 * 1024 * 1024 + 1 : 1 }) }))
      .rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])('rejects malformed %s', async (field) => {
    const value = await fixture(); await value.pkg('a', { name: 'a', version: '1.0.0', [field]: [] })
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['../escape', 'bad-spec', 'empty-spec'])('rejects malformed dependency %s', async (kind) => {
    const value = await fixture(); await value.pkg('a', { name: 'a', version: '1.0.0', dependencies: { [kind === '../escape' ? kind : 'nested']: kind === 'bad-spec' ? 42 : '' } })
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['denied', 'uncoded', 'nonerror'] as const)('preserves denial for %s filesystem faults in both resolution paths', async (fault) => {
    const value = await fixture(); await value.pkg('a', { name: 'a', version: '1.0.0', dependencies: { nested: '1.0.0' } })
    const candidate = join(value.web, 'node_modules/a/node_modules/nested'); faults.paths.set(candidate, fault)
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
    faults.paths.clear(); const runtime = join(value.root, 'runtime'); faults.paths.set(join(runtime, 'node_modules/nested'), fault)
    await expect(inspectExistingPluginClosure({ ...value.options, runtimeRoots: [runtime] })).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it('refuses transitive links escaping an approved root and wrong transitive identities', async () => {
    const value = await fixture(); await value.pkg('a', { name: 'a', version: '1.0.0', dependencies: { nested: '1.0.0' } })
    const outside = join(value.root, 'outside'); await mkdir(outside)
    const link = join(value.web, 'node_modules/nested'); await symlink(outside, link)
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
    await rm(link); await value.pkg('nested', { name: 'other', version: '1.0.0' })
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })

  it.each(['npm:bad', 'npm:Bad@1.0.0', 'npm:nested@^1.0.0'])('refuses unpinned or malformed alias %s', async (spec) => {
    const value = await fixture(); await value.pkg('a', { name: 'a', version: '1.0.0', dependencies: { nested: spec } }); await value.pkg('nested')
    await expect(inspectExistingPluginClosure(value.options)).rejects.toMatchObject({ code: 'runtime_incompatible' })
  })
})
