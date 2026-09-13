import { describe, expect, it, vi } from 'vitest'
import {
  WindowsHostProcessFallbackRequiredError,
  startWindowsHostCarrier,
  type WindowsHostCarrierWorker,
  type WindowsHostProcessFallbackRequest,
  type WindowsHostRegistration,
  type StartWindowsHostCarrierWorkerOptions,
} from '../src/windows-host-carrier.ts'

const installationId = 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820'
const endpointRegistrationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126'
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function fixture(workerOverrides: Partial<WindowsHostCarrierWorker> = {}) {
  const calls: string[] = []
  const stop = vi.fn(async () => ({ state: 'stopped', cancelAttempts: 1, sessionCleanup: 'closed' } as const))
  const worker: WindowsHostCarrierWorker = {
    state: 'ready',
    waitUntilReady: vi.fn(async () => { calls.push('ready') }),
    stop,
    ...workerOverrides,
  }
  const publishRegistration = vi.fn<(registration: WindowsHostRegistration) => Promise<void>>(async () => {
    calls.push('publish')
  })
  const processFallback = vi.fn<(request: WindowsHostProcessFallbackRequest) => void>(() => { calls.push('fallback') })
  const startWorker = vi.fn<(options: StartWindowsHostCarrierWorkerOptions) => WindowsHostCarrierWorker>(() => {
    calls.push('start')
    return worker
  })
  const resolveCurrentUserSid = vi.fn(async () => { calls.push('sid'); return userSid })
  const options = {
    platform: 'win32',
    arch: 'x64',
    installationId,
    endpointRegistrationId,
    installationPublicKey: 'A'.repeat(43),
    executableSignatureDigest: '1'.repeat(64),
    resolveCurrentUserSid,
    publishRegistration,
    startWorker,
    processFallback,
  }
  return { calls, worker, stop: workerOverrides.stop ?? stop, publishRegistration, processFallback, startWorker, options }
}

