import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

function artifact(): string | undefined {
  try { return readFileSync('packages/host/desktop-host/lib/host-control-client.js', 'utf8') } catch { return undefined }
}

describe('standalone Host control client artifact', () => {
  const source = artifact()

  it.skipIf(source === undefined)('imports only Node builtins and loads from an otherwise empty directory', async () => {
    const imports = [...source!.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)].map(match => match[2])
    expect(imports.every(specifier => specifier?.startsWith('node:'))).toBe(true)
    expect(source).not.toMatch(/\brequire\s*\(/u)
    expect(source).not.toMatch(/createServer|UnixHostServer|ProfileRegistry|FileHostJournal|node:http|fastify/u)
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-client-artifact-'))
    const target = join(root, 'host-control-client.mjs')
    copyFileSync('packages/host/desktop-host/lib/host-control-client.js', target)
    const loaded = await import(pathToFileURL(target).href) as {
      readonly UnixHostClient?: unknown
      readonly discoverUnixHost?: unknown
    }
    expect(loaded.UnixHostClient).toBeTypeOf('function')
    expect(loaded.discoverUnixHost).toBeTypeOf('function')
  })
})
