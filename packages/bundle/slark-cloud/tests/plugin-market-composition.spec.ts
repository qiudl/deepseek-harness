import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginCatalogGateway from '@deepseek-ai/dsh-host-plugin-catalog-gateway'
import { buildCatalogSnapshot } from '@deepseek-ai/dsh-plugin-catalog'
import FilePluginCatalog from '@deepseek-ai/dsh-plugin-catalog-file'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolPluginCatalog from '@deepseek-ai/dsh-tool-plugin-catalog'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Slark plugin market through a real Loader composition', () => {
  it('activates ordinary Cordis rows and exposes discovery without a write capability', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-plugin-market-loader-'))
    const catalogRoot = join(root, 'catalog')
    await mkdir(join(catalogRoot, 'data/plugins'), { recursive: true })
    const source = [
      'url: https://github.com/example/dsh-search',
      'name: example/dsh-search',
      'category: tools',
      'description: { en: Natural-language plugin search }',
      '',
    ].join('\n')
    await writeFile(join(catalogRoot, 'data/plugins/search.yml'), source)
    await writeFile(join(catalogRoot, 'plugins.json'), JSON.stringify({ plugins: [{
      url: 'https://github.com/example/dsh-search',
      npm: '@deepseek-ai/dsh-tool-plugin-catalog',
    }] }))
    const manifestPath = join(catalogRoot, 'manifest.json')
    const expectedRevision = buildCatalogSnapshot({
      sourceCommit: 'a'.repeat(40), generatedAt: new Date().toISOString(),
      files: [{ path: 'data/plugins/search.yml', content: source }],
      packages: [{ repositoryUrl: 'https://github.com/example/dsh-search', packageName: '@deepseek-ai/dsh-tool-plugin-catalog' }],
    }).revision
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      expectedRevision,
      generatedAt: new Date().toISOString(),
      files: ['data/plugins/search.yml'],
      registry: 'plugins.json',
    }))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-plugin-catalog-file'",
      '  config:',
      `    manifestPath: ${JSON.stringify(manifestPath)}`,
      "- name: '@deepseek-ai/dsh-host-plugin-catalog-gateway'",
      "- name: '@deepseek-ai/dsh-tool-plugin-catalog'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-plugin-catalog-file', FilePluginCatalog],
      ['@deepseek-ai/dsh-host-plugin-catalog-gateway', PluginCatalogGateway],
      ['@deepseek-ai/dsh-tool-plugin-catalog', ToolPluginCatalog],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['plugin_search'])
    const gateway = ctx.get('pluginCatalogGateway') as PluginCatalogGateway
    expect(remoteMethods(gateway).map(marker => marker.method)).toEqual(['search'])
    expect(gateway.search({ installed: 'yes' })).toMatchObject({ total: 1 })
    expect(ctx.tools.schemas().some(schema => /install|add|remove/i.test(schema.name))).toBe(false)
  })
})
