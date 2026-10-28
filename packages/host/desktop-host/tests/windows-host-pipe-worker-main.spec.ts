import { describe, expect, it, vi } from 'vitest'
import { createWindowsHostPipeWorkerBootData } from '../src/windows-host-pipe-worker-boot.ts'
import {
  runWindowsHostPipeWorkerMain,
} from '../src/windows-host-pipe-worker-main.ts'
import type {
  WindowsHostPipeWorkerRouterOptions,
  WindowsHostPipeSlotHandle,
} from '../src/windows-host-pipe-worker-router.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
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
    diagnosticsRoot: String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`,
  })
  const port = { send: vi.fn(), subscribe: vi.fn(() => () => undefined) }
  const firstInstances: boolean[] = []
  const spawnSlot = vi.fn((firstInstance: boolean): WindowsHostPipeSlotHandle => {
    firstInstances.push(firstInstance)
    return {
      port: { send: vi.fn(), subscribe: vi.fn(() => () => undefined) },
      exited: new Promise<void>(() => undefined),
      terminate: vi.fn(),
    }
  })
  const runRouter = vi.fn(async (_options: WindowsHostPipeWorkerRouterOptions) => ({
    connectionsServed: 0,
    requestsHandled: 0,
  }))
  const dependencies = { spawnSlot, runRouter }
  return { parentFlag, boot, port, spawnSlot, runRouter, firstInstances, dependencies }
}

describe('Windows Host pipe Worker composition root', () => {
  it('enters the router with the shared stop generation and the slot spawn seam', async () => {
    const state = fixture()
    await expect(runWindowsHostPipeWorkerMain(state.port, state.boot, state.dependencies))
      .resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.runRouter).toHaveBeenCalledOnce()
    const options = state.runRouter.mock.calls[0]?.[0]
    expect(options).toMatchObject({ generation: 7, port: state.port })
    expect(options?.stopFlag.requested()).toBe(false)
    expect(options?.stopFlag.buffer).toBe(state.parentFlag.buffer)
    expect(typeof options?.spawnSlot).toBe('function')
  })

  it('reports a pre-start stop without spawning any slot', async () => {
    const state = fixture()
    state.parentFlag.request()
    await expect(runWindowsHostPipeWorkerMain(state.port, state.boot, state.dependencies))
      .resolves.toEqual({ connectionsServed: 0, requestsHandled: 0 })
    expect(state.port.send).toHaveBeenCalledWith({ version: 1, type: 'stopped', generation: 7 })
    expect(state.runRouter).not.toHaveBeenCalled()
  })

  it('rejects malformed boot data before entering the router', async () => {
    const state = fixture()
    await expect(runWindowsHostPipeWorkerMain(state.port, { ...state.boot, extra: true }, state.dependencies))
      .rejects.toThrow('Invalid Windows Host Worker boot data')
    expect(state.runRouter).not.toHaveBeenCalled()
  })
})
