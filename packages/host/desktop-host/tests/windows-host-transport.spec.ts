import { describe, expect, it, vi } from 'vitest'
import {
  startWindowsHostTransport,
  type StartWindowsHostTransportDependencies,
} from '../src/windows-host-transport.ts'
import type { WindowsHostCarrierWorker } from '../src/windows-host-carrier.ts'
import { WindowsHostProcessFallbackRequiredError } from '../src/windows-host-carrier.ts'
import type { WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'
import { WindowsHostWorkerParentSupervisor } from '../src/windows-host-worker-parent-supervisor.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const installationId = 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820'
const endpointRegistrationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126'

async function captureFallback(promise: Promise<unknown>): Promise<WindowsHostProcessFallbackRequiredError> {
  try {
    await promise
    throw new Error('expected process fallback')
  } catch (error) {
    if (!(error instanceof WindowsHostProcessFallbackRequiredError)) throw error
    return error
  }
}

function fixture() {
  const stop = vi.fn<WindowsHostCarrierWorker['stop']>(async () => ({
    state: 'stopped', cancelAttempts: 1, sessionCleanup: 'closed',
  }))
  const cancellation = {
    openCurrentThreadHandle: vi.fn(() => 0n),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }
  const loadCancellation = vi.fn(async () => cancellation)
  const worker = new WindowsHostWorkerParentSupervisor({
    generation: 7,
    stopFlag: createWindowsWorkerStopFlag(),
    workerDone: new Promise<void>(() => undefined),
    cancellation,
    maxCancelAttempts: 4,
    waitForCancelRetry: async () => undefined,
    startupDeadline: async () => undefined,
    exitWithoutHandleDeadline: async () => undefined,
    sessionCleanupDeadline: async () => undefined,
    port: { send: () => undefined, subscribe: () => () => undefined },
    openSession: () => ({ handleRequest: () => { throw new Error('unused') }, close: () => undefined }),
  })
  vi.spyOn(worker, 'state', 'get').mockReturnValue('ready')
  vi.spyOn(worker, 'waitUntilReady').mockResolvedValue(91n)
  vi.spyOn(worker, 'stop').mockImplementation(stop)
  const startWorkerThread = vi.fn<NonNullable<StartWindowsHostTransportDependencies['startWorkerThread']>>(() => worker)
  const resolveCurrentUserSid = vi.fn(() => 'S-1-5-21-1000-2000-3000-1001')
  const loadCurrentUserSid = vi.fn(async () => resolveCurrentUserSid)
  const privateEvidence = {
    kind: 'file' as const,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: resolveCurrentUserSid(),
    daclProtected: true,
    access: [
      { sid: resolveCurrentUserSid(), type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
  }
  resolveCurrentUserSid.mockClear()
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>(() => privateEvidence)
  const initializeLease = vi.fn()
  const releaseLease = vi.fn()
  const acquirePrivateFileLease = vi.fn<WindowsHostRegistrationFileBindings['acquirePrivateFileLease']>(
    () => ({
      evidence: privateEvidence,
      initialize: (contents) => { startupOrder.push('ownership'); initializeLease(contents) },
      release: releaseLease,
    }),
  )
  const registrationFileBindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
      () => ({ ...privateEvidence, kind: 'directory' }),
    ),
    readPrivateFile: vi.fn(() => undefined),
    replacePrivateFile,
    acquirePrivateFileLease,
  }
  const loadRegistrationFileBindings = vi.fn(async () => registrationFileBindings)
  const dependencies: StartWindowsHostTransportDependencies = {
    loadCancellation,
    loadCurrentUserSid,
    loadRegistrationFileBindings,
    startWorkerThread,
  }
  const startupDeadline = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  const exitWithoutHandleDeadline = startupDeadline
  const sessionCleanupDeadline = startupDeadline
  const waitForCancelRetry = vi.fn(async () => undefined)
  const processFallback = vi.fn(async () => undefined)
  const startupOrder: string[] = []
  const shutdownOrder: string[] = []
  stop.mockImplementation(async () => {
    shutdownOrder.push('pipe')
    return { state: 'stopped', cancelAttempts: 1, sessionCleanup: 'closed' }
  })
  releaseLease.mockImplementation(() => { shutdownOrder.push('ownership') })
  const quiesceOwnedResources = vi.fn(async () => { shutdownOrder.push('profiles') })
  const initializeOwnedResources = vi.fn(async () => { startupOrder.push('initialize') })
  startWorkerThread.mockImplementation(() => { startupOrder.push('worker'); return worker })
  const options = {
    platform: 'win32',
    arch: 'x64',
    installationId,
    endpointRegistrationId,
    installationPublicKey: 'A'.repeat(43),
    executableSignatureDigest: '1'.repeat(64),
    registrationRoot: String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`,
    processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    processFallback,
    workerEntry: new URL('file:///opt/slark/windows-host-pipe-worker-entry.js'),
    workerGeneration: 7,
    allowedPublisherThumbprints: new Set(['B'.repeat(64)]),
    allowedExecutableDigests: new Set(['2'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
      sha256: '3'.repeat(64),
    },
    maxCancelAttempts: 4,
    waitForCancelRetry,
    startupDeadline,
    exitWithoutHandleDeadline,
    sessionCleanupDeadline,
    initializeOwnedResources,
    quiesceOwnedResources,
    openSession: vi.fn(() => ({
      handleRequest: () => { throw new Error('unused') },
      close: () => undefined,
    })),
  }
  return {
    worker, stop, cancellation, dependencies, loadCancellation, startWorkerThread,
    loadCurrentUserSid, resolveCurrentUserSid, loadRegistrationFileBindings, replacePrivateFile,
    acquirePrivateFileLease, initializeLease, releaseLease,
    processFallback, initializeOwnedResources, quiesceOwnedResources, startupOrder, shutdownOrder,
    startupDeadline, exitWithoutHandleDeadline, sessionCleanupDeadline,
    waitForCancelRetry, options,
  }
}

describe('Windows Host production transport composition', () => {
  it('loads parent authority, forwards injected bounds, and publishes through the carrier', async () => {
    const state = fixture()
    const carrier = await startWindowsHostTransport(state.options, state.dependencies)

    expect(state.loadCancellation).toHaveBeenCalledOnce()
    expect(state.startWorkerThread).toHaveBeenCalledOnce()
    expect(state.startWorkerThread).toHaveBeenCalledWith(expect.objectContaining({
      generation: 7,
      workerEntry: state.options.workerEntry,
      allowedPublisherThumbprints: state.options.allowedPublisherThumbprints,
      allowedExecutableDigests: state.options.allowedExecutableDigests,
      nativeModule: state.options.nativeModule,
      cancellation: state.cancellation,
      maxCancelAttempts: 4,
      openSession: state.options.openSession,
      waitForCancelRetry: state.waitForCancelRetry,
      startupDeadline: state.startupDeadline,
      exitWithoutHandleDeadline: state.exitWithoutHandleDeadline,
      sessionCleanupDeadline: state.sessionCleanupDeadline,
    }))
    const workerOptions = state.startWorkerThread.mock.calls[0]?.[0]
    expect(workerOptions?.startupDeadline).toBeTypeOf('function')
    expect(workerOptions?.exitWithoutHandleDeadline).toBeTypeOf('function')
    expect(workerOptions?.sessionCleanupDeadline).toBeTypeOf('function')
    expect(workerOptions?.waitForCancelRetry).toBeTypeOf('function')
    expect(state.loadCurrentUserSid).toHaveBeenCalledOnce()
    expect(state.resolveCurrentUserSid).toHaveBeenCalledOnce()
    expect(state.loadRegistrationFileBindings).toHaveBeenCalledOnce()
    expect(state.acquirePrivateFileLease).toHaveBeenCalledOnce()
    expect(state.initializeLease).toHaveBeenCalledOnce()
    expect(state.initializeOwnedResources).toHaveBeenCalledWith(expect.objectContaining({
      userSid: state.resolveCurrentUserSid(),
    }))
    expect(state.replacePrivateFile).toHaveBeenCalledOnce()
    expect(state.startupOrder).toEqual(['ownership', 'initialize', 'worker'])

    expect(() => { carrier.assertHealthy() }).not.toThrow()

    const closing = carrier.close()
    expect(carrier.close()).toBe(closing)
    await closing
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.quiesceOwnedResources).toHaveBeenCalledOnce()
    expect(state.releaseLease).toHaveBeenCalledOnce()
    expect(state.shutdownOrder).toEqual(['pipe', 'profiles', 'ownership'])
  })

  it('rejects unsupported runtime facts before loading native cancellation or resolving identity', async () => {
    const state = fixture()
    await expect(startWindowsHostTransport({ ...state.options, arch: 'arm64' }, state.dependencies)).rejects.toThrow()
    expect(state.loadCancellation).not.toHaveBeenCalled()
    expect(state.resolveCurrentUserSid).not.toHaveBeenCalled()
    expect(state.startWorkerThread).not.toHaveBeenCalled()
  })

  it('rejects malformed release and registration anchors before loading native cancellation', async () => {
    for (const invalid of [
      { installationId: '../other' },
      { endpointRegistrationId: 'not-a-uuid' },
      { installationPublicKey: 'not-a-key' },
      { executableSignatureDigest: 'not-a-digest' },
    ]) {
      const state = fixture()
      await expect(startWindowsHostTransport({ ...state.options, ...invalid }, state.dependencies)).rejects.toThrow()
      expect(state.loadCancellation).not.toHaveBeenCalled()
      expect(state.resolveCurrentUserSid).not.toHaveBeenCalled()
      expect(state.startWorkerThread).not.toHaveBeenCalled()
    }
  })

  it('keeps the kernel lease held when Worker shutdown requires process fallback', async () => {
    const state = fixture()
    state.stop.mockResolvedValueOnce({
      state: 'still_running', cancelAttempts: 4, sessionCleanup: 'still_closing',
    })
    const transport = await startWindowsHostTransport(state.options, state.dependencies)
    await expect(transport.close()).rejects.toThrow('process fallback')
    expect(state.processFallback).toHaveBeenCalledOnce()
    expect(state.releaseLease).not.toHaveBeenCalled()
  })

  it('releases ownership when Worker construction fails without a live Worker', async () => {
    const state = fixture()
    state.startWorkerThread.mockImplementationOnce(() => { throw new Error('worker construction failed') })
    await expect(startWindowsHostTransport(state.options, state.dependencies)).rejects.toThrow('worker construction failed')
    expect(state.quiesceOwnedResources).toHaveBeenCalledOnce()
    expect(state.releaseLease).toHaveBeenCalledOnce()
    expect(state.processFallback).not.toHaveBeenCalled()
  })

  it('does not start the pipe Worker when owned-resource initialization fails under the lock', async () => {
    const state = fixture()
    state.initializeOwnedResources.mockRejectedValueOnce(new Error('registry invalid'))

    await expect(startWindowsHostTransport(state.options, state.dependencies)).rejects.toThrow('registry invalid')
    expect(state.startWorkerThread).not.toHaveBeenCalled()
    expect(state.quiesceOwnedResources).toHaveBeenCalledOnce()
    expect(state.releaseLease).toHaveBeenCalledOnce()
  })

  it('keeps ownership and requires process fallback when owned Profile workers do not quiesce', async () => {
    const state = fixture()
    state.quiesceOwnedResources.mockRejectedValueOnce(new Error('Profile child still running'))
    const transport = await startWindowsHostTransport(state.options, state.dependencies)

    await expect(transport.close()).rejects.toThrow('process fallback')
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.processFallback).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'owned_resources_stop_failed',
    }))
    expect(state.releaseLease).not.toHaveBeenCalled()
  })

  it('normalizes non-Error quiescence failures and preserves a rejected fallback', async () => {
    for (const fallbackFails of [false, true]) {
      const state = fixture()
      state.quiesceOwnedResources.mockRejectedValueOnce('profiles stuck')
      if (fallbackFails) state.processFallback.mockRejectedValueOnce(new Error('fallback failed'))
      const transport = await startWindowsHostTransport(state.options, state.dependencies)
      const error = await captureFallback(transport.close())
      expect(error.request.reason).toBe('owned_resources_stop_failed')
      expect(error.request.cause?.message).toBe('Unknown Windows Host owned-resource shutdown failure')
      if (fallbackFails) expect(error.cause).toMatchObject({ message: 'fallback failed' })
      expect(state.releaseLease).not.toHaveBeenCalled()
    }
  })

  it('escalates Error and non-Error ownership release failures after quiescence', async () => {
    for (const failure of [new Error('release failed'), 'release failed']) {
      for (const fallbackFails of [false, true]) {
        const state = fixture()
        state.releaseLease.mockImplementationOnce(() => { throw failure })
        if (fallbackFails) state.processFallback.mockRejectedValueOnce(new Error('fallback failed'))
        const transport = await startWindowsHostTransport(state.options, state.dependencies)
        const error = await captureFallback(transport.close())
        expect(error.request.reason).toBe('ownership_release_failed')
        if (fallbackFails) expect(error.cause).toMatchObject({ message: 'fallback failed' })
      }
    }
  })

  it('does not clean up ownership a second time after startup already required fallback', async () => {
    const state = fixture()
    const request = { reason: 'worker_stop_failed' as const, cause: new Error('worker live') }
    state.initializeOwnedResources.mockRejectedValueOnce(
      new WindowsHostProcessFallbackRequiredError(request, request.cause),
    )
    await expect(startWindowsHostTransport(state.options, state.dependencies))
      .rejects.toBeInstanceOf(WindowsHostProcessFallbackRequiredError)
    expect(state.quiesceOwnedResources).not.toHaveBeenCalled()
    expect(state.releaseLease).not.toHaveBeenCalled()
  })

  it('escalates startup cleanup failure before releasing ownership', async () => {
    for (const failure of [new Error('profiles stuck'), 'profiles stuck']) {
      for (const fallbackFails of [false, true]) {
        const state = fixture()
        state.initializeOwnedResources.mockRejectedValueOnce(new Error('startup failed'))
        state.quiesceOwnedResources.mockRejectedValueOnce(failure)
        if (fallbackFails) state.processFallback.mockRejectedValueOnce(new Error('fallback failed'))
        const error = await captureFallback(startWindowsHostTransport(state.options, state.dependencies))
        expect(error.request.reason).toBe('owned_resources_stop_failed')
        if (fallbackFails) expect(error.cause).toMatchObject({ message: 'fallback failed' })
        expect(state.releaseLease).not.toHaveBeenCalled()
      }
    }
  })

  it('escalates startup ownership-release failure after successful quiescence', async () => {
    for (const failure of [new Error('release failed'), 'release failed']) {
      for (const fallbackFails of [false, true]) {
        const state = fixture()
        state.initializeOwnedResources.mockRejectedValueOnce(new Error('startup failed'))
        state.releaseLease.mockImplementationOnce(() => { throw failure })
        if (fallbackFails) state.processFallback.mockRejectedValueOnce(new Error('fallback failed'))
        const error = await captureFallback(startWindowsHostTransport(state.options, state.dependencies))
        expect(error.request.reason).toBe('ownership_release_failed')
        if (fallbackFails) expect(error.cause).toMatchObject({ message: 'fallback failed' })
      }
    }
  })

  it('rejects a non-file Worker entry before acquiring native ownership', async () => {
    const state = fixture()
    await expect(startWindowsHostTransport({
      ...state.options, workerEntry: new URL('https://example.com/worker.js'),
    }, state.dependencies)).rejects.toThrow('file URL')
    expect(state.loadCancellation).not.toHaveBeenCalled()
  })
})
