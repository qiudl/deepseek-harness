import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeWindowsHostWorkerMessage,
  WindowsHostWorkerBridge,
  WindowsHostWorkerProtocolError,
  type WindowsHostWorkerMessage,
} from '../src/windows-host-worker-bridge.ts'

const connectionId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const request = decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3124","supported_versions":[1]}}\n')

function responseFor(frame: HostControlFrame): HostControlFrame {
  if (frame.type !== 'request') throw new Error('expected request')
  return decodeHostControlFrame(`{"version":1,"type":"error","request_id":"${frame.request_id}","method":"${frame.method}","error":{"code":"unavailable","retryable":true,"correlation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3125"}}\n`)
}

function fixture(handleRequest = async (frame: HostControlFrame) => responseFor(frame)) {
  const sent: WindowsHostWorkerMessage[] = []
  const closes: string[] = []
  const signals: AbortSignal[] = []
  const bridge = new WindowsHostWorkerBridge({
    generation: 7,
    requestStopFlag: () => undefined,
    send: (message) => { sent.push(message) },
    openSession: (id, signal) => {
      signals.push(signal)
      return {
        handleRequest,
        close: () => { closes.push(id) },
      }
    },
  })
  return { bridge, sent, closes, signals }
}

function ready(): WindowsHostWorkerMessage {
  return { version: 1, type: 'ready', generation: 7, threadHandle: 91n }
}

function connected(id = connectionId): WindowsHostWorkerMessage {
  return { version: 1, type: 'connected', generation: 7, connectionId: id }
}

function requestMessage(sequence = 1, frame = request): WindowsHostWorkerMessage {
  return {
    version: 1,
    type: 'request',
    generation: 7,
    connectionId,
    sequence,
    frame: encodeHostControlFrame(frame),
  }
}

