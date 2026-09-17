import { describe, expect, it, vi } from 'vitest'
import { WindowsNamedPipeClientNativeError } from '../src/windows-named-pipe-client-native.ts'
import { WindowsNamedPipeFrameChannel } from '../src/windows-named-pipe-frame-channel.ts'
import { runWindowsHostClientWorkerMain, type WindowsHostClientWorkerMainDependencies } from '../src/windows-host-client-worker-main.ts'

const boot = {
  version: 1,
  generation: 4,
  pipePath: String.raw`\\.\pipe\slark-dsh-host-v1-${'a'.repeat(64)}`,
  stopFlagBuffer: new SharedArrayBuffer(4),
  connectTimeoutMs: 5_000,
  allowedPublisherThumbprints: ['A'.repeat(64)],
  allowedPackageFamilyNames: [],
  allowedExecutableDigests: ['b'.repeat(64)],
}

function fixture(runWorker = vi.fn<WindowsHostClientWorkerMainDependencies['runWorker']>(async () => ({ requestsHandled: 2 }))) {
  const sent: unknown[] = []
  const dependencies = {
    loadCancellation: vi.fn(async () => ({
      openCurrentThreadHandle: vi.fn(() => 901n),
      abandonUnhandedThreadHandle: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    })),
    loadClient: vi.fn(async () => ({ connect: vi.fn(), close: vi.fn() })),
    loadIo: vi.fn(async () => ({ read: vi.fn(), writeFrame: vi.fn() })),
    loadAttestor: vi.fn(async () => vi.fn()),
    runWorker,
  }
  const port = {
    send: vi.fn((message: unknown) => { sent.push(message) }),
    subscribe: vi.fn(() => () => undefined),
  }
  return { dependencies, port, sent }
}

describe('Windows Host client Worker main composition', () => {
  it('loads an all-or-nothing server attestation chain and enters the runner', async () => {
    const state = fixture()
    await expect(runWindowsHostClientWorkerMain(state.port, boot, state.dependencies))
      .resolves.toEqual({ requestsHandled: 2 })
    expect(state.dependencies.loadClient).toHaveBeenCalledWith({ connectTimeoutMs: 5_000 })
    expect(state.dependencies.loadAttestor).toHaveBeenCalledWith({
      allowedPublisherThumbprints: new Set(['A'.repeat(64)]),
      allowedPackageFamilyNames: new Set(),
      allowedExecutableDigests: new Set(['b'.repeat(64)]),
      peerProcessRole: 'server',
    })
    expect(state.dependencies.runWorker).toHaveBeenCalledOnce()
    expect(state.dependencies.runWorker.mock.calls[0]?.[0]).toMatchObject({
      generation: 4,
      pipePath: boot.pipePath,
    })
    expect(state.dependencies.runWorker.mock.calls[0]?.[0].createChannel(91n))
      .toBeInstanceOf(WindowsNamedPipeFrameChannel)
  })

  it('maps only a missing fixed pipe to stopped and redacts every other native failure', async () => {
    for (const [error, code] of [
      [new WindowsNamedPipeClientNativeError('WaitNamedPipeW', 2), 'trusted_host_not_running'],
      [new WindowsNamedPipeClientNativeError('CreateFileW', 5), 'host_unverified'],
      [new Error('spoofed publisher details'), 'host_unverified'],
    ] as const) {
      const state = fixture(vi.fn(async () => { throw error }))
      await expect(runWindowsHostClientWorkerMain(state.port, boot, state.dependencies))
        .resolves.toEqual({ requestsHandled: 0 })
      expect(state.sent).toEqual([{
        version: 1, type: 'failed', generation: 4, code,
      }])
    }
  })

  it('rejects malformed boot data before loading native modules', async () => {
    const state = fixture()
    await expect(runWindowsHostClientWorkerMain(state.port, { ...boot, extra: true }, state.dependencies))
      .rejects.toThrow()
    expect(state.dependencies.loadCancellation).not.toHaveBeenCalled()
  })
})
