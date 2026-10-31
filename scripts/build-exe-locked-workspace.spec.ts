import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { prepareLockedDeployWorkspace, removeLockedDeployMetadata, restoreLockedDeployManifest,
  verifyLockedDeployDependencies } from './build-exe-locked-workspace.ts'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-locked-fixture-'))
  for (const path of ['apps', 'benchmarks', 'native', 'packages/subprocess/subprocess-local', 'patches', 'python', 'snapshots', 'vendor', 'website']) {
    await mkdir(join(root, path), { recursive: true })
  }
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, '.gitignore'), 'ignored-output\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), '{}')
  await writeFile(join(root, 'pnpm-workspace.yaml'), "allowBuilds:\n  '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local': true\n  protobufjs: false\n")
  await writeFile(join(root, 'packages/subprocess/subprocess-local/package.json'), '{"name":"@deepseek-ai/dsh-subprocess-local"}')
  return root
}

it('preserves reviewed policy while adding only the copied subprocess file identity and excluding credentials', async () => {
  const source = await fixture()
  try {
    await writeFile(join(source, 'packages/.env'), 'secret')
    await writeFile(join(source, 'packages/private.p8'), 'secret')
    await writeFile(join(source, 'packages/cache.tsbuildinfo'), 'stale')
    await mkdir(join(source, 'packages/node_modules'))
    const generated = join(source, 'python/sdk-runtime/src/deepseek_harness_runtime/runtime')
    await mkdir(generated, { recursive: true })
    await writeFile(join(generated, 'old-executable'), 'stale')
    const shadow = await prepareLockedDeployWorkspace(source)
    try {
      const config = load(await readFile(join(shadow.root, 'pnpm-workspace.yaml'), 'utf8')) as { allowBuilds: Record<string, boolean> }
      const exact = `@deepseek-ai/dsh-subprocess-local@${pathToFileURL(join(shadow.root, 'packages/subprocess/subprocess-local')).href}`
      expect(config.allowBuilds[exact]).toBe(true)
      expect(config.allowBuilds.protobufjs).toBe(false)
      await expect(readFile(join(shadow.root, 'packages/.env'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(shadow.root, 'packages/private.p8'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(shadow.root, 'packages/cache.tsbuildinfo'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(shadow.root, 'packages/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(shadow.root, 'python/sdk-runtime/src/deepseek_harness_runtime/runtime/old-executable')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(source, 'pnpm-workspace.yaml'), 'utf8')).not.toContain(exact)
    } finally { await shadow.dispose() }
  } finally { await rm(source, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('rejects a source symlink escaping the workspace', async () => {
  const source = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-locked-outside-'))
  try {
    await symlink(relative(join(source, 'packages'), outside), join(source, 'packages/escape'))
    await expect(prepareLockedDeployWorkspace(source)).rejects.toThrow('workspace symlink')
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

it('does not grant a build script absent an existing exact approval', async () => {
  const source = await fixture()
  try {
    await writeFile(join(source, 'pnpm-workspace.yaml'), "allowBuilds:\n  '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local': false\n")
    await expect(prepareLockedDeployWorkspace(source)).rejects.toThrow('local subprocess build is not approved')
  } finally { await rm(source, { recursive: true, force: true }) }
})

it('removes ephemeral dependency paths and rejects a changed dependency set', async () => {
  const root = await fixture()
  try {
    const source = join(root, 'source.json')
    await writeFile(source, JSON.stringify({ dependencies: { a: 'workspace:*' } }))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { a: 'file:///temporary/a' } }))
    await restoreLockedDeployManifest(root, source)
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toEqual({ name: 'fixture', dependencies: { a: 'workspace:*' } })
    await writeFile(source, JSON.stringify({ dependencies: { b: 'workspace:*' } }))
    await expect(restoreLockedDeployManifest(root, source)).rejects.toThrow('dependencies drift')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('removes deployment metadata without deleting installed package contents', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, 'node_modules/.pnpm'), { recursive: true })
    await writeFile(join(root, 'node_modules/.pnpm/lock.yaml'), 'temporary path')
    await writeFile(join(root, 'node_modules/.pnpm/package.bin'), 'package')
    await writeFile(join(root, 'node_modules/.modules.yaml'), 'temporary path')
    await removeLockedDeployMetadata(root)
    await expect(readFile(join(root, 'node_modules/.pnpm/lock.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'node_modules/.pnpm/package.bin'), 'utf8')).toBe('package')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a missing or incorrectly identified direct runtime dependency', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@scope/runtime': 'workspace:*' } }))
    await expect(verifyLockedDeployDependencies(root)).rejects.toMatchObject({ code: 'ENOENT' })
    const directory = join(root, 'node_modules/@scope/runtime')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@scope/other' }))
    await expect(verifyLockedDeployDependencies(root)).rejects.toThrow('identity mismatch')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@scope/runtime' }))
    await expect(verifyLockedDeployDependencies(root)).resolves.toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
