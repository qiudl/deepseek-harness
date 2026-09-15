import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)

describe('Windows Host Worker package artifact', () => {
  it('ships the Windows-only startup composition without a public launcher export', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      readonly files?: readonly string[]
      readonly exports?: Readonly<Record<string, unknown>>
    }
    expect(manifest.files).toContain('lib/windows-startup.js')
    expect(manifest.exports).not.toHaveProperty('./windows-startup')
    expect(readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')).toContain(
      "entry: { 'windows-startup': 'lib/types/windows-startup.js' }",
    )
  })

  it('ships a dedicated bundle without exposing a new public package entry', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      readonly files?: readonly string[]
      readonly exports?: Readonly<Record<string, unknown>>
    }
    const bundleConfig = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')
    expect(manifest.files).toContain('lib/windows-host-pipe-worker-entry.js')
    expect(manifest.exports).not.toHaveProperty('./windows-host-pipe-worker-entry')
    expect(bundleConfig).toContain(
      "entry: { 'windows-host-pipe-worker-entry': 'lib/types/windows-host-pipe-worker-entry.js' }",
    )
  })

  it('ships the private identity bootstrap beside the runtime without a public package entry', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      readonly files?: readonly string[]
      readonly exports?: Readonly<Record<string, unknown>>
    }
    const bundleConfig = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')
    expect(manifest.files).toContain('lib/windows-embedding-identity-entry.js')
    expect(manifest.exports).not.toHaveProperty('./windows-embedding-identity-entry')
    expect(bundleConfig).toContain(
      "entry: { 'windows-embedding-identity-entry': 'lib/types/windows-embedding-identity-entry.js' }",
    )
    const bootstrap = readFileSync(
      new URL('src/windows-embedding-identity-entry.ts', packageRoot),
      'utf8',
    )
    expect(bootstrap).toContain("required('DSH_HOST_VAULT_NATIVE_MODULE_PATH')")
    expect(bootstrap).toContain("required('DSH_HOST_VAULT_NATIVE_MODULE_SHA256')")
    expect(bootstrap).toContain('loadPinnedWindowsVaultNativeModule(nativeModule)')
  })

  it('ships the private attested client Worker without exposing a public package entry', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
      readonly files?: readonly string[]
      readonly exports?: Readonly<Record<string, unknown>>
    }
    const bundleConfig = readFileSync(new URL('tsdown.config.ts', packageRoot), 'utf8')
    expect(manifest.files).toContain('lib/windows-host-client-worker-entry.js')
    expect(manifest.exports).not.toHaveProperty('./windows-host-client-worker-entry')
    expect(bundleConfig).toContain(
      "entry: { 'windows-host-client-worker-entry': 'lib/types/windows-host-client-worker-entry.js' }",
    )
  })
})
