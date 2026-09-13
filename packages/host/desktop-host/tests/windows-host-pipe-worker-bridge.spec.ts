import {
  decodeHostControlFrame,
  encodeHostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it } from 'vitest'
import {
  WindowsHostWorkerProtocolError,
  type WindowsHostWorkerMessage,
} from '../src/windows-host-worker-bridge.ts'
import { WindowsHostPipeWorkerBridge } from '../src/windows-host-pipe-worker-bridge.ts'

const connectionId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const request = decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3124","supported_versions":[1]}}\n')
const response = decodeHostControlFrame('{"version":1,"type":"error","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","error":{"code":"unavailable","retryable":true,"correlation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3125"}}\n')

function fixture(stopRequested = () => false) {
  const sent: WindowsHostWorkerMessage[] = []
  const bridge = new WindowsHostPipeWorkerBridge({
    generation: 7,
    stopRequested,
    send: (message) => { sent.push(message) },
  })
  return { bridge, sent }
}

describe('Windows Host pipe Worker bridge', () => {
  it('announces a valid cancellation handle before opening a connection', async () => {
    const { bridge, sent } = fixture()
    await expect(bridge.openConnection(connectionId)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const valid = fixture()
    await valid.bridge.announceReady(91n)
    await valid.bridge.openConnection(connectionId)
    expect(valid.sent).toEqual([
      { version: 1, type: 'ready', generation: 7, threadHandle: 91n },
      { version: 1, type: 'connected', generation: 7, connectionId },
    ])
    expect(sent).toEqual([])
  })

  it('waits for the exactly correlated parent response to one sequential request', async () => {
    const { bridge, sent } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const pending = bridge.handleRequest(request)
    expect(sent.at(-1)).toEqual({
      version: 1,
      type: 'request',
      generation: 7,
      connectionId,
      sequence: 1,
      frame: encodeHostControlFrame(request),
    })
    bridge.receive({
      version: 1,
      type: 'response',
      generation: 7,
      connectionId,
      sequence: 1,
      frame: encodeHostControlFrame(response),
    })
    await expect(pending).resolves.toEqual(response)
  })

  it('rejects pipelining and poisons malformed or uncorrelated responses', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const pending = bridge.handleRequest(request)
    await expect(bridge.handleRequest(request)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')

    const wrong = fixture()
    await wrong.bridge.announceReady(91n)
    await wrong.bridge.openConnection(connectionId)
    const wrongPending = wrong.bridge.handleRequest(request)
    expect(() => {
      wrong.bridge.receive({
        version: 1,
        type: 'response',
        generation: 7,
        connectionId,
        sequence: 2,
        frame: encodeHostControlFrame(response),
      })
    }).toThrow(WindowsHostWorkerProtocolError)
    await expect(wrongPending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('unblocks an in-flight handler after the shared stop flag is set', async () => {
    let stopped = false
    const { bridge } = fixture(() => stopped)
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const pending = bridge.handleRequest(request)
    stopped = true
    bridge.receive({ version: 1, type: 'stop', generation: 7 })
    await expect(pending).resolves.toMatchObject({
      type: 'error',
      request_id: request.request_id,
      method: request.method,
    })
    expect(bridge.state).toBe('stopping')
    await bridge.announceStopped()
    expect(bridge.state).toBe('stopped')
  })

  it('rejects a stop message until the persistent shared flag is visible', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    expect(() => { bridge.receive({ version: 1, type: 'stop', generation: 7 }) })
      .toThrow(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('can report stopped before ready when the shared flag won startup', async () => {
    const { bridge, sent } = fixture(() => true)
    await bridge.announceStopped()
    expect(sent).toEqual([{ version: 1, type: 'stopped', generation: 7 }])
    expect(bridge.state).toBe('stopped')
  })

  it('reports a clean connection close only after the response waiter is settled', async () => {
    const { bridge, sent } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.closeConnection(0)
    expect(sent.at(-1)).toEqual({
      version: 1,
      type: 'disconnected',
      generation: 7,
      connectionId,
      requestsHandled: 0,
    })
  })

  it('poisons the Worker bridge when a parent message send fails', async () => {
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: async () => { throw new Error('message port closed') },
    })
    await expect(bridge.announceReady(91n)).rejects.toThrow('message port closed')
    expect(bridge.state).toBe('failed')
    await expect(bridge.announceReady(91n)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('does not overwrite stopping when stop arrives during an asynchronous send', async () => {
    let stopped = false
    let release: (() => void) | undefined
    const sending = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => stopped,
      send: () => {
        calls += 1
        return calls === 2 ? sending : undefined
      },
    })
    await bridge.announceReady(91n)
    const opening = bridge.openConnection(connectionId)
    stopped = true
    bridge.receive({ version: 1, type: 'stop', generation: 7 })
    release?.()
    await expect(opening).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })
})
