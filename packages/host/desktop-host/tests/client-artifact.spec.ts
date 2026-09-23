import { spawnSync } from 'node:child_process'
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
      readonly discoverWindowsHost?: unknown
      readonly loadWindowsHostClientWorkerCancellation?: unknown
      readonly createWindowsLocalProfileStorage?: unknown
    }
    expect(loaded.UnixHostClient).toBeTypeOf('function')
    expect(loaded.discoverUnixHost).toBeTypeOf('function')
    expect(loaded.discoverWindowsHost).toBeTypeOf('function')
    expect(loaded.loadWindowsHostClientWorkerCancellation).toBeTypeOf('function')
    expect(loaded.createWindowsLocalProfileStorage).toBeTypeOf('function')
  })
})

describe('desktop Host startup artifact', () => {
  const path = 'packages/host/desktop-host/lib/startup.js'
  const source = (() => {
    try { return readFileSync(path, 'utf8') } catch { return undefined }
  })()

  it.skipIf(source === undefined)('imports the private Windows startup composition from memory without starting a Host', () => {
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs'
      import assert from 'node:assert/strict'
      try {
        const bytes = readFileSync(process.argv[1])
        const loaded = await import('data:text/javascript;base64,' + bytes.toString('base64'))
        assert.equal(typeof loaded.startWindowsDesktopHostApplicationFromPrivateFiles, 'function')
        assert.equal(typeof loaded.startWindowsDesktopHostApplication, 'function')
        for (const config of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'arm64' }]) {
          await assert.rejects(loaded.startWindowsDesktopHostApplicationFromPrivateFiles(config), {
            name: 'HostAuthorityError', code: 'invalid_input',
          })
        }
      } catch (error) {
        console.error(error)
        process.exitCode = 1
      }
    `, 'packages/host/desktop-host/lib/windows-startup.js'], { encoding: 'utf8', timeout: 10_000 })
    expect(checked.error).toBeUndefined()
    expect(checked.status, checked.stderr || checked.stdout).toBe(0)
  })

  it.skipIf(source === undefined)('uses the release-pinned native addon before any package lookup', () => {
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs'
      import assert from 'node:assert/strict'
      try {
        const bytes = readFileSync(process.argv[1])
        const loaded = await import('data:text/javascript;base64,' + bytes.toString('base64'))
        const root = String.raw\`C:\\Users\\alice\\AppData\\Local\\Slark\\DSH\`
        let failure
        try { await loaded.startWindowsDesktopHostApplicationFromPrivateFiles({
          platform: 'win32', arch: 'x64', root, registrationRoot: root + '\\\\host',
          nodeExecutablePath: String.raw\`C:\\Program Files\\Slark\\node.exe\`,
          dshEntrypointPath: String.raw\`C:\\Program Files\\Slark\\dsh.js\`,
          deviceIndexKeyPath: root + '\\\\identity\\\\device-index-key.v1',
          accountKeyringPath: root + '\\\\identity\\\\account-access-keyring.v2.json',
          accountKeyringSha256: '${'a'.repeat(64)}',
          installationPrivateKeyPath: root + '\\\\identity\\\\installation-private-key.pem',
          installationPublicKey: '${'A'.repeat(43)}',
          installationId: 'slark-dsh-${'7'.repeat(40)}',
          endpointRegistrationId: '22222222-2222-4222-8222-222222222222',
          hostInstanceId: '33333333-3333-4333-8333-333333333333',
          processNonce: '${'N'.repeat(43)}', executableSignatureDigest: '${'d'.repeat(64)}',
          runtimeGeneration: 1, schemaGeneration: 1,
          workerEntry: new URL('file:///C:/Program%20Files/Slark/worker.js'), workerGeneration: 1,
          allowedPublisherThumbprints: new Set(['${'B'.repeat(64)}']),
          allowedDesktopExecutableDigests: new Set(['${'d'.repeat(64)}']),
          nativeModule: {
            path: String.raw\`C:\\Program Files\\Slark\\missing\\koffi.node\`,
            sha256: '${'c'.repeat(64)}',
          },
          maximumRegistryBytes: 1, maximumManagedFileBytes: 1, maximumJournalBytes: 1,
          profileReadyTimeoutMs: 1, profileAbortTimeoutMs: 1, maxCancelAttempts: 1,
          waitForCancelRetry: async () => undefined,
          startupDeadline: async () => undefined,
          exitWithoutHandleDeadline: async () => undefined,
          sessionCleanupDeadline: async () => undefined,
          processFallback: () => { throw new Error('unexpected fallback') },
        }) } catch (error) {
          failure = { code: error?.code, name: error?.name, message: error?.message }
        }
        process.stdout.write(JSON.stringify(failure))
      } catch (error) {
        console.error(error?.code ?? error?.name)
        process.exitCode = 1
      }
    `, 'packages/host/desktop-host/lib/windows-startup.js'], { encoding: 'utf8', timeout: 10_000 })
    expect(checked.error).toBeUndefined()
    expect(checked.status, checked.stderr || checked.stdout).toBe(0)
    expect(JSON.parse(checked.stdout)).toMatchObject({
      message: 'Windows vault native module release pin is invalid',
    })
    expect(checked.stdout).not.toContain('ERR_MODULE_NOT_FOUND')
  })

  it.skipIf(source === undefined)('defers native loader creation when the compiled pin helper is loaded from memory', () => {
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs'
      import assert from 'node:assert/strict'
      try {
        const bytes = readFileSync(process.argv[1])
        const loaded = await import('data:text/javascript;base64,' + bytes.toString('base64'))
        assert.equal(typeof loaded.loadPinnedWindowsVaultNativeModule, 'function')
        assert.throws(() => loaded.loadPinnedWindowsVaultNativeModule(undefined), /release pin is invalid/)
      } catch (error) {
        console.error(error.code ?? error.name)
        process.exitCode = 1
      }
    `, 'packages/host/desktop-host/lib/types/windows-pinned-vault-native.js'], { encoding: 'utf8' })
    expect(checked.status, checked.stderr || checked.stdout).toBe(0)
  })

  it.skipIf(source === undefined)('is valid JavaScript and exposes the native vault loader without loading it eagerly', async () => {
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
    expect(checked.status, checked.stderr || checked.stdout).toBe(0)
    const loaded = await import(pathToFileURL(join(process.cwd(), path)).href) as {
      loadWindowsLocalProfileStorage: (input: { root: string; platform: string; arch: string }) => Promise<unknown>
      loadWindowsLegacySourceProbe: (input: { userProfile: string; platform: string; arch: string }) => Promise<unknown>
    }
    expect(loaded.loadWindowsLocalProfileStorage).toBeTypeOf('function')
    expect(loaded.loadWindowsLegacySourceProbe).toBeTypeOf('function')
    await expect(loaded.loadWindowsLegacySourceProbe({
      userProfile: String.raw`C:\Users\alice`, platform: 'win32', arch: 'x64',
    })).rejects.toThrow('release pin is invalid')
    await expect(loaded.loadWindowsLocalProfileStorage({
      root: String.raw`C:\Slark\authority`, platform: 'darwin', arch: 'arm64',
    })).rejects.toThrow('Windows x64')
  })
})
