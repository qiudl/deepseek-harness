/** Read-only model-facing search over the current Slark plugin catalog revision. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-plugin-catalog'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { CatalogQueryV1 } from '@deepseek-ai/dsh-plugin-catalog'

/** Cordis plugin name. */
export const name = 'tool-plugin-catalog'
/** Capabilities required by this read-only consumer. */
export const inject = ['tools', 'systemPrompt', 'pluginCatalog']

const PARAMETERS = {
  query: { type: 'string' as const, description: 'Words describing the desired plugin capability.' },
  categories: { type: 'array' as const, items: { type: 'string' as const }, description: 'Exact catalog categories to include.' },
  sourceKinds: {
    type: 'array' as const,
    items: { type: 'string' as const, enum: ['github', 'npm', 'tarball'] },
    description: 'Allowed source declaration kinds.',
  },
  distributions: {
    type: 'array' as const,
    items: { type: 'string' as const, enum: ['prebuilt', 'source'] },
    description: 'Distribution shape. Prebuilt means npm or declared release archive, not an assertion that lifecycle scripts are absent.',
  },
  sort: { type: 'string' as const, enum: ['relevance', 'name'], description: 'Stable result ordering.' },
  cursor: { type: 'string' as const, description: 'Opaque cursor returned by the previous page.' },
  limit: { type: 'integer' as const, description: 'Maximum results, from 1 through 50.' },
}

const INTENT_KEYS = new Set(Object.keys(PARAMETERS))

/** Reject capability creep before a model-authored object reaches the catalog service. */
export function parseQueryIntent(value: unknown): CatalogQueryV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('plugin_search: intent must be an object')
  }
  const intent = value as Record<string, unknown>
  if (Object.keys(intent).some(key => !INTENT_KEYS.has(key))) {
    throw new TypeError('plugin_search: intent contains an undeclared field')
  }
  return intent
}

/** Register the catalog search tool and its model guidance. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:plugin-catalog',
    order: 114,
    text: 'Use plugin_search when the user asks to find or browse DSH plugins. Treat returned entries as catalog candidates, not installed or trusted software. This tool never installs anything.',
  })
  ctx.tools.register(defineTool({
    name: 'plugin_search',
    description: 'Search the current validated DSH plugin catalog. Read-only: it cannot install or execute plugins.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    execute: args => Promise.resolve(JSON.stringify(ctx.pluginCatalog.query(parseQueryIntent(args)))),
    presentCall: args => ({
      card: 'generic',
      title: typeof args.query === 'string' && args.query.length > 0 ? `Search plugins: ${args.query}` : 'Browse plugins',
      kind: 'read',
      rawInput: JSON.stringify(args),
    }),
  }))
}
