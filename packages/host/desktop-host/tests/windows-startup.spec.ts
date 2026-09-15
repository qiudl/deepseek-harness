import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ProfileWorkerFactory } from '../src/types.ts'
import type { WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'
import {
  startWindowsDesktopHostApplication,
  startWindowsDesktopHostApplicationFromPrivateFiles,
  type StartWindowsDesktopHostApplicationDependencies,
} from '../src/windows-startup.ts'
import { WindowsHostTransport, type StartWindowsHostTransportOptions } from '../src/windows-host-transport.ts'
import { WindowsHostCarrier } from '../src/windows-host-carrier.ts'
import { acquireWindowsSingleHostLock } from '../src/windows-single-instance.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const unlockMaterial = Buffer.alloc(32, 9).toString('base64url')

function fixture() {
  const installationKeys = generateKeyPairSync('ed25519')
  const accountKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const accountAccessKeyring = JSON.stringify({
    version: 2,
    issuer: 'https://accounts.dsh.colorbuyai.com',
    keys: [{ kid: 'identity-2026-09', publicJwk: accountKeys.publicKey.export({ format: 'jwk' }) }],
  })
  const installationPublicKey = installationKeys.publicKey
    .export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const files = new Map<string, Buffer>()
  const pathEvidence = (kind: 'directory' | 'file') => ({
    kind,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [
      { sid: userSid, type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  })
  const createPrivateFile = vi.fn<NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>>((path, contents) => {
    if (files.has(path)) return { state: 'exists', evidence: pathEvidence('file') }
    files.set(path, Buffer.from(contents))
    return { state: 'created', evidence: pathEvidence('file') }
  })
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path) => {
    const contents = files.get(path)
    return contents === undefined ? undefined : { contents, evidence: pathEvidence('file') }
  })
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>((path, contents) => {
    files.set(path, Buffer.from(contents)); return pathEvidence('file')
  })
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn(() => pathEvidence('directory')),
    createPrivateFile,
    readPrivateFile,
    replacePrivateFile,
    acquirePrivateFileLease: vi.fn(() => ({
      evidence: pathEvidence('file'), initialize: vi.fn(), release: vi.fn(),
    })),
  }
  const dispose = vi.fn(async () => undefined)
  const createProfileWorker = vi.fn<ProfileWorkerFactory>(async () => ({
    closeNotifications: vi.fn(), abort: vi.fn(), done: Promise.resolve(),
    viewOrigin: 'http://127.0.0.1:49152', generation: 1,
    bootstrapCookie: { name: 'dsh-auth-test', value: 'v1.test.test' },
  }))
  const createProfileWorkerFactory = vi.fn(() => createProfileWorker)
  let transportOptions: StartWindowsHostTransportOptions | undefined
  const startTransport = vi.fn<NonNullable<StartWindowsDesktopHostApplicationDependencies['startTransport']>>(async (
    options,
    transportDependencies = {},
  ) => {
    if (transportDependencies.loadCurrentUserSid === undefined
      || transportDependencies.loadRegistrationFileBindings === undefined) throw new Error('missing test authority')
    const resolveCurrentUserSid = await transportDependencies.loadCurrentUserSid()
    const sharedBindings = await transportDependencies.loadRegistrationFileBindings()
    const resolvedUserSid = resolveCurrentUserSid()
    const ownership = acquireWindowsSingleHostLock({
      root: options.registrationRoot,
      userSid: resolvedUserSid,
      pid: process.pid,
      processNonce: options.processNonce,
      bindings: sharedBindings,
    })
    await options.initializeOwnedResources({ userSid: resolvedUserSid, bindings: sharedBindings })
    transportOptions = options
    const carrier = new WindowsHostCarrier({
      state: 'ready',
      waitUntilReady: async () => undefined,
      stop: async () => ({ state: 'stopped', cancelAttempts: 0, sessionCleanup: 'closed' }),
    }, options.processFallback, undefined)
    return new WindowsHostTransport(carrier, ownership, dispose, options.processFallback)
  })
  const loadCurrentUserSid = vi.fn(async () => () => userSid)
  const loadRegistrationFileBindings = vi.fn(async () => bindings)
  const attestListener = vi.fn(async () => undefined)
  const loadProfileListenerAttestor = vi.fn(async () => attestListener)
  const dependencies = {
    loadCurrentUserSid,
    loadRegistrationFileBindings,
    loadProfileListenerAttestor,
    createProfileWorkerFactory,
    startTransport,
  } as unknown as StartWindowsDesktopHostApplicationDependencies
  const deadline = (signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  const options = {
    platform: 'win32',
    arch: 'x64',
    root,
    registrationRoot: `${root}\\host`,
    nodeExecutablePath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\node.exe`,
    dshEntrypointPath: String.raw`C:\Program Files\Slark\resources\dsh-runtime\dsh.js`,
    workerEntry: new URL('file:///C:/Program%20Files/Slark/resources/dsh-runtime/windows-host-pipe-worker-entry.js'),
    deviceIndexKey: Buffer.alloc(32, 3),
    accountAccessKeyring,
    accountKeyringSha256: createHash('sha256').update(accountAccessKeyring).digest('hex'),
    installationPrivateKey: installationKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    installationPublicKey,
    installationId: 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
    endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126',
    hostInstanceId: '11111111-1111-4111-8111-111111111111',
    processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 1,
    schemaGeneration: 1,
    allowedPublisherThumbprints: new Set(['B'.repeat(64)]),
    allowedDesktopExecutableDigests: new Set(['2'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh-runtime\native\win32-x64\koffi.node`,
      sha256: '3'.repeat(64),
    },
    maximumRegistryBytes: 64 * 1024,
    maximumManagedFileBytes: 64 * 1024,
    maximumJournalBytes: 1024 * 1024,
    profileReadyTimeoutMs: 30_000,
    profileAbortTimeoutMs: 5_000,
    workerGeneration: 1,
    maxCancelAttempts: 4,
    waitForCancelRetry: vi.fn(async () => undefined),
    startupDeadline: deadline,
    exitWithoutHandleDeadline: deadline,
    sessionCleanupDeadline: deadline,
    processFallback: vi.fn(async () => undefined),
  }
  return {
    options, dependencies, files, createProfileWorker, createProfileWorkerFactory,
    startTransport, loadCurrentUserSid, loadRegistrationFileBindings,
    loadProfileListenerAttestor, attestListener, dispose, readPrivateFile,
    accountAccessKeyring,
    installationPrivateKey: installationKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    transportOptions: () => transportOptions,
  }
}

