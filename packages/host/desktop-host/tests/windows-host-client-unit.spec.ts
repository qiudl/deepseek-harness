import { afterEach, describe, expect, it, vi } from 'vitest'
import { windowsNamedPipePath } from '../src/windows-named-pipe-policy.ts'

const mocks = vi.hoisted(() => ({
  connectAuthenticatedTransport: vi.fn(),
  connectNamedPipe: vi.fn(),
  startTransport: vi.fn(),
}))

vi.mock('../src/unix-transport.ts', () => ({
  UnixHostClient: {
    connectAuthenticatedTransport: mocks.connectAuthenticatedTransport,
    connectNamedPipe: mocks.connectNamedPipe,
  },
}))

vi.mock('../src/windows-host-client-worker-transport.ts', () => {
  class WindowsHostClientWorkerTransportError extends Error {
    constructor(readonly code: 'trusted_host_not_running' | 'host_unverified') {
      super(`Windows Host client Worker failed: ${code}`)
    }
  }
  return {
    WindowsHostClientWorkerTransportError,
    startWindowsHostClientWorkerTransport: mocks.startTransport,
  }
})

import {
  discoverWindowsHost,
  type WindowsHostClientOptions,
} from '../src/windows-host-client.ts'
import { WindowsHostClientWorkerTransportError } from '../src/windows-host-client-worker-transport.ts'
import type { StartWindowsHostClientWorkerTransportOptions } from '../src/windows-host-client-worker-transport.ts'

const installationId = 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820'
const endpointRegistrationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3180'
const socketPath = windowsNamedPipePath({ installationId, endpointRegistrationId })

function fixture(): WindowsHostClientOptions {
  return {
    platform: 'win32',
    arch: 'x64',
    socketPath,
    trustedEndpoint: true,
    endpointRegistrationId,
    trustedInstallationId: installationId,
    trustedInstallationPublicKey: 'A'.repeat(43),
    trustedExecutableSignatureDigest: 'b'.repeat(64),
    clientWorkerEntry: new URL('file:///C:/Program%20Files/Slark/client-worker.js'),
    trustedHostPublisherThumbprints: new Set(['C'.repeat(64)]),
    clientWorkerCancellation: {
      openCurrentThreadHandle: vi.fn(),
      abandonUnhandedThreadHandle: vi.fn(),
      cancel: vi.fn(() => 'cancelled' as const),
      close: vi.fn(),
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  mocks.connectAuthenticatedTransport.mockReset()
  mocks.connectNamedPipe.mockReset()
  mocks.startTransport.mockReset()
})

describe('Windows Host client discovery unit boundaries', () => {
  it.each([
    { platform: 'darwin' },
    { arch: 'arm64' },
    { trustedEndpoint: false },
  ])('rejects an unavailable transport before connection %#', async (override) => {
    await expect(discoverWindowsHost({ ...fixture(), ...override })).resolves.toEqual({
      state: 'unknown', code: 'transport_unavailable',
    })
    expect(mocks.startTransport).not.toHaveBeenCalled()
  })

  it('uses process runtime defaults and rejects a legacy connector on real Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    const { platform: _platform, arch: _arch, ...options } = fixture()
    await expect(discoverWindowsHost({ ...options, connectSocket: vi.fn() })).resolves.toEqual({
      state: 'unknown', code: 'host_unverified',
    })
  })

  it('rejects a mismatched or malformed registration pipe before connecting', async () => {
    await expect(discoverWindowsHost({ ...fixture(), socketPath: `${socketPath}-other` })).resolves.toEqual({
      state: 'unknown', code: 'host_unverified',
    })
    await expect(discoverWindowsHost({ ...fixture(), trustedInstallationId: '../invalid' })).resolves.toEqual({
      state: 'unknown', code: 'host_unverified',
    })
  })

  it.each(['clientWorkerEntry', 'trustedHostPublisherThumbprints', 'clientWorkerCancellation'] as const)(
    'fails closed when %s is absent',
    async (field) => {
      const options = { ...fixture() }
      Reflect.deleteProperty(options, field)
      await expect(discoverWindowsHost(options)).resolves.toEqual({ state: 'unknown', code: 'host_unverified' })
      expect(mocks.startTransport).not.toHaveBeenCalled()
    },
  )

  it('starts an authenticated Worker transport with defaults and optional factory omission', async () => {
    const transport = { close: vi.fn() }
    const client = { inspection: { installation_id: installationId } }
    mocks.startTransport.mockResolvedValueOnce(transport)
    mocks.connectAuthenticatedTransport.mockResolvedValueOnce(client)
    vi.useFakeTimers()

    const result = await discoverWindowsHost(fixture())

    expect(result).toEqual({ state: 'running', client, inspection: client.inspection })
    const options = mocks.startTransport.mock.calls[0]?.[0] as
      | StartWindowsHostClientWorkerTransportOptions
      | undefined
    if (options === undefined) throw new Error('Worker transport options missing')
    expect(options).toMatchObject({ generation: 1, connectTimeoutMs: 30_000, maxCancelAttempts: 3 })
    expect(options).not.toHaveProperty('createWorker')
    const retry = options.waitForCancelRetry()
    await vi.advanceTimersByTimeAsync(10)
    await expect(retry).resolves.toBeUndefined()
    expect(mocks.connectAuthenticatedTransport).toHaveBeenCalledWith(expect.objectContaining({
      trustedInstallationId: installationId,
    }), transport, undefined)
  })

  it('forwards custom Worker timing, factory, clock, and signal', async () => {
    const client = { inspection: {} }
    mocks.startTransport.mockResolvedValueOnce({})
    mocks.connectAuthenticatedTransport.mockResolvedValueOnce(client)
    const createClientWorker = vi.fn()
    const waitForCancelRetry = vi.fn(async () => undefined)
    const now = vi.fn(() => 42)
    const signal = new AbortController().signal
    await discoverWindowsHost({
      ...fixture(), connectTimeoutMs: 9, maxCancelAttempts: 7,
      createClientWorker, waitForCancelRetry, now,
    }, signal)
    expect(mocks.startTransport).toHaveBeenCalledWith(expect.objectContaining({
      connectTimeoutMs: 9, maxCancelAttempts: 7,
      createWorker: createClientWorker, waitForCancelRetry,
    }), signal)
    expect(mocks.connectAuthenticatedTransport).toHaveBeenCalledWith(expect.objectContaining({ now }), {}, signal)
  })

  it('supports the legacy protocol-test connector without spawning a Worker', async () => {
    const client = { inspection: { pid: 42 } }
    const connectSocket = vi.fn()
    mocks.connectNamedPipe.mockResolvedValueOnce(client)
    await expect(discoverWindowsHost({ ...fixture(), connectSocket })).resolves.toEqual({
      state: 'running', client, inspection: client.inspection,
    })
    expect(mocks.connectNamedPipe).toHaveBeenCalledWith(expect.objectContaining({ socketPath }), undefined, connectSocket)
    expect(mocks.startTransport).not.toHaveBeenCalled()
  })

  it.each([
    [new WindowsHostClientWorkerTransportError('trusted_host_not_running'), 'stopped'],
    [{ code: 'ENOENT' }, 'stopped'],
    [new WindowsHostClientWorkerTransportError('host_unverified'), 'unknown'],
    [null, 'unknown'],
  ] as const)('redacts discovery failure %#', async (failure, state) => {
    mocks.startTransport.mockRejectedValueOnce(failure)
    await expect(discoverWindowsHost(fixture())).resolves.toEqual(state === 'stopped'
      ? { state, code: 'trusted_host_not_running' }
      : { state, code: 'host_unverified' })
  })
})
