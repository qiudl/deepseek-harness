/** Read-only Remote gateway over the current Cordis plugin catalog capability. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-plugin-catalog'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import type { PluginCatalogPage, PluginCatalogQuery } from './types.ts'

export type * from './types.ts'

/** Cordis Remote namespace serving deterministic catalog pages. */
export class PluginCatalogGateway extends TypertRemoteService {
  static inject = ['pluginCatalog', 'loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginCatalogGateway')
  }

  /** Query the provider's current immutable revision. */
  @Remote('search')
  search(query: PluginCatalogQuery): PluginCatalogPage {
    const installedModules = new Set([...this.ctx.loader.entries()]
      .filter(entry => !entry.options.group)
      .map(entry => entry.options.name))
    const installedEntryIds = this.ctx.pluginCatalog.current()?.entries
      .filter(entry => entry.packageName !== undefined && installedModules.has(entry.packageName))
      .map(entry => entry.entryId) ?? []
    return this.ctx.pluginCatalog.query({ ...query, installedEntryIds })
  }
}

export default PluginCatalogGateway
