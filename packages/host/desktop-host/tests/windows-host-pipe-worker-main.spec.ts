import { describe, expect, it, vi } from 'vitest'
import { createWindowsHostPipeWorkerBootData } from '../src/windows-host-pipe-worker-boot.ts'
import type { WindowsHostPipeWorkerRunnerOptions } from '../src/windows-host-pipe-worker-runner.ts'
import { runWindowsHostPipeWorkerMain } from '../src/windows-host-pipe-worker-main.ts'
import { WindowsNamedPipeFrameChannel } from '../src/windows-named-pipe-frame-channel.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import type { WindowsPeerEvidence } from '../src/windows-peer-attestor.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

function fixture() {
  const parentFlag = createWindowsWorkerStopFlag()
  const boot = createWindowsHostPipeWorkerBootData({
    generation: 7,
    policy: resolveWindowsNamedPipePolicy({
      installationId: 'installation-1',
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
      userSid: 'S-1-5-21-1000-2000-3000-1001',
    }),
    stopFlag: parentFlag,
    allowedPublisherThumbprints: new Set(['A'.repeat(64)]),
    allowedExecutableDigests: new Set(['b'.repeat(64)]),
    nativeModule: {
      path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
      sha256: 'c'.repeat(64),
    },
  })
  const cancellation = {
    openCurrentThreadHandle: vi.fn(() => 91n),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }
  const lifecycle = {
    createSecurityDescriptor: vi.fn(() => 1n),
    freeSecurityDescriptor: vi.fn(),
    createNamedPipe: vi.fn(() => 2n),
    connectNamedPipe: vi.fn(() => 'connected' as const),
    disconnectNamedPipe: vi.fn(),
    closeHandle: vi.fn(),
  }
  const io = { read: vi.fn(), writeFrame: vi.fn() }
  const attest = vi.fn()
  const port = { send: vi.fn(), subscribe: vi.fn(() => () => undefined) }
  let receivedRunnerOptions: WindowsHostPipeWorkerRunnerOptions<WindowsPeerEvidence> | undefined
  const runWorker = vi.fn(async (options: WindowsHostPipeWorkerRunnerOptions<WindowsPeerEvidence>) => {
    receivedRunnerOptions = options
    return { connectionsServed: 0, requestsHandled: 0 }
  })
  const dependencies = {
    loadCancellation: vi.fn(async () => cancellation),
    loadLifecycle: vi.fn(async () => lifecycle),
    loadIo: vi.fn(async () => io),
    loadAttestor: vi.fn(async () => attest),
    createConnectionId: vi.fn(() => '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'),
    runWorker,
  }
  return {
    parentFlag,
    boot,
    cancellation,
    lifecycle,
    io,
    attest,
    port,
    runWorker,
    dependencies,
    receivedRunnerOptions: () => receivedRunnerOptions,
  }
}

describe('Windows Host pipe Worker composition root', () => {
  it('loads every native authority component and passes one shared stop generation to the runner', async () => {
    const state = fixture()
    await expect(runWindowsHostPipeWorkerMain(state.port, state.boot, state.dependencies)).resolves.toEqual({
      connectionsServed: 0,
      requestsHandled: 0,
    })
    expect(state.dependencies.loadCancellation).toHaveBeenCalledOnce()
    expect(state.dependencies.loadLifecycle).toHaveBeenCalledOnce()
    expect(state.dependencies.loadIo).toHaveBeenCalledOnce()
    expect(state.dependencies.loadAttestor).toHaveBeenCalledWith({
      allowedPublisherThumbprints: new Set(['A'.repeat(64)]),
      allowedPackageFamilyNames: new Set(),
      allowedExecutableDigests: new Set(['b'.repeat(64)]),
    })
    const options = state.receivedRunnerOptions()
    expect(options).toBeDefined()
    if (options === undefined) throw new Error('runner options missing')
    expect(options).toMatchObject({ generation: 7, policy: state.boot.policy, port: state.port })
    expect(options.stopFlag.requested()).toBe(false)
    expect(options.cancellation).toBe(state.cancellation)
    expect(options.lifecycleBindings).toBe(state.lifecycle)
    expect(options.attest).toBe(state.attest)
    expect(options.createChannel(55n)).toBeInstanceOf(WindowsNamedPipeFrameChannel)
  })

  it('reports a pre-start stop without loading any native component', async () => {
    const state = fixture()
    state.parentFlag.request()
    await expect(runWindowsHostPipeWorkerMain(state.port, state.boot, state.dependencies)).resolves.toEqual({
      connectionsServed: 0,
      requestsHandled: 0,
    })
    expect(state.port.send).toHaveBeenCalledWith({ version: 1, type: 'stopped', generation: 7 })
    expect(state.dependencies.loadCancellation).not.toHaveBeenCalled()
    expect(state.dependencies.loadLifecycle).not.toHaveBeenCalled()
    expect(state.dependencies.loadIo).not.toHaveBeenCalled()
    expect(state.dependencies.loadAttestor).not.toHaveBeenCalled()
    expect(state.runWorker).not.toHaveBeenCalled()
  })

  it('rejects malformed boot data before loading any native library', async () => {
    const state = fixture()
    await expect(runWindowsHostPipeWorkerMain(state.port, { ...state.boot, extra: true }, state.dependencies))
      .rejects.toThrow('Invalid Windows Host Worker boot data')
    expect(state.dependencies.loadCancellation).not.toHaveBeenCalled()
    expect(state.runWorker).not.toHaveBeenCalled()
  })

  it('does not start the runner after any native loader fails', async () => {
    const state = fixture()
    state.dependencies.loadIo.mockRejectedValueOnce(new Error('ReadFile unavailable'))
    await expect(runWindowsHostPipeWorkerMain(state.port, state.boot, state.dependencies))
      .rejects.toThrow('ReadFile unavailable')
    expect(state.runWorker).not.toHaveBeenCalled()
  })
})