describe('Windows Host Worker bridge', () => {
  it('strictly decodes every generation-bound Worker message shape', () => {
    const valid = [
      ready(),
      connected(),
      requestMessage(),
      { ...requestMessage(), type: 'response' },
      { version: 1, type: 'disconnected', generation: 7, connectionId, requestsHandled: 0 },
      { version: 1, type: 'stop', generation: 7 },
      { version: 1, type: 'stopped', generation: 7 },
    ]
    for (const message of valid) expect(decodeWindowsHostWorkerMessage(message, 7)).toEqual(message)

    for (const invalid of [
      null,
      [],
      {},
      { ...ready(), version: 2 },
      { ...ready(), threadHandle: '91' },
      { ...ready(), threadHandle: 91n, unexpected: true },
      { version: 1, type: 'ready', generation: 7, unexpected: 91n },
      { ...connected(), connectionId: 42 },
      { ...requestMessage(), connectionId: 'not-a-uuid' },
      { ...requestMessage(), sequence: -1 },
      { ...requestMessage(), sequence: 0 },
      { ...requestMessage(), frame: 42 },
      { ...requestMessage(), frame: 'not-json\n' },
      { ...requestMessage(), frame: encodeHostControlFrame(request).replace(
        '{"version":1,"type":"request",',
        '{"type":"request","version":1,',
      ) },
      { version: 1, type: 'disconnected', generation: 7, connectionId, requestsHandled: -1 },
      { version: 1, type: 'unknown', generation: 7 },
    ]) expect(() => decodeWindowsHostWorkerMessage(invalid, 7))
      .toThrow(WindowsHostWorkerProtocolError)
  })

  it('rejects an invalid bridge generation before opening state', () => {
    expect(() => new WindowsHostWorkerBridge({
      generation: 0,
      requestStopFlag: () => undefined,
      send: () => undefined,
      openSession: () => { throw new Error('unused') },
    })).toThrow('invalid Windows Host Worker generation')
  })

  it('requires one generation-bound ready handshake with a valid cancellation handle', async () => {
    for (const invalid of [
      connected(),
      { ...ready(), generation: 8 },
      { ...ready(), threadHandle: 0n },
      { ...ready(), threadHandle: 0x1_0000_0000_0000_0000n },
      { ...ready(), extra: true },
    ]) {
      const { bridge } = fixture()
      await expect(bridge.receive(invalid)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    }

    const { bridge } = fixture()
    await expect(bridge.receive(ready())).resolves.toBeUndefined()
    expect(bridge.cancellationThreadHandle).toBe(91n)
    await expect(bridge.receive(ready())).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('opens one shared Host session and returns only a correlated canonical response', async () => {
    const handler = vi.fn(async (frame: HostControlFrame) => responseFor(frame))
    const { bridge, sent } = fixture(handler)
    await bridge.receive(ready())
    await bridge.receive(connected())
    await bridge.receive(requestMessage())

    expect(handler).toHaveBeenCalledOnce()
    expect(sent).toEqual([{
      version: 1,
      type: 'response',
      generation: 7,
      connectionId,
      sequence: 1,
      frame: encodeHostControlFrame(responseFor(request)),
    }])
  })

  it('rejects wrong connections, non-monotonic sequences, and non-request frames', async () => {
    const { bridge } = fixture()
    await bridge.receive(ready())
    await bridge.receive(connected())
    await expect(bridge.receive({ ...requestMessage(), connectionId: `${connectionId.slice(0, -1)}9` }))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(bridge.receive(requestMessage(2))).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(bridge.receive(requestMessage(1, responseFor(request))))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('rejects a pipelined request while the prior request is still in flight', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const { bridge } = fixture(async (frame) => { await blocked; return responseFor(frame) })
    await bridge.receive(ready())
    await bridge.receive(connected())
    const firstReceive = bridge.receive(requestMessage())
    await Promise.resolve()
    await expect(bridge.receive(requestMessage(2))).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    release?.()
    await firstReceive
  })

  it('aborts and closes a disconnected session and suppresses its late response', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const { bridge, sent, closes, signals } = fixture(async (frame) => {
      await blocked
      return responseFor(frame)
    })
    await bridge.receive(ready())
    await bridge.receive(connected())
    const pending = bridge.receive(requestMessage())
    await Promise.resolve()
    await bridge.receive({
      version: 1,
      type: 'disconnected',
      generation: 7,
      connectionId,
      requestsHandled: 0,
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(closes).toEqual([connectionId])
    release?.()
    await pending
    expect(sent).toEqual([])
  })

  it('requires an exact completed-response count before a clean disconnect', async () => {
    const { bridge, closes } = fixture()
    await bridge.receive(ready())
    await bridge.receive(connected())
    await bridge.receive(requestMessage())
    await expect(bridge.receive({
      version: 1,
      type: 'disconnected',
      generation: 7,
      connectionId,
      requestsHandled: 0,
    })).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(closes).toEqual([connectionId])
    expect(bridge.state).toBe('failed')
  })

  it('poisons the generation after malformed startup instead of accepting a later ready', async () => {
    const { bridge } = fixture()
    await expect(bridge.receive(connected())).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
    await expect(bridge.receive(ready())).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('closes an active session when the Worker reports stopped', async () => {
    const { bridge, closes, signals } = fixture()
    await bridge.receive(ready())
    await bridge.receive(connected())
    await bridge.receive({ version: 1, type: 'stopped', generation: 7 })
    expect(signals[0]?.aborted).toBe(true)
    expect(closes).toEqual([connectionId])
    expect(bridge.state).toBe('stopped')
  })

  it('aborts the shared session and sends stop before native cancellation retries', async () => {
    const { bridge, sent, closes, signals } = fixture()
    await bridge.receive(ready())
    await bridge.receive(connected())
    await bridge.requestStop()
    expect(signals[0]?.aborted).toBe(true)
    expect(closes).toEqual([connectionId])
    expect(sent).toEqual([{ version: 1, type: 'stop', generation: 7 }])
    expect(bridge.state).toBe('stopping')
    await expect(bridge.receive(connected())).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('rejects repeated stop requests after stopping or stopped', async () => {
    const stopping = fixture()
    await stopping.bridge.receive(ready())
    await stopping.bridge.requestStop()
    await expect(stopping.bridge.requestStop()).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const stopped = fixture()
    await stopped.bridge.receive({ version: 1, type: 'stopped', generation: 7 })
    await expect(stopped.bridge.requestStop()).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('still publishes stop and observes cleanup after a protocol failure', async () => {
    const calls: string[] = []
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => { calls.push('flag') },
      send: () => { calls.push('stop') },
      openSession: () => { throw new Error('unused') },
    })
    await expect(bridge.receive({ type: 'malformed' })).rejects
      .toBeInstanceOf(WindowsHostWorkerProtocolError)
    await bridge.requestStop()
    expect(calls).toEqual(['flag', 'stop'])
  })

  it('preserves a stop-flag failure while aborting and closing an active session', async () => {
    const unopened = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => { throw new Error('flag failed') },
      send: () => undefined,
      openSession: () => { throw new Error('unused') },
    })
    await expect(unopened.requestStop()).rejects.toThrow('flag failed')

    for (const closeFails of [false, true]) {
      let signal: AbortSignal | undefined
      const closed = vi.fn(() => {
        if (closeFails) throw new Error('close failed')
      })
      const bridge = new WindowsHostWorkerBridge({
        generation: 7,
        requestStopFlag: () => { throw new Error('flag failed') },
        send: () => undefined,
        openSession: (_id, activeSignal) => {
          signal = activeSignal
          return { handleRequest: () => { throw new Error('unused') }, close: closed }
        },
      })
      await bridge.receive(ready())
      await bridge.receive(connected())
      await expect(bridge.requestStop()).rejects.toThrow('flag failed')
      expect(signal?.aborted).toBe(true)
      expect(closed).toHaveBeenCalledOnce()
    }
  })

  it('maps synchronous delivery and asynchronous cleanup failures without hiding either boundary', async () => {
    const delivery = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: () => { throw 'send failed' },
      openSession: () => { throw new Error('unused') },
    })
    await expect(delivery.requestStop()).rejects.toThrow('Windows Host Worker operation failed')

    const cleanup = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: () => undefined,
      openSession: () => ({
        handleRequest: () => { throw new Error('unused') },
        close: async () => { throw 'close failed' },
      }),
    })
    await cleanup.receive(ready())
    await cleanup.receive(connected())
    await expect(cleanup.requestStop()).rejects.toThrow('Windows Host Worker operation failed')
  })

  it('does not wait for session cleanup before waking a Worker response waiter', async () => {
    let releaseClose: (() => void) | undefined
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    const sent: WindowsHostWorkerMessage[] = []
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: (message) => { sent.push(message) },
      openSession: () => ({
        handleRequest: async frame => responseFor(frame),
        close: async () => { await closing },
      }),
    })
    await bridge.receive(ready())
    await bridge.receive(connected())
    const stopping = bridge.requestStop()
    await Promise.resolve()
    expect(sent).toEqual([{ version: 1, type: 'stop', generation: 7 }])
    releaseClose?.()
    await stopping
  })

  it('publishes the persistent stop flag before aborting or messaging the Worker', async () => {
    const calls: string[] = []
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => { calls.push('flag') },
      send: () => { calls.push('message') },
      openSession: (_connectionId, signal) => {
        signal.addEventListener('abort', () => { calls.push('abort') })
        return {
          handleRequest: async frame => responseFor(frame),
          close: () => { calls.push('close') },
        }
      },
    })
    await bridge.receive(ready())
    await bridge.receive(connected())
    await bridge.requestStop()
    expect(calls).toEqual(['flag', 'message', 'abort', 'close'])
  })

  it('reports a protocol failure without waiting for blocked session cleanup', async () => {
    let releaseClose: (() => void) | undefined
    const closing = new Promise<void>((resolve) => { releaseClose = resolve })
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: () => undefined,
      openSession: () => ({
        handleRequest: async frame => responseFor(frame),
        close: async () => { await closing },
      }),
    })
    await bridge.receive(ready())
    await bridge.receive(connected())
    await expect(bridge.receive({ type: 'request' }))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
    let cleanupFinished = false
    void bridge.sessionCleanup.then(() => { cleanupFinished = true })
    await Promise.resolve()
    expect(cleanupFinished).toBe(false)
    releaseClose?.()
    await bridge.sessionCleanup
  })

  it('rejects duplicate stopped and connected transitions plus unsupported ready-state messages', async () => {
    const stopped = fixture()
    await stopped.bridge.receive({ version: 1, type: 'stopped', generation: 7 })
    await expect(stopped.bridge.receive({ version: 1, type: 'stopped', generation: 7 }))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const duplicate = fixture()
    await duplicate.bridge.receive(ready())
    await duplicate.bridge.receive(connected())
    await expect(duplicate.bridge.receive(connected()))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const unsupported = fixture()
    await unsupported.bridge.receive(ready())
    await expect(unsupported.bridge.receive({
      ...requestMessage(),
      type: 'response',
    })).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('rejects a response frame as a Worker request and uncorrelated session output', async () => {
    const wrongFrame = fixture()
    await wrongFrame.bridge.receive(ready())
    await wrongFrame.bridge.receive(connected())
    await expect(wrongFrame.bridge.receive(requestMessage(1, responseFor(request))))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const wrongResponse = fixture(async frame => ({
      ...responseFor(frame),
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3199',
    } as HostControlFrame))
    await wrongResponse.bridge.receive(ready())
    await wrongResponse.bridge.receive(connected())
    await expect(wrongResponse.bridge.receive(requestMessage()))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('retains a synchronous session cleanup failure for the supervisor', async () => {
    const bridge = new WindowsHostWorkerBridge({
      generation: 7,
      requestStopFlag: () => undefined,
      send: () => undefined,
      openSession: () => ({
        handleRequest: () => { throw new Error('unused') },
        close: () => { throw 'close failed' },
      }),
    })
    await bridge.receive(ready())
    await bridge.receive(connected())
    await expect(bridge.receive({ type: 'malformed' })).rejects
      .toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(bridge.sessionCleanup).rejects.toThrow('Windows Host Worker operation failed')
  })
})
