import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { WindowsHostWorkerMessage } from '../src/windows-host-worker-bridge.ts'
import { runWindowsHostPipeWorker } from '../src/windows-host-pipe-worker-runner.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const connectionId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const request = decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3124","supported_versions":[1]}}\n')
const response = decodeHostControlFrame('{"version":1,"type":"error","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","error":{"code":"unavailable","retryable":true,"correlation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3125"}}\n')
const policy = resolveWindowsNamedPipePolicy({
  installationId: 'slark-dsh-e3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
  endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126',
  userSid: 'S-1-5-21-1000-2000-3000-1001',
})

function fixture(frames: Array<HostControlFrame | null>) {
  const flag = createWindowsWorkerStopFlag()
  const sent: WindowsHostWorkerMessage[] = []
  const pipeResponses: HostControlFrame[] = []
  let listener: ((message: unknown) => void) | undefined
  const deliver = (message: unknown): void => { listener?.(message) }
  const options = {
    generation: 7,
    policy,
    stopFlag: flag,
    cancellation: {
      openCurrentThreadHandle: vi.fn(() => 91n),
      abandonUnhandedThreadHandle: vi.fn(),
    },
    lifecycleBindings: {
      createSecurityDescriptor: vi.fn(() => 11n),
      freeSecurityDescriptor: vi.fn(),
      createNamedPipe: vi.fn(() => 81n),
      connectNamedPipe: vi.fn(() => 'connected' as const),
      disconnectNamedPipe: vi.fn(),
      closeHandle: vi.fn(),
    },
    attest: vi.fn(async () => ({ pid: 42 })),
    createConnectionId: () => connectionId,
    createChannel: () => ({
      readFrame: vi.fn(async () => frames.shift() ?? null),
      send: vi.fn(async (frame: HostControlFrame) => { pipeResponses.push(frame) }),
    }),
    port: {
      send: vi.fn((message: WindowsHostWorkerMessage) => {
        sent.push(message)
        if (message.type === 'request') {
          queueMicrotask(() => {
            deliver({
              version: 1,
              type: 'response',
              generation: 7,
              connectionId,
              sequence: message.sequence,
              frame: encodeHostControlFrame(response),
            })
          })
        }
      }),
      subscribe: vi.fn((accept: (message: unknown) => void) => {
        listener = accept
        return () => { listener = undefined }
      }),
    },
  }
  return { flag, sent, pipeResponses, deliver, options }
}