describe('Windows Desktop Host startup', () => {
  it('starts local-only DSH without migration capability and prepares an isolated Profile on demand', async () => {
    const state = fixture()
    const application = await startWindowsDesktopHostApplication(state.options, undefined, state.dependencies)
    const local = await application.host.bootstrapLocalProfile({
      keyHandle: 'windows-credential:local', unlockMaterial, ownerId: 'desktop-owner',
    })

    expect(application.host.supportsOfflineAccountRecovery()).toBe(false)
    expect(state.loadCurrentUserSid).toHaveBeenCalledOnce()
    expect(state.loadRegistrationFileBindings).toHaveBeenCalledOnce()
    expect(state.loadProfileListenerAttestor).toHaveBeenCalledOnce()
    expect(state.createProfileWorkerFactory).toHaveBeenCalledWith(expect.objectContaining({
      attestListener: state.attestListener,
      readyTimeoutMs: 30_000,
      abortTimeoutMs: 5_000,
    }))
    expect(state.createProfileWorker).toHaveBeenCalledWith(expect.objectContaining({
      profileId: local.profileId,
      profileRoot: `${root}\\profiles\\${local.profileId}`,
      pluginRoots: [`${root}\\profiles\\${local.profileId}\\plugins`],
      env: {
        TEMP: `${root}\\profiles\\${local.profileId}\\temp`,
        TMP: `${root}\\profiles\\${local.profileId}\\temp`,
      },
    }))
    const inspectionAbort = new AbortController()
    expect(state.transportOptions()?.openSession('11111111-1111-4111-8111-111111111112', inspectionAbort.signal)).toBeDefined()
    await application.close()
    expect(state.dispose).toHaveBeenCalledOnce()
  })

  it('rejects unsupported platforms and mismatched trust material before loading native authority', async () => {
    for (const change of [
      { arch: 'arm64' },
      { root: 'C:\\' },
      { registrationRoot: String.raw`C:\Users\alice\.dsh\host` },
      { accountKeyringSha256: '0'.repeat(64) },
      { installationPublicKey: 'A'.repeat(43) },
    ]) {
      const state = fixture()
      await expect(startWindowsDesktopHostApplication(
        { ...state.options, ...change }, undefined, state.dependencies,
      )).rejects.toThrow()
      expect(state.loadCurrentUserSid).not.toHaveBeenCalled()
      expect(state.startTransport).not.toHaveBeenCalled()
    }
  })

  it('loads exact ACL-pinned identity files only from the lock-owned initializer', async () => {
    const state = fixture()
    const identityRoot = `${root}\\identity`
    state.files.set(`${identityRoot}\\device-index-key.v1`, Buffer.alloc(32, 3))
    state.files.set(`${identityRoot}\\account-access-keyring.v2.json`, Buffer.from(state.accountAccessKeyring))
    state.files.set(`${identityRoot}\\installation-private-key.pem`, Buffer.from(state.installationPrivateKey))
    const startTransport = state.dependencies.startTransport
    if (startTransport === undefined) throw new Error('missing transport seam')
    const checkedStartTransport = vi.fn<NonNullable<
      StartWindowsDesktopHostApplicationDependencies['startTransport']
    >>(async (options, dependencies) => {
      expect(state.readPrivateFile).not.toHaveBeenCalled()
      return startTransport(options, dependencies)
    })

    const application = await startWindowsDesktopHostApplicationFromPrivateFiles({
      ...state.options,
      deviceIndexKeyPath: `${identityRoot}\\device-index-key.v1`,
      accountKeyringPath: `${identityRoot}\\account-access-keyring.v2.json`,
      installationPrivateKeyPath: `${identityRoot}\\installation-private-key.pem`,
    }, undefined, { ...state.dependencies, startTransport: checkedStartTransport })

    expect(state.readPrivateFile.mock.calls.slice(0, 3).map(([path]) => path)).toEqual([
      `${identityRoot}\\device-index-key.v1`,
      `${identityRoot}\\account-access-keyring.v2.json`,
      `${identityRoot}\\installation-private-key.pem`,
    ])
    await application.close()
  })

  it('rejects identity paths outside the isolated root before loading native authority', async () => {
    const state = fixture()
    await expect(startWindowsDesktopHostApplicationFromPrivateFiles({
      ...state.options,
      deviceIndexKeyPath: String.raw`C:\Users\alice\.dsh\device-index-key`,
      accountKeyringPath: `${root}\\identity\\account-access-keyring.v2.json`,
      installationPrivateKeyPath: `${root}\\identity\\installation-private-key.pem`,
    }, undefined, state.dependencies)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(state.loadCurrentUserSid).not.toHaveBeenCalled()
    expect(state.readPrivateFile).not.toHaveBeenCalled()
  })
})
