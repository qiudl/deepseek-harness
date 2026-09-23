import { describe, expect, it, vi } from 'vitest'
import {
  encodeHostControlFrame,
  decodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  WindowsHostClientWorkerTransportError,
  startWindowsHostClientWorkerTransport,
  type WindowsHostClientWorkerThreadLike,
} from '../src/windows-host-client-worker-transport.ts'

const workerThreadMocks = vi.hoisted(() => ({ Worker: vi.fn() }))
vi.mock('node:worker_threads', () => workerThreadMocks)

const pipePath = String.raw`\\.\pipe\slark-dsh-host-v1-${'a'.repeat(64)}`
const publisher = 'A'.repeat(64)
const digest = 'b'.repeat(64)
const request = decodeHostControlFrame(`${JSON.stringify({
  version: 1,
  type: 'request',
  request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3180',
  method: 'host.inspect',
  params: {
    challenge: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
    client_instance_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3181',
    supported_versions: [1],
  },
})}\n`)
const response = decodeHostControlFrame(`${JSON.stringify({
  version: 1,
  type: 'error',
  request_id: request.request_id,
  method: request.method,
  error: { code: 'unavailable', retryable: true, correlation_id: request.request_id },
})}\n`)

class FakeWorker implements WindowsHostClientWorkerThreadLike {
  readonly posted: unknown[] = []
  postMessageFailure: unknown
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>()
  postMessage(value: unknown): void {
    if (this.postMessageFailure !== undefined) throw this.postMessageFailure
    this.posted.push(value)
  }
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return this
  }
  off(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }
  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
  listenersFor(event: 'message' | 'error' | 'exit'): Array<(value: unknown) => void> {
    return [...(this.listeners.get(event) ?? [])]
  }
}

function fixture() {
  const worker = new FakeWorker()
  const cancellation = {
    openCurrentThreadHandle: vi.fn(),
    abandonUnhandedThreadHandle: vi.fn(),
    cancel: vi.fn(() => 'cancelled' as const),
    close: vi.fn(),
  }
  const createWorker = vi.fn(() => worker)
  const options = {
    generation: 4,
    workerEntry: new URL('file:///C:/Program%20Files/Slark/windows-host-client-worker-entry.js'),
    pipePath,
    connectTimeoutMs: 5_000,
    allowedPublisherThumbprints: new Set([publisher]),
    allowedExecutableDigests: new Set([digest]),
    cancellation,
    createWorker,
    maxCancelAttempts: 2,
    waitForCancelRetry: async () => undefined,
  }
  const starting = () => {
    worker.emit('message', {
      version: 1, type: 'starting', generation: 4, threadHandle: 901n,
    })
  }
  const ready = (overrides: Record<string, unknown> = {}) => {
    worker.emit('message', {
      version: 1,
      type: 'ready',
      generation: 4,
      evidence: {
        pid: 42,
        userSid: 'S-1-5-21-1-2-3-1001',
        executablePath: String.raw`C:\Program Files\Slark\node.exe`,
        authenticodePublisherThumbprint: publisher,
        executableSignatureDigest: digest,
        ...overrides,
      },
    })
  }
  return { worker, cancellation, createWorker, options, starting, ready }
}

