import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const desktopRuntimeSources = [
  'packages/session/session-persistence/src/errors.ts',
  'packages/session/session-persistence-jsonl/src/format.ts',
  'packages/session/session-persistence-jsonl/src/migration-export-source.ts',
  'packages/session/session-persistence-jsonl/src/migration-export.ts',
  'packages/session/session-persistence-jsonl/src/migration-import.ts',
]

describe('Desktop runtime package imports', () => {
  it.each(desktopRuntimeSources)('%s uses published package entrypoints', (path) => {
    const source = readFileSync(resolve(root, path), 'utf8')
    expect(source).not.toMatch(/from ['"]@deepseek-ai\/[^'"]+\/src\//u)
  })

  it('publishes the session sequence-range runtime entrypoint', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'packages/core/session/package.json'), 'utf8'),
    ) as { exports?: Record<string, { default?: string }> }
    expect(manifest.exports?.['./seq-ranges']?.default).toBe('./lib/types/seq-ranges.js')
  })
})
