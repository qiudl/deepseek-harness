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
  installationId: 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
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

  it('reports a clean disconnect before serving the next connection', async () => {
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
})