describe('Windows Host client Worker transport', () => {
  it('preserves a supplied failure cause and omits an absent one', () => {
    const cause = new Error('native failure')
    expect(new WindowsHostClientWorkerTransportError('host_unverified', cause)).toMatchObject({ cause })
    expect(new WindowsHostClientWorkerTransportError('host_unverified')).not.toHaveProperty('cause')
  })

  it('uses the fixed default Worker constructor when no factory is injected', async () => {
    const state = fixture()
    workerThreadMocks.Worker.mockImplementationOnce(function MockWorker() { return state.worker })
    const { createWorker: _createWorker, ...options } = state.options
    const opening = startWindowsHostClientWorkerTransport(options)
    state.starting(); state.ready()
    const transport = await opening
    expect(workerThreadMocks.Worker).toHaveBeenCalledWith(options.workerEntry, expect.objectContaining({
      name: 'dsh-windows-host-client', execArgv: [],
    }))
    transport.close(); state.worker.emit('exit', 0)
  })

  it('retains a late cancellation handle after startup is aborted', async () => {
    const state = fixture()
    const controller = new AbortController()
    const opening = startWindowsHostClientWorkerTransport(state.options, controller.signal)
    const reason = new Error('startup cancelled')
    controller.abort(reason)
    await expect(opening).rejects.toBe(reason)
    state.starting()
    await Promise.resolve()
    expect(state.cancellation.cancel).toHaveBeenCalledWith(901n)
    expect(state.cancellation.close).not.toHaveBeenCalled()
    state.worker.emit('exit', 0)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(state.cancellation.close).toHaveBeenCalledExactlyOnceWith(901n)
  })

  it('rejects immediately when startup receives an already-aborted signal', async () => {
    const state = fixture()
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    await expect(startWindowsHostClientWorkerTransport(state.options, controller.signal)).rejects.toBe(reason)
    state.worker.emit('exit', 0)
  })

  it.each([0, 1])('reclaims the handle on exit %s after the cancellation budget expires', async (code) => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    transport.close()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(state.cancellation.cancel).toHaveBeenCalledTimes(2)
    expect(state.cancellation.close).not.toHaveBeenCalled()
    state.worker.emit('exit', code)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(state.cancellation.close).toHaveBeenCalledExactlyOnceWith(901n)
  })

  it('opens only after attested ready and correlates one request/response sequence', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    expect(state.createWorker).toHaveBeenCalledWith(state.options.workerEntry, expect.objectContaining({
      name: 'dsh-windows-host-client', execArgv: [],
    }))
    const pending = transport.call(request)
    expect(state.worker.posted.at(-1)).toMatchObject({ type: 'request', sequence: 1 })
    state.worker.emit('message', {
      version: 1, type: 'response', generation: 4, sequence: 1,
      frame: encodeHostControlFrame(response),
    })
    await expect(pending).resolves.toEqual(response)
    expect(transport.isConnected()).toBe(true)

    transport.close()
    expect(transport.isConnected()).toBe(false)
    expect(state.worker.posted.at(-1)).toMatchObject({ type: 'stop' })
    state.worker.emit('exit', 0)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(state.cancellation.cancel).toHaveBeenCalledWith(901n)
    expect(state.cancellation.close).toHaveBeenCalledWith(901n)
  })

  it('preserves only the bounded missing-pipe state and rejects every other startup ambiguity', async () => {
    for (const code of ['trusted_host_not_running', 'host_unverified'] as const) {
      const state = fixture()
      const opening = startWindowsHostClientWorkerTransport(state.options)
      state.worker.emit('message', { version: 1, type: 'failed', generation: 4, code })
      await expect(opening).rejects.toMatchObject({ code })
      state.worker.emit('exit', 0)
    }
  })

  it.each([
    ['worker error', new Error('worker crashed')],
    ['non-Error worker error', 'worker crashed'],
    ['clean early exit', 0],
    ['unclean early exit', 9],
  ])('rejects startup after %s', async (_label, failure) => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    if (typeof failure === 'number') state.worker.emit('exit', failure)
    else state.worker.emit('error', failure)
    await expect(opening).rejects.toThrow()
    state.worker.emit('exit', 0)
  })

  it('ignores a duplicate captured exit callback and detaches all listeners', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    const [exit] = state.worker.listenersFor('exit')
    state.worker.emit('exit', 7)
    await expect(opening).rejects.toThrow('host_unverified')
    expect(state.worker.listenersFor('message')).toHaveLength(0)
    expect(state.worker.listenersFor('error')).toHaveLength(0)
    expect(state.worker.listenersFor('exit')).toHaveLength(0)
    exit?.(0)
  })

  it('keeps the first failure across repeated and stale Worker callbacks', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    const [error] = state.worker.listenersFor('error')
    const first = new Error('first failure')
    state.worker.emit('error', first)
    state.worker.emit('error', new Error('second failure'))
    await expect(opening).rejects.toBe(first)
    state.worker.emit('exit', 0)
    error?.(new Error('stale failure'))
  })

  it('rejects ready evidence that does not match the parent trust snapshot', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready({ executableSignatureDigest: 'c'.repeat(64) })
    await expect(opening).rejects.toBeInstanceOf(WindowsHostClientWorkerTransportError)
    expect(state.worker.posted.at(-1)).toMatchObject({ type: 'stop' })
    state.worker.emit('exit', 0)
  })

  it('poisons an uncorrelated response and rejects concurrent calls', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    const first = transport.call(request)
    await expect(transport.call({ ...request, request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3182' as never }))
      .rejects.toThrow('concurrent')
    state.worker.emit('message', {
      version: 1, type: 'response', generation: 4, sequence: 2,
      frame: encodeHostControlFrame(response),
    })
    await expect(first).rejects.toThrow()
    expect(transport.isConnected()).toBe(false)
    state.worker.emit('exit', 0)
  })

  it('rejects disconnected and non-request calls', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    await expect(transport.call(response)).rejects.toThrow('requires a request')
    transport.close()
    await expect(transport.call(request)).rejects.toThrow('closed')
    transport.close()
    state.worker.emit('message', { version: 1, type: 'stopped', generation: 4 })
    state.worker.emit('exit', 0)
  })

  it('rejects a pending request when explicitly closed', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    const pending = transport.call(request)
    transport.close()
    await expect(pending).rejects.toThrow('closed')
    state.worker.emit('exit', 0)
  })

  it.each(['already aborted', 'later aborted'])('poisons an %s request', async (timing) => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    const controller = new AbortController()
    const reason = new Error('request cancelled')
    if (timing === 'already aborted') controller.abort(reason)
    const pending = transport.call(request, controller.signal)
    if (timing === 'later aborted') controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(transport.isConnected()).toBe(false)
    state.worker.emit('exit', 0)
  })

  it('poisons a request when posting to the Worker throws', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready()
    const transport = await opening
    state.worker.postMessageFailure = 'structured clone failed'
    await expect(transport.call(request)).rejects.toBeInstanceOf(WindowsHostClientWorkerTransportError)
    expect(transport.isConnected()).toBe(false)
    state.worker.emit('exit', 0)
  })

  it('rejects every response ambiguity after a request is pending', async () => {
    const cases: unknown[] = [
      { version: 1, type: 'response', generation: 4, sequence: 2, frame: encodeHostControlFrame(response) },
      { version: 1, type: 'response', generation: 4, sequence: 1, frame: encodeHostControlFrame({ ...response, request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3182' as never }) },
      { version: 1, type: 'response', generation: 4, sequence: 1, frame: encodeHostControlFrame({ ...response, method: 'host.execute' as never }) },
    ]
    for (const message of cases) {
      const state = fixture()
      const opening = startWindowsHostClientWorkerTransport(state.options)
      state.starting(); state.ready()
      const transport = await opening
      const pending = transport.call(request)
      state.worker.emit('message', message)
      await expect(pending).rejects.toThrow()
      state.worker.emit('exit', 0)
    }
  })

  it('rejects protocol-valid messages in invalid parent phases', async () => {
    const messages: unknown[] = [
      { version: 1, type: 'starting', generation: 4, threadHandle: 902n },
      { version: 1, type: 'response', generation: 4, sequence: 1, frame: encodeHostControlFrame(response) },
      { version: 1, type: 'stopped', generation: 4 },
      { version: 1, type: 'request', generation: 4, sequence: 1, frame: encodeHostControlFrame(request) },
      { version: 1, type: 'stop', generation: 4 },
    ]
    for (const message of messages) {
      const state = fixture()
      const opening = startWindowsHostClientWorkerTransport(state.options)
      state.starting(); state.ready()
      await opening
      state.worker.emit('message', message)
      expect(state.worker.posted.at(-1)).toMatchObject({ type: 'stop' })
      state.worker.emit('exit', 0)
    }
  })

  it.each([
    { authenticodePublisherThumbprint: 'B'.repeat(64) },
    { executableSignatureDigest: 'c'.repeat(64) },
  ])('rejects mismatched ready evidence %#', async (evidence) => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.ready(evidence)
    await expect(opening).rejects.toBeInstanceOf(WindowsHostClientWorkerTransportError)
    state.worker.emit('exit', 0)
  })

  it('rejects ready before the Worker transfers its cancellation handle', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.ready()
    await expect(opening).rejects.toThrow()
    state.worker.emit('exit', 0)
  })

  it('rejects a duplicate starting handle while startup is in progress', async () => {
    const state = fixture()
    const opening = startWindowsHostClientWorkerTransport(state.options)
    state.starting(); state.starting()
    await expect(opening).rejects.toThrow()
    state.worker.emit('exit', 0)
  })

  it('accepts a late starting handle after close and fences a throwing stop post', async () => {
    const state = fixture()
    const controller = new AbortController()
    const opening = startWindowsHostClientWorkerTransport(state.options, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(opening).rejects.toThrow('cancelled')
    state.worker.postMessageFailure = new Error('post failed')
    state.starting()
    await vi.waitFor(() => { expect(state.cancellation.cancel).toHaveBeenCalledWith(901n) })
    state.worker.emit('exit', 0)
  })

  it('requires one fixed file Worker entry before spawning', async () => {
    const state = fixture()
    await expect(startWindowsHostClientWorkerTransport({
      ...state.options,
      workerEntry: new URL('https://example.com/worker.js'),
    })).rejects.toThrow('file URL')
    expect(state.createWorker).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects cancellation budget %s', async (budget) => {
    const state = fixture()
    await expect(startWindowsHostClientWorkerTransport({
      ...state.options, maxCancelAttempts: budget,
    })).rejects.toThrow('cancellation budget')
    expect(state.createWorker).not.toHaveBeenCalled()
  })
})
