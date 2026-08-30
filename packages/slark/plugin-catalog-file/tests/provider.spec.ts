import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildCatalogSnapshot } from '@deepseek-ai/dsh-plugin-catalog'
import FilePluginCatalog from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(files = ['data/plugins/memory.yml'], registry = true): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-file-')); roots.push(root)
  await mkdir(join(root, 'data/plugins'), { recursive: true })
  const content = 'url: https://github.com/example/dsh-memory\nname: example/dsh-memory\ncategory: memory\ndescription: { en: Project memory }\n'
  await writeFile(join(root, 'data/plugins/memory.yml'), content)
  const manifest = join(root, 'manifest.json')
  if (registry) await writeFile(join(root, 'plugins.json'), JSON.stringify({ plugins: [{ url: 'https://github.com/example/dsh-memory', npm: 'dsh-memory' }] }))
  const expectedRevision = buildCatalogSnapshot({
    sourceCommit: 'a'.repeat(40), generatedAt: new Date().toISOString(),
    files: [{ path: 'data/plugins/memory.yml', content }],
    packages: registry ? [{ repositoryUrl: 'https://github.com/example/dsh-memory', packageName: 'dsh-memory' }] : [],
  }).revision
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1, sourceCommit: 'a'.repeat(40), expectedRevision,
    generatedAt: new Date().toISOString(), files, ...(registry ? { registry: 'plugins.json' } : {}),
  }))
  return { root, manifest }
}

describe('FilePluginCatalog', () => {
  it('registers ctx.pluginCatalog from one immutable manifest', async () => {
    const { manifest } = await fixture()
    const ctx = new Context(); const fiber = ctx.plugin(FilePluginCatalog, { manifestPath: manifest }); await fiber.await()
    expect(ctx.pluginCatalog.current()?.entries[0]?.ownerName).toBe('example/dsh-memory')
    expect(ctx.pluginCatalog.current()?.entries[0]?.packageName).toBe('dsh-memory')
  })
  it('fails closed for traversal, duplicate, and relative manifests', async () => {
    const { manifest } = await fixture(['../escape.yml'])
    const ctx = new Context(); await expect(ctx.plugin(FilePluginCatalog, { manifestPath: manifest }).await()).rejects.toThrow()
    const relativeCtx = new Context(); await expect(relativeCtx.plugin(FilePluginCatalog, { manifestPath: 'manifest.json' }).await()).rejects.toThrow(/absolute/)
    const duplicate = await fixture(['data/plugins/memory.yml', 'data/plugins/memory.yml'])
    const duplicateCtx = new Context()
    await expect(duplicateCtx.plugin(FilePluginCatalog, { manifestPath: duplicate.manifest }).await()).rejects.toThrow(/duplicate/)
  })
  it('fails closed when the deployment omits the package registry required by installed filtering', async () => {
    const { manifest } = await fixture(undefined, false)
    const ctx = new Context()
    await expect(ctx.plugin(FilePluginCatalog, { manifestPath: manifest }).await()).rejects.toThrow(/manifest/)
  })
  it('fails closed when catalog content drifts from the deployment-pinned revision', async () => {
    const { root, manifest } = await fixture()
    await writeFile(join(root, 'data/plugins/memory.yml'), 'url: https://github.com/example/dsh-memory\nname: example/dsh-memory\ncategory: memory\ndescription: { en: Changed }\n')
    const ctx = new Context()
    await expect(ctx.plugin(FilePluginCatalog, { manifestPath: manifest }).await()).rejects.toThrow(/expected revision/)
  })
})
