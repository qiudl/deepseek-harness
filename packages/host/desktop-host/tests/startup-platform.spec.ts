import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  startConfiguredDesktopHostApplication,
  windowsDesktopHostConfig,
  type Config,
  type DesktopHostApplication,
} from '../src/startup.ts'
import type { WindowsDesktopHostApplication } from '../src/windows-startup.ts'
import type { WindowsDesktopHostPrivateFileConfig } from '../src/windows-startup.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\environments\production`

function config(
  workerEntryPath = String.raw`C:\Program Files\Slark\resources\dsh-runtime\windows-host-pipe-worker-entry.js`,
): Config {
  return {
    root,
    registrationRoot: `${root}\\host`,
    nodeExecutablePath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\node.exe`,
    dshEntrypointPath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\dsh.js`,
    deviceIndexKeyPath: `${root}\\identity\\device-index-key.v1`,
    accountKeyringPath: `${root}\\identity\\account-access-keyring.v2.json`,
    accountKeyringSha256: '1'.repeat(64),
    installationPrivateKeyPath: `${root}\\identity\\installation-private-key.pem`,
    installationPublicKey: 'A'.repeat(43),
    installationId: 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
    endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126',
    hostInstanceId: '11111111-1111-4111-8111-111111111111',
    processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    executableSignatureDigest: '2'.repeat(64),
    desktopTeamIdentifiers: [],
    desktopExecutableDigests: ['3'.repeat(64)],
    desktopPublisherThumbprints: ['B'.repeat(64)],
    windowsWorkerEntryPath: workerEntryPath,
    windowsNativeModulePath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\native\win32-x64\koffi.node`,
    windowsNativeModuleSha256: '4'.repeat(64),
    runtimeGeneration: 1,
    schemaGeneration: 1,
  }
}

describe('Desktop Host platform startup', () => {
  it.each(['张三', 'Alice Smith', 'Alice#1', '100%', '%2F', '%23'])('preserves Worker paths containing %s', (name) => {
    const path = `C:\\Users\\${name}\\Slark\\windows-host-pipe-worker-entry.js`
    const resolved = windowsDesktopHostConfig(config(path)).workerEntry
    expect(resolved.hash).toBe('')
    expect(resolved.search).toBe('')
    expect(fileURLToPath(resolved, { windows: true })).toBe(path)
  })

  it('maps Windows to the private-file adapter with bounded defaults and no secret contents', async () => {
    const input = config()
    const close = vi.fn(async () => undefined)
    const startWindows = vi.fn(
      async (_config: WindowsDesktopHostPrivateFileConfig) => ({ close }) as unknown as WindowsDesktopHostApplication,
    )

    const application = await startConfiguredDesktopHostApplication(input, {
      platform: 'win32',
      startWindows,
    })

    expect(startWindows).toHaveBeenCalledOnce()
    const windows = startWindows.mock.calls[0]?.[0]
    expect(windows).toMatchObject({
      platform: 'win32',
      arch: 'x64',
      root,
      workerGeneration: 1,
      maxCancelAttempts: 4,
      maximumJournalBytes: 8 * 1024 * 1024,
      nativeModule: {
        path: String.raw`C:\Program Files\Slark\resources\dsh-runtime\native\win32-x64\koffi.node`,
        sha256: '4'.repeat(64),
      },
    })
    expect(windows?.workerEntry.href).toBe(
      'file:///C:/Program%20Files/Slark/resources/dsh-runtime/windows-host-pipe-worker-entry.js',
    )
    expect(windows).not.toHaveProperty('deviceIndexKey')
    expect(windows).not.toHaveProperty('accountAccessKeyring')
    expect(windows).not.toHaveProperty('installationPrivateKey')
    await application.close()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps macOS on the existing adapter and rejects unsupported platforms', async () => {
    const input = config()
    const startMacOS = vi.fn(async () => ({ close: vi.fn() }) as unknown as DesktopHostApplication)
    await startConfiguredDesktopHostApplication(input, { platform: 'darwin', startMacOS })
    expect(startMacOS).toHaveBeenCalledWith(input)
    await expect(startConfiguredDesktopHostApplication(input, { platform: 'linux' }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects a non-canonical Worker path before selecting the Windows adapter', () => {
    expect(() => windowsDesktopHostConfig(
      config(String.raw`C:\Program Files\Slark\..\attacker.js`),
    )).toThrow()
  })
})