describe('Windows Host pipe Worker runner', () => {
  it('reports stopped without opening native resources when stop won startup', async () => {
    const state = fixture([])
    state.flag.request()
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 0,
      requestsHandled: 0,
    })
    expect(state.options.cancellation.openCurrentThreadHandle).not.toHaveBeenCalled()
    expect(state.options.lifecycleBindings.createNamedPipe).not.toHaveBeenCalled()
    expect(state.sent).toEqual([{ version: 1, type: 'stopped', generation: 7 }])
  })

  it('abandons the Worker-owned thread handle if ready handoff fails', async () => {
    const state = fixture([])
    state.options.port.send.mockRejectedValueOnce(new Error('message port closed'))
    await expect(runWindowsHostPipeWorker(state.options)).rejects.toThrow('message port closed')
    expect(state.options.cancellation.abandonUnhandedThreadHandle).toHaveBeenCalledWith(91n)
    expect(state.options.lifecycleBindings.createNamedPipe).not.toHaveBeenCalled()
  })

  it('aggregates ready handoff and unhanded-handle cleanup failures', async () => {
    const state = fixture([])
    state.options.port.send.mockRejectedValueOnce('message port closed')
    state.options.cancellation.abandonUnhandedThreadHandle.mockImplementationOnce(() => {
      throw 'CloseHandle failed'
    })
    const failure = runWindowsHostPipeWorker(state.options).catch((error: unknown) => error)
    await expect(failure).resolves.toMatchObject({
      message: 'Windows Host Worker ready handoff and handle cleanup failed',
      errors: [
        { message: 'Windows Host pipe Worker failed' },
        { message: 'Windows Host pipe Worker failed' },
      ],
    })
    expect(state.options.lifecycleBindings.createNamedPipe).not.toHaveBeenCalled()
  })

  it('stops after descriptor allocation when cancellation wins before pipe creation', async () => {
    const state = fixture([])
    state.options.lifecycleBindings.createSecurityDescriptor.mockImplementationOnce(() => {
      state.flag.request()
      return 11n
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 0,
      requestsHandled: 0,
    })
    expect(state.options.lifecycleBindings.freeSecurityDescriptor).toHaveBeenCalledWith(11n)
    expect(state.options.lifecycleBindings.createNamedPipe).not.toHaveBeenCalled()
  })

  it('routes an attested pipe request through the parent and stops without writing a late frame', async () => {
    const state = fixture([request, null])
    let readCount = 0
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => {
        readCount += 1
        if (readCount === 1) return request
        state.flag.request()
        return null
      }),
      send: vi.fn(async (frame: HostControlFrame) => { state.pipeResponses.push(frame) }),
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 1,
    })
    expect(state.sent.map(message => message.type)).toEqual(['ready', 'connected', 'request', 'stopped'])
    expect(state.pipeResponses).toEqual([response])
    expect(state.options.attest).toHaveBeenCalledWith(81n)
    expect(state.options.lifecycleBindings.disconnectNamedPipe).toHaveBeenCalledWith(81n)
    expect(state.options.lifecycleBindings.closeHandle).toHaveBeenCalledWith(81n)
  })

  it('reports a clean disconnect and completes the stop handshake', async () => {
    const state = fixture([null])
    state.options.port.send.mockImplementation((message: WindowsHostWorkerMessage) => {
      state.sent.push(message)
      if (message.type === 'disconnected') state.flag.request()
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 0,
    })
    expect(state.sent.map(message => message.type)).toEqual(['ready', 'connected', 'disconnected', 'stopped'])
  })

  it('exits without the stop handshake after a clean disconnect when no stop was requested', async () => {
    const state = fixture([null])
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 0,
    })
    expect(state.sent.map(message => message.type)).toEqual(['ready', 'connected', 'disconnected'])
  })

  it('keeps the Worker generation when the Desktop peer hangs up mid-connection', async () => {
    const state = fixture([])
    const peerGone = Object.assign(new Error('WriteFile failed with Win32 code 232'), { win32Code: 232 })
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => { throw peerGone }),
      send: vi.fn(async () => { throw peerGone }),
    })
    state.options.port.send.mockImplementation((message: WindowsHostWorkerMessage) => {
      state.sent.push(message)
      if (message.type === 'disconnected') state.flag.request()
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 0,
    })
    expect(state.sent.map(message => message.type)).toEqual(['ready', 'connected', 'disconnected', 'stopped'])
  })

  it('lets a requested stop own the teardown when it races a peer hangup on write', async () => {
    const state = fixture([])
    const peerGone = Object.assign(new Error('WriteFile failed with Win32 code 232'), { win32Code: 232 })
    let reads = 0
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => {
        reads += 1
        return reads === 1 ? request : null
      }),
      send: vi.fn(async () => {
        state.flag.request()
        state.deliver({ version: 1, type: 'stop', generation: 7 })
        throw peerGone
      }),
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 1,
    })
    expect(state.sent.map(message => message.type)).toEqual(['ready', 'connected', 'request', 'stopped'])
  })

  it('closes the connection with the handled count when the peer hangs up on a response write', async () => {
    const state = fixture([])
    const peerGone = Object.assign(new Error('WriteFile failed with Win32 code 232'), { win32Code: 232 })
    let reads = 0
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => {
        reads += 1
        return reads === 1 ? request : null
      }),
      send: vi.fn(async () => { throw peerGone }),
    })
    await expect(runWindowsHostPipeWorker(state.options)).resolves.toEqual({
      connectionsServed: 1,
      requestsHandled: 1,
    })
    expect(state.sent).toEqual([
      { version: 1, type: 'ready', generation: 7, threadHandle: 91n },
      { version: 1, type: 'connected', generation: 7, connectionId },
      expect.objectContaining({ type: 'request', sequence: 1 }),
      { version: 1, type: 'disconnected', generation: 7, connectionId, requestsHandled: 1 },
    ])
  })

  it('fails the Worker generation when a connection fails for another reason', async () => {
    const state = fixture([])
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => { throw new Error('ReadFile failed with Win32 code 87') }),
      send: vi.fn(async () => {}),
    })
    await expect(runWindowsHostPipeWorker(state.options)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('fails the Worker generation when a connection error is not an object', async () => {
    const state = fixture([])
    state.options.createChannel = () => ({
      readFrame: vi.fn(async () => { throw 'ReadFile exploded' }),
      send: vi.fn(async () => {}),
    })
    await expect(runWindowsHostPipeWorker(state.options)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('fails the Worker generation after malformed parent input and unsubscribes', async () => {
    const state = fixture([request])
    state.options.port.send.mockImplementation((message: WindowsHostWorkerMessage) => {
      state.sent.push(message)
      if (message.type === 'request') queueMicrotask(() => { state.deliver({ type: 'response' }) })
    })
    await expect(runWindowsHostPipeWorker(state.options)).rejects.toBeInstanceOf(Error)
    expect(state.flag.requested()).toBe(true)
    expect(state.options.port.subscribe).toHaveBeenCalledOnce()
  })

  it('reports a malformed control message received during a cancellable accept', async () => {
    const state = fixture([])
    let releaseAttestation!: (evidence: { pid: number }) => void
    state.options.attest.mockImplementationOnce(() => {
      return new Promise<{ pid: number }>((resolve) => { releaseAttestation = resolve })
    })
    const running = runWindowsHostPipeWorker(state.options)
    await vi.waitFor(() => {
      expect(state.options.attest).toHaveBeenCalledOnce()
    })
    state.deliver({ type: 'response' })
    releaseAttestation({ pid: 42 })
    await expect(running).rejects.toBeInstanceOf(Error)
    expect(state.options.lifecycleBindings.closeHandle).toHaveBeenCalledWith(81n)
  })

  it('preserves a native lifecycle error when no control failure exists', async () => {
    const state = fixture([])
    state.options.lifecycleBindings.createSecurityDescriptor.mockRejectedValueOnce(new Error('LocalAlloc failed'))
    await expect(runWindowsHostPipeWorker(state.options)).rejects.toMatchObject({ code: 'unavailable' })
  })
})
