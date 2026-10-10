import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { create } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { inspectBundledPluginInstallation } from '../src/bundled-plugin-recovery.ts'
import { bundledRecoveryFixture } from './fixtures/bundled-recovery.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundled-recovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const web = join(root, 'web')
  await mkdir(web, { mode: 0o700 })
  return { root, web, ...await bundledRecoveryFixture(root, web) }
}

it('verifies the released scoped bundled layout including bundled dependencies without writes', async () => {
  const value = await fixture()
  const before = await readFile(value.source)
  const first = await value.catalog.inspectInstalled(value.row.name, value.spec, value.web)
  expect(first).toMatch(/^[a-f0-9]{64}$/u)
  expect(await value.catalog.inspectInstalled(value.row.name, value.spec, value.web)).toBe(first)
  expect(await readFile(value.source)).toEqual(before)
  expect(await value.catalog.inspectInstalled('unknown', value.spec, value.web)).toBeUndefined()
  expect(await value.catalog.inspectInstalled(value.row.name, '1.0.0', value.web)).toBeUndefined()
})

it.each([
  ['changed installed bytes', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(join(v.installed, 'lib/index.js'), 'changed')],
  ['extra installed file', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(join(v.installed, 'extra.js'), 'extra')],
  ['missing installed file', async (v: Awaited<ReturnType<typeof fixture>>) => unlink(join(v.installed, 'lib/index.js'))],
  ['changed Profile archive', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(v.source, 'changed')],
  ['changed embedding archive', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(join(v.embedding, v.row.file), 'changed')],
  ['missing Profile archive', async (v: Awaited<ReturnType<typeof fixture>>) => unlink(v.source)],
  ['wrong package identity', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(join(v.installed, 'package.json'), '{"name":"different","version":"1.0.0"}')],
  ['wrong package version', async (v: Awaited<ReturnType<typeof fixture>>) => writeFile(join(v.installed, 'package.json'), JSON.stringify({ name: v.row.name, version: '2.0.0' }))],
  ['unsafe file permissions', async (v: Awaited<ReturnType<typeof fixture>>) => chmod(join(v.installed, 'lib/index.js'), 0o666)],
  ['unsafe directory permissions', async (v: Awaited<ReturnType<typeof fixture>>) => chmod(join(v.installed, 'lib'), 0o777)],
  ['external file link', async (v: Awaited<ReturnType<typeof fixture>>) => {
    await unlink(join(v.installed, 'lib/index.js')); await symlink(v.source, join(v.installed, 'lib/index.js'))
  }],
  ['linked archive directory', async (v: Awaited<ReturnType<typeof fixture>>) => {
    await rm(join(v.web, '.bundled-plugins'), { recursive: true }); await symlink(v.embedding, join(v.web, '.bundled-plugins'))
  }],
])('rejects %s before executing or installing anything', async (_name, mutate) => {
  const value = await fixture()
  await mutate(value)
  await expect(value.catalog.inspectInstalled(value.row.name, value.spec, value.web)).rejects.toThrow()
})

it.each(['importer', 'specifier', 'version', 'package', 'packageVersion', 'resolution', 'tarball', 'integrity'] as const)(
  'rejects a mismatched lockfile %s', async (field) => {
    const value = await fixture()
    const lock = structuredClone(value.lock)
    const importer = lock.importers['.'].dependencies[value.row.name]!
    const row = lock.packages[`${value.row.name}@${value.spec}`]!
    if (field === 'importer') Reflect.deleteProperty(lock, 'importers')
    else if (field === 'package') Reflect.deleteProperty(lock, 'packages')
    else if (field === 'specifier' || field === 'version') importer[field] = 'other'
    else if (field === 'packageVersion') row.version = 'other'
    else if (field === 'resolution') Reflect.deleteProperty(row, 'resolution')
    else row.resolution[field] = 'other'
    await writeFile(join(value.web, 'pnpm-lock.yaml'), JSON.stringify(lock))
    await expect(value.catalog.inspectInstalled(value.row.name, value.spec, value.web)).rejects.toThrow()
  },
)

it('rejects malformed gzip and an unexpected owner', async () => {
  const value = await fixture()
  await expect(inspectBundledPluginInstallation(value.web, value.row, Buffer.from('not gzip'), process.getuid?.() ?? 0)).rejects.toThrow()
  await expect(inspectBundledPluginInstallation(value.web, value.row, value.archive, -1)).rejects.toThrow()
  const invalidTar = gzipSync(Buffer.alloc(1024, 1))
  await expect(inspectBundledPluginInstallation(value.web, value.row, invalidTar, process.getuid?.() ?? 0)).rejects.toThrow()
})

it.each([
  ['directory entry', ['package']],
  ['missing manifest', ['package/lib/index.js']],
  ['duplicate path', ['package/package.json', 'package/package.json']],
])('rejects an archive with %s', async (_name, files) => {
  const value = await fixture()
  const archive = await create({ gzip: true, cwd: join(value.root, 'packed') }, files).concat()
  await expect(inspectBundledPluginInstallation(value.web, value.row, archive, process.getuid?.() ?? 0)).rejects.toThrow()
})
