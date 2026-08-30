import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { MemoryPluginCatalog } from '@deepseek-ai/dsh-plugin-catalog'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import PluginCatalogGateway from '../src/index.ts'

const source = `url: https://github.com/example/dsh-memory
name: example/dsh-memory
category: memory
description: { en: Project memory }
`

describe('PluginCatalogGateway', () => {
  it('is a read-only Cordis Remote over the active catalog service', async () => {
    const ctx = new Context()
    class LoaderService extends Service {
      constructor(inner: Context) { super(inner, 'loader') }
      entries() {
        return [
          { options: { name: '@deepseek-ai/dsh-plugin-catalog', group: false }, disabled: true },
          { options: { name: '@deepseek-ai/dsh-group-only', group: true }, disabled: false },
        ]
      }
    }
    new LoaderService(ctx)
    await ctx.plugin(MemoryPluginCatalog)
    const catalog = ctx.pluginCatalog as MemoryPluginCatalog
    catalog.refresh({
      sourceCommit: 'a'.repeat(40),
      generatedAt: new Date().toISOString(),
      files: [{ path: 'memory.yml', content: source }],
      packages: [{ repositoryUrl: 'https://github.com/example/dsh-memory', packageName: '@deepseek-ai/dsh-plugin-catalog' }],
    })
    await ctx.plugin(PluginCatalogGateway)

    const gateway = ctx.get('pluginCatalogGateway') as PluginCatalogGateway
    expect(remoteMethods(gateway)).toEqual([expect.objectContaining({ method: 'search' })])
    expect(gateway.search({ query: 'memory' })).toMatchObject({
      revision: ctx.pluginCatalog.current()!.revision,
      total: 1,
      items: [expect.objectContaining({ ownerName: 'example/dsh-memory' })],
    })
    expect(gateway.search({ installed: 'yes' }).total).toBe(1)
    expect(gateway.search({ installed: 'no' }).total).toBe(0)
    expect(gateway.search({ sourceKinds: ['npm'] }).total).toBe(1)
    expect(gateway.search({ sourceKinds: ['github'] }).total).toBe(0)
    expect(gateway.search({ installed: 'no', installedEntryIds: ['0'.repeat(32)] } as never).total).toBe(0)
  })
})
