import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  startConfiguredDesktopHostApplication,
  apply,
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
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

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
    await expect(startConfiguredDesktopHostApplication(input, { platform: 'darwin' })).rejects.toBeDefined()
    await expect(startConfiguredDesktopHostApplication(input)).rejects.toBeDefined()
  })

  it('owns the selected application for exactly one Cordis effect lifetime', async () => {
    const close = vi.fn(async () => undefined)
    let dispose: (() => Promise<void>) | undefined
    const effect = vi.fn(async (factory: () => Promise<() => Promise<void>>) => { dispose = await factory() })
    await apply({ effect } as never, config(), {
      platform: 'darwin',
      startMacOS: async () => ({ close } as unknown as DesktopHostApplication),
    })
    expect(effect).toHaveBeenCalledOnce()
    await dispose?.()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a non-canonical Worker path before selecting the Windows adapter', () => {
    expect(() => windowsDesktopHostConfig(
      config(String.raw`C:\Program Files\Slark\..\attacker.js`),
    )).toThrow()
  })

  it.each([
    'root', 'registrationRoot', 'windowsWorkerEntryPath', 'windowsNativeModulePath', 'windowsNativeModuleSha256',
  ] as const)('rejects a missing Windows private-file setting: %s', (key) => {
    expect(() => windowsDesktopHostConfig(Object.assign({}, config(), { [key]: undefined }))).toThrow('invalid_input')
  })

  it.each([
    'windowsWorkerGeneration', 'windowsMaxCancelAttempts', 'windowsCancelRetryMs', 'windowsStartupTimeoutMs',
    'windowsExitTimeoutMs', 'windowsSessionCleanupTimeoutMs', 'windowsMaximumRegistryBytes',
    'windowsMaximumManagedFileBytes', 'windowsMaximumJournalBytes', 'windowsProfileReadyTimeoutMs',
    'windowsProfileAbortTimeoutMs',
  ] as const)('rejects a non-positive Windows bound: %s', (key) => {
    expect(() => windowsDesktopHostConfig(Object.assign({}, config(), { [key]: 0 }))).toThrow('invalid_input')
  })

  it('rejects a non-integer Windows bound', () => {
    expect(() => windowsDesktopHostConfig(Object.assign({}, config(), { windowsWorkerGeneration: Number.NaN })))
      .toThrow('invalid_input')
  })

  it.each([
    'relative\\worker.js',
    String.raw`C:\runtime:alternate\worker.js`,
    `C:\\runtime\\worker${String.fromCharCode(0)}.js`,
  ])('rejects an unsafe Windows Worker path: %s', (path) => {
    expect(() => windowsDesktopHostConfig(config(path))).toThrow('invalid_input')
  })

  it('uses explicit Windows bounds and settles retry, deadline, abort, and fallback callbacks', async () => {
    vi.useFakeTimers()
    const input: Config = Object.assign({}, config(), {
      desktopPublisherThumbprints: undefined,
      windowsWorkerGeneration: 2,
      windowsMaxCancelAttempts: 3,
      windowsCancelRetryMs: 4,
      windowsStartupTimeoutMs: 5,
      windowsExitTimeoutMs: 6,
      windowsSessionCleanupTimeoutMs: 7,
      windowsMaximumRegistryBytes: 8,
      windowsMaximumManagedFileBytes: 9,
      windowsMaximumJournalBytes: 10,
      windowsProfileReadyTimeoutMs: 11,
      windowsProfileAbortTimeoutMs: 12,
    })
    const resolved = windowsDesktopHostConfig(input)
    expect(resolved).toMatchObject({
      workerGeneration: 2,
      maxCancelAttempts: 3,
      maximumRegistryBytes: 8,
      maximumManagedFileBytes: 9,
      maximumJournalBytes: 10,
      profileReadyTimeoutMs: 11,
      profileAbortTimeoutMs: 12,
    })
    expect(resolved.allowedPublisherThumbprints.size).toBe(0)

    const retry = resolved.waitForCancelRetry()
    await vi.advanceTimersByTimeAsync(4)
    await retry
    const active = new AbortController()
    const startup = resolved.startupDeadline(active.signal)
    await vi.advanceTimersByTimeAsync(5)
    await startup
    const aborted = new AbortController()
    aborted.abort()
    await resolved.exitWithoutHandleDeadline(aborted.signal)
    const cleanupController = new AbortController()
    const cleanup = resolved.sessionCleanupDeadline(cleanupController.signal)
    cleanupController.abort()
    await cleanup

    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(resolved.processFallback).toThrow('unavailable')
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL')
  })
})
