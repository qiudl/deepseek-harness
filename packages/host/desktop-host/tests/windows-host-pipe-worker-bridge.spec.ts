import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { describe, expect, it } from 'vitest'
import {
  WindowsHostWorkerProtocolError,
  type WindowsHostWorkerMessage,
} from '../src/windows-host-worker-bridge.ts'
import { WindowsHostPipeWorkerBridge } from '../src/windows-host-pipe-worker-bridge.ts'

const connectionId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const secondConnectionId = '118f0f4c-87f8-7e2d-a2f8-7b93d34e3123'
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

function responseMessage(id: string, sequence: number, frame: HostControlFrame = response): WindowsHostWorkerMessage {
  return {
    version: 1,
    type: 'response',
    generation: 7,
    connectionId: id,
    sequence,
    frame: encodeHostControlFrame(frame),
  }
}

describe('Windows Host pipe Worker bridge', () => {
  it('rejects an invalid generation before any Worker message is sent', () => {
    expect(() => new WindowsHostPipeWorkerBridge({
      generation: 0,
      stopRequested: () => false,
      send: () => undefined,
    })).toThrow('invalid Windows Host Worker generation')
  })

  it('announces the first slot handle as ready and later handles as thread handles', async () => {
    const early = fixture()
    await expect(early.bridge.openConnection(connectionId))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const earlyHandle = fixture()
    await expect(earlyHandle.bridge.announceThreadHandle(92n))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const { bridge, sent } = fixture()
    await bridge.announceReady(91n)
    await bridge.announceThreadHandle(92n)
    expect(sent).toEqual([
      { version: 1, type: 'ready', generation: 7, threadHandle: 91n },
      { version: 1, type: 'thread_handle', generation: 7, threadHandle: 92n },
    ])
    await expect(bridge.announceThreadHandle(92n)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    const invalid = fixture()
    await invalid.bridge.announceReady(91n)
    await expect(invalid.bridge.announceThreadHandle(0n))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('serves two concurrent connections with independent sequences and waiters', async () => {
    const { bridge, sent } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    expect(sent.map(message => message.type)).toEqual(['ready', 'connected', 'connected'])
    expect(bridge.state).toBe('connected')

    const first = bridge.handleRequest(request, connectionId)
    const second = bridge.handleRequest(request, secondConnectionId)
    expect(sent.at(-2)).toEqual({
      version: 1, type: 'request', generation: 7,
      connectionId, sequence: 1, frame: encodeHostControlFrame(request),
    })
    expect(sent.at(-1)).toEqual({
      version: 1, type: 'request', generation: 7,
      connectionId: secondConnectionId, sequence: 1, frame: encodeHostControlFrame(request),
    })

    // The second connection's response must not resolve the first connection's waiter.
    bridge.receive(responseMessage(secondConnectionId, 1))
    await expect(second).resolves.toEqual(response)
    bridge.receive(responseMessage(connectionId, 1))
    await expect(first).resolves.toEqual(response)

    const next = bridge.handleRequest(request, connectionId)
    bridge.receive(responseMessage(connectionId, 2))
    await expect(next).resolves.toEqual(response)
  })

  it('rejects pipelining per connection and responses for unknown connections', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    const pending = bridge.handleRequest(request, connectionId)
    await expect(bridge.handleRequest(request, connectionId))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')

    const unknown = fixture()
    await unknown.bridge.announceReady(91n)
    await unknown.bridge.openConnection(connectionId)
    expect(() => {
      unknown.bridge.receive(responseMessage(secondConnectionId, 1))
    }).toThrow(WindowsHostWorkerProtocolError)
    expect(unknown.bridge.state).toBe('failed')
  })

  it('closes only the matching connection and keeps serving the other', async () => {
    const { bridge, sent } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    const pending = bridge.handleRequest(request, connectionId)
    bridge.receive(responseMessage(connectionId, 1))
    await pending
    await bridge.closeConnection(connectionId, 1)
    expect(sent.at(-1)).toEqual({
      version: 1, type: 'disconnected', generation: 7, connectionId, requestsHandled: 1,
    })
    expect(bridge.state).toBe('connected')

    const surviving = bridge.handleRequest(request, secondConnectionId)
    bridge.receive(responseMessage(secondConnectionId, 1))
    await surviving
    await bridge.closeConnection(secondConnectionId, 1)
    expect(bridge.state).toBe('ready')
  })

  it('rejects invalid close counts and closing a connection with an active waiter', async () => {
    for (const requestsHandled of [-1, 1, Number.NaN]) {
      const { bridge } = fixture()
      await bridge.announceReady(91n)
      await bridge.openConnection(connectionId)
      await expect(bridge.closeConnection(connectionId, requestsHandled))
        .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    }

    const active = fixture()
    await active.bridge.announceReady(91n)
    await active.bridge.openConnection(connectionId)
    const pending = active.bridge.handleRequest(request, connectionId)
    await expect(active.bridge.closeConnection(connectionId, 0))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('settles every in-flight waiter with a stop sentinel after the shared flag is set', async () => {
    let stopped = false
    const { bridge } = fixture(() => stopped)
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    const first = bridge.handleRequest(request, connectionId)
    const second = bridge.handleRequest(request, secondConnectionId)
    stopped = true
    bridge.receive({ version: 1, type: 'stop', generation: 7 })
    for (const pending of [first, second]) {
      await expect(pending).resolves.toMatchObject({
        type: 'error',
        request_id: request.request_id,
        method: request.method,
      })
    }
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

  it('rejects stopped announcements while any connection still has a waiter', async () => {
    let stopped = false
    const { bridge } = fixture(() => stopped)
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const pending = bridge.handleRequest(request, connectionId)
    stopped = true
    await expect(bridge.announceStopped()).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('poisons every connection waiter when a parent message send fails', async () => {
    let sends = 0
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: () => {
        sends += 1
        if (sends === 4) throw 'message port closed'
      },
    })
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    const first = bridge.handleRequest(request, connectionId)
    const second = bridge.handleRequest(request, secondConnectionId)
    await expect(first).rejects.toBe('message port closed')
    await expect(second).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('poisons all connections on malformed or uncorrelated parent input', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await bridge.openConnection(secondConnectionId)
    const first = bridge.handleRequest(request, connectionId)
    const second = bridge.handleRequest(request, secondConnectionId)
    expect(() => { bridge.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
    await expect(first).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(second).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('rejects parent messages that are not responses while connected', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    expect(() => {
      bridge.receive({ version: 1, type: 'ready', generation: 7, threadHandle: 92n })
    }).toThrow(WindowsHostWorkerProtocolError)
  })

  it('announces a slot thread handle even after the shared stop began', async () => {
    let stopped = false
    const { bridge, sent } = fixture(() => stopped)
    await bridge.announceReady(91n)
    stopped = true
    bridge.receive({ version: 1, type: 'stop', generation: 7 })
    await bridge.announceThreadHandle(93n)
    expect(sent.at(-1)).toEqual({
      version: 1, type: 'thread_handle', generation: 7, threadHandle: 93n,
    })
  })

  it('rejects stopped announcements without a visible stop or after terminal state', async () => {
    const running = fixture()
    await expect(running.bridge.announceStopped()).rejects
      .toBeInstanceOf(WindowsHostWorkerProtocolError)

    const stopped = fixture(() => true)
    await stopped.bridge.announceStopped()
    await expect(stopped.bridge.announceStopped()).rejects
      .toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('fails a handle announcement when a concurrent poison lands during its send', async () => {
    let release!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: () => {
        calls += 1
        return calls === 2 ? sending : undefined
      },
    })
    await bridge.announceReady(91n)
    const announcing = bridge.announceThreadHandle(92n)
    expect(() => { bridge.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
    release()
    await expect(announcing).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('fails a connection close when a stop lands during its send', async () => {
    let stopped = false
    let release!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    const sent: WindowsHostWorkerMessage[] = []
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => stopped,
      send: (message) => {
        sent.push(message)
        if (message.type === 'disconnected') return sending
        return undefined
      },
    })
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const closing = bridge.closeConnection(connectionId, 0)
    stopped = true
    bridge.receive({ version: 1, type: 'stop', generation: 7 })
    release()
    await expect(closing).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })

  it('rejects a repeated ready handshake and one poisoned mid-send', async () => {
    const ready = fixture()
    await ready.bridge.announceReady(91n)
    await expect(ready.bridge.announceReady(92n)).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    let release!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    const poisoned = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: () => sending,
    })
    const announcing = poisoned.announceReady(91n)
    expect(() => { poisoned.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
    release()
    await expect(announcing).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(poisoned.state).toBe('failed')
  })

  it('rejects a duplicate connection and one poisoned during its opening send', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await expect(bridge.openConnection(connectionId))
      .rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)

    let release!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const poisoned = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: () => {
        calls += 1
        return calls === 2 ? sending : undefined
      },
    })
    await poisoned.announceReady(91n)
    const opening = poisoned.openConnection(connectionId)
    expect(() => { poisoned.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
    release()
    await expect(opening).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(poisoned.state).toBe('failed')
  })

  it('rejects an uncorrelated parent response and poisons every waiter', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    const pending = bridge.handleRequest(request, connectionId)
    expect(() => {
      bridge.receive(responseMessage(connectionId, 1, {
        ...response,
        request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3199',
      } as typeof response))
    }).toThrow(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('fails a stopped announcement poisoned during its send', async () => {
    let release!: () => void
    const sending = new Promise<void>((resolve) => { release = resolve })
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => true,
      send: () => sending,
    })
    const announcing = bridge.announceStopped()
    expect(() => { bridge.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
    release()
    await expect(announcing).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    expect(bridge.state).toBe('failed')
  })
})
