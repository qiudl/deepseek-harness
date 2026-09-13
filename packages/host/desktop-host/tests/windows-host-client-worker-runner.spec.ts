import { describe, expect, it, vi } from 'vitest'
import {
  encodeHostControlFrame,
  decodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  runWindowsHostClientWorker,
  type WindowsHostClientWorkerPort,
} from '../src/windows-host-client-worker-runner.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

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

const evidence = {
  pid: 42,
  userSid: 'S-1-5-21-1-2-3-1001',
  executablePath: String.raw`C:\Program Files\Slark\node.exe`,
  authenticodePublisherThumbprint: 'A'.repeat(64),
  executableSignatureDigest: 'b'.repeat(64),
}

function fixture() {
  let listener: ((message: unknown) => void) | undefined
  const sent: unknown[] = []
  const stopFlag = createWindowsWorkerStopFlag()
  const port: WindowsHostClientWorkerPort = {
    send: vi.fn((message: unknown) => { sent.push(message) }),
    subscribe: vi.fn((accept: (message: unknown) => void) => {
      listener = accept
      return () => { listener = undefined }
    }),
  }
  const channel = {
    send: vi.fn(async () => undefined),
    readFrame: vi.fn(async () => response),
  }
  const options = {
    generation: 4,
    pipePath: String.raw`\\.\pipe\slark-dsh-host-v1-${'a'.repeat(64)}`,
    stopFlag,
    cancellation: {
      openCurrentThreadHandle: vi.fn(() => 901n),
      abandonUnhandedThreadHandle: vi.fn(),
    },
    client: { connect: vi.fn(async () => 91n), close: vi.fn(async () => undefined) },
    attestServer: vi.fn(async () => evidence),
    createChannel: vi.fn(() => channel),
    port,
  }
  return { sent, stopFlag, channel, options, emit: (message: unknown) => listener?.(message) }
}

describe('Windows Host client Worker runner', () => {
  it('attests the server on the same handle before forwarding one correlated request', async () => {
    const state = fixture()
    state.options.port.send = vi.fn((message: unknown) => {
      state.sent.push(message)
      const type = (message as { type?: string }).type
      if (type === 'ready') queueMicrotask(() => state.emit({
        version: 1, type: 'request', generation: 4, sequence: 1,
        frame: encodeHostControlFrame(request),
      }))
      if (type === 'response') queueMicrotask(() => {
        state.stopFlag.request()
        state.emit({ version: 1, type: 'stop', generation: 4 })
      })
    })
    const result = await runWindowsHostClientWorker(state.options)
    expect(result).toEqual({ requestsHandled: 1 })
    expect(state.sent.map(message => (message as { type: string }).type)).toEqual([
      'starting', 'ready', 'response', 'stopped',
    ])
    expect(state.options.attestServer).toHaveBeenCalledWith(91n)
    expect(state.channel.send).toHaveBeenCalledWith(request)
    expect(state.options.client.close).toHaveBeenCalledWith(91n)
    expect(state.options.cancellation.abandonUnhandedThreadHandle).not.toHaveBeenCalled()
  })

  it('closes the connected pipe when server attestation fails', async () => {
    const state = fixture()
    state.options.attestServer = vi.fn(async () => { throw new Error('spoofed server') })
    await expect(runWindowsHostClientWorker(state.options)).rejects.toThrow('spoofed server')
    expect(state.options.client.close).toHaveBeenCalledWith(91n)
    expect(state.sent.map(message => (message as { type: string }).type)).toEqual(['starting'])
  })

  it('reclaims an unhanded cancellation handle when starting publication fails', async () => {
    const state = fixture()
    state.options.port.send = vi.fn(() => { throw new Error('parent unavailable') })
    await expect(runWindowsHostClientWorker(state.options)).rejects.toThrow('parent unavailable')
    expect(state.options.cancellation.abandonUnhandedThreadHandle).toHaveBeenCalledWith(901n)
    expect(state.options.client.connect).not.toHaveBeenCalled()
  })

  it('poisons malformed parent messages and closes the pipe', async () => {
    const state = fixture()
    state.options.port.send = vi.fn((message: unknown) => {
      state.sent.push(message)
      if ((message as { type?: string }).type === 'ready') {
        queueMicrotask(() => state.emit({ version: 1, type: 'stop', generation: 5 }))
      }
    })
    await expect(runWindowsHostClientWorker(state.options)).rejects.toThrow()
    expect(state.options.client.close).toHaveBeenCalledWith(91n)
  })

  it('treats a cancelled blocking read as a clean stop only after the shared flag is set', async () => {
    const state = fixture()
    state.options.createChannel = vi.fn(() => ({
      send: vi.fn(async () => undefined),
      readFrame: vi.fn(async () => {
        state.stopFlag.request()
        throw new Error('ReadFile cancelled')
      }),
    }))
    state.options.port.send = vi.fn((message: unknown) => {
      state.sent.push(message)
      if ((message as { type?: string }).type === 'ready') queueMicrotask(() => state.emit({
        version: 1, type: 'request', generation: 4, sequence: 1,
        frame: encodeHostControlFrame(request),
      }))
    })
    await expect(runWindowsHostClientWorker(state.options)).resolves.toEqual({ requestsHandled: 0 })
    expect(state.sent.at(-1)).toMatchObject({ type: 'stopped' })
    expect(state.options.client.close).toHaveBeenCalledWith(91n)
  })

  it('does not begin new native I/O when stop wins after a request was queued', async () => {
    const state = fixture()
    state.options.port.send = vi.fn((message: unknown) => {
      state.sent.push(message)
      if ((message as { type?: string }).type === 'ready') queueMicrotask(() => {
        state.emit({
          version: 1, type: 'request', generation: 4, sequence: 1,
          frame: encodeHostControlFrame(request),
        })
        state.stopFlag.request()
      })
    })
    await expect(runWindowsHostClientWorker(state.options)).resolves.toEqual({ requestsHandled: 0 })
    expect(state.channel.send).not.toHaveBeenCalled()
    expect(state.channel.readFrame).not.toHaveBeenCalled()
  })
})