describe('Windows Host carrier startup', () => {
  it('publishes the exact registration only after Worker readiness and closes once', async () => {
    const state = fixture()
    const carrier = await startWindowsHostCarrier(state.options)
    expect(state.calls).toEqual(['sid', 'start', 'ready', 'publish'])
    expect(state.startWorker).toHaveBeenCalledOnce()
    const workerOptions = state.startWorker.mock.calls[0]?.[0]
    expect(workerOptions?.policy.path).toMatch(/^\\\\\.\\pipe\\slark-dsh-host-v1-[0-9a-f]{64}$/u)
    expect(workerOptions?.policy.securityDescriptor).toBe(`O:${userSid}D:P(A;;GRGW;;;${userSid})`)
    expect(state.publishRegistration).toHaveBeenCalledOnce()
    const registration = state.publishRegistration.mock.calls[0]?.[0]
    expect(registration).toEqual({
      schema_version: 1,
      endpoint_registration_id: endpointRegistrationId,
      socket_path: workerOptions?.policy.path,
      installation_id: installationId,
      installation_public_key: 'A'.repeat(43),
      executable_signature_digest: '1'.repeat(64),
    })
    await carrier.close()
    await carrier.close()
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.processFallback).not.toHaveBeenCalled()
  })

  it('does not publish registration and stops the Worker when readiness fails', async () => {
    const state = fixture({ waitUntilReady: vi.fn(async () => { throw new Error('ready failed') }) })
    await expect(startWindowsHostCarrier(state.options)).rejects.toThrow('ready failed')
    expect(state.publishRegistration).not.toHaveBeenCalled()
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it('owns a synchronous Worker failure reported during construction', async () => {
    const state = fixture()
    const runtimeFailure = new Error('worker failed while being constructed')
    const onFailure = vi.fn<(error: Error) => void>()
    state.startWorker.mockImplementationOnce((options) => {
      options.onFailure(runtimeFailure)
      return state.worker
    })
    await expect(startWindowsHostCarrier({ ...state.options, onFailure })).rejects.toThrow(
      'worker failed while being constructed',
    )
    expect(onFailure).toHaveBeenCalledWith(runtimeFailure)
    expect(state.publishRegistration).not.toHaveBeenCalled()
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it('does not publish when the Worker loses ready state before publication', async () => {
    const stop = vi.fn(async () => ({ state: 'stopped', cancelAttempts: 0, sessionCleanup: 'closed' } as const))
    const worker = {
      state: 'failed' as const,
      waitUntilReady: vi.fn(async () => undefined),
      stop,
    }
    const state = fixture()
    const options = { ...state.options, startWorker: vi.fn(() => worker) }
    await expect(startWindowsHostCarrier(options)).rejects.toThrow()
    expect(state.publishRegistration).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('stops the ready Worker when atomic registration publication fails', async () => {
    const state = fixture()
    state.publishRegistration.mockRejectedValueOnce(new Error('publish failed'))
    await expect(startWindowsHostCarrier(state.options)).rejects.toThrow('publish failed')
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it('does not return ready when the Worker fails during registration publication', async () => {
    const worker = {
      state: 'ready' as WindowsHostCarrierWorker['state'],
      waitUntilReady: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ state: 'stopped', cancelAttempts: 0, sessionCleanup: 'closed' } as const)),
    }
    const state = fixture()
    state.publishRegistration.mockImplementationOnce(async () => { worker.state = 'failed' })
    const options = { ...state.options, startWorker: vi.fn(() => worker) }
    await expect(startWindowsHostCarrier(options)).rejects.toThrow()
    expect(state.publishRegistration).toHaveBeenCalledOnce()
    expect(worker.stop).toHaveBeenCalledOnce()
  })

  it('requires process fallback when bounded Worker shutdown remains unconfirmed', async () => {
    const state = fixture({
      stop: vi.fn<WindowsHostCarrierWorker['stop']>(async () => ({ state: 'still_running', cancelAttempts: 3, sessionCleanup: 'still_closing' })),
    })
    const carrier = await startWindowsHostCarrier(state.options)
    await expect(carrier.close()).rejects.toBeInstanceOf(WindowsHostProcessFallbackRequiredError)
    await expect(carrier.close()).rejects.toBeInstanceOf(WindowsHostProcessFallbackRequiredError)
    expect(state.processFallback).toHaveBeenCalledOnce()
    expect(state.processFallback.mock.calls[0]?.[0]).toMatchObject({
      reason: 'worker_still_running', stopResult: { state: 'still_running', cancelAttempts: 3 },
    })
  })

  it('requires process fallback when Worker shutdown throws', async () => {
    const stopFailure = new Error('stop failed')
    const state = fixture({ stop: vi.fn(async () => { throw stopFailure }) })
    const carrier = await startWindowsHostCarrier(state.options)
    await expect(carrier.close()).rejects.toBeInstanceOf(WindowsHostProcessFallbackRequiredError)
    expect(state.processFallback).toHaveBeenCalledOnce()
    expect(state.processFallback.mock.calls[0]?.[0]).toMatchObject({
      reason: 'worker_stop_failed', cause: stopFailure,
    })
  })

  it('owns runtime Worker failure and escalates an unconfirmed stop to the process', async () => {
    let reportWorkerFailure: ((error: Error) => void) | undefined
    const state = fixture({
      stop: vi.fn<WindowsHostCarrierWorker['stop']>(async () => ({ state: 'still_running', cancelAttempts: 3, sessionCleanup: 'still_closing' })),
    })
    const onFailure = vi.fn<(error: Error) => void>()
    state.startWorker.mockImplementationOnce((options) => {
      reportWorkerFailure = Reflect.get(options, 'onFailure')
      return state.worker
    })
    const carrier = await startWindowsHostCarrier({ ...state.options, onFailure })
    expect(reportWorkerFailure).toBeTypeOf('function')

    const runtimeFailure = new Error('worker failed after ready')
    reportWorkerFailure?.(runtimeFailure)
    await vi.waitFor(() => { expect(state.processFallback).toHaveBeenCalledOnce() })
    expect(onFailure).toHaveBeenCalledWith(runtimeFailure)
    expect(state.processFallback.mock.calls[0]?.[0]).toMatchObject({
      reason: 'worker_still_running', cause: runtimeFailure,
    })
    await expect(carrier.close()).rejects.toBeInstanceOf(WindowsHostProcessFallbackRequiredError)
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it('rejects unsupported runtime facts before native identity or Worker startup', async () => {
    const state = fixture()
    await expect(startWindowsHostCarrier({ ...state.options, arch: 'arm64' })).rejects.toThrow()
    expect(state.options.resolveCurrentUserSid).not.toHaveBeenCalled()
    expect(state.startWorker).not.toHaveBeenCalled()
  })
})
