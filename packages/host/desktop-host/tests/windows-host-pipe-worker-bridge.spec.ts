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
const request = decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","params":{"challenge":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3124","supported_versions":[1]}}\n')
const response = decodeHostControlFrame('{"version":1,"type":"error","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","error":{"code":"unavailable","retryable":true,"correlation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3125"}}\n')
const result = decodeHostControlFrame('{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3123","method":"host.inspect","result":{"protocol_version":1,"host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3121","installation_public_key":"EjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJCrze8","runtime_generation":7,"schema_generation":3,"process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","capabilities":["environment.attach","host.inspect","profile.open","profile.status","session.command"],"challenge_signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","executable_signature_digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}\n')

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
  it('rejects an invalid generation before any Worker message is sent', () => {
    expect(() => new WindowsHostPipeWorkerBridge({
      generation: 0,
      stopRequested: () => false,
      send: () => undefined,
    })).toThrow('invalid Windows Host Worker generation')
  })

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

    const next = bridge.handleRequest(request)
    bridge.receive({
      version: 1,
      type: 'response',
      generation: 7,
      connectionId,
      sequence: 2,
      frame: encodeHostControlFrame(result),
    })
    await expect(next).resolves.toEqual(result)
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

    for (const frame of [
      request,
      { ...response, request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3199' } as HostControlFrame,
      { ...response, method: 'host.ping' } as HostControlFrame,
    ]) {
      const uncorrelated = fixture()
      await uncorrelated.bridge.announceReady(91n)
      await uncorrelated.bridge.openConnection(connectionId)
      const waiting = uncorrelated.bridge.handleRequest(request)
      expect(() => {
        uncorrelated.bridge.receive({
          version: 1,
          type: 'response',
          generation: 7,
          connectionId,
          sequence: 1,
          frame: encodeHostControlFrame(frame),
        })
      }).toThrow(WindowsHostWorkerProtocolError)
      await expect(waiting).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    }
  })

  it('rejects parent messages that are not responses while connected', async () => {
    const { bridge } = fixture()
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    expect(() => { bridge.receive(readyMessage()) }).toThrow(WindowsHostWorkerProtocolError)
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

  it('rejects invalid close counts and closing with an active waiter', async () => {
    for (const requestsHandled of [-1, 1, Number.NaN]) {
      const { bridge } = fixture()
      await bridge.announceReady(91n)
      await bridge.openConnection(connectionId)
      await expect(bridge.closeConnection(requestsHandled)).rejects
        .toBeInstanceOf(WindowsHostWorkerProtocolError)
    }

    const active = fixture()
    await active.bridge.announceReady(91n)
    await active.bridge.openConnection(connectionId)
    const pending = active.bridge.handleRequest(request)
    await expect(active.bridge.closeConnection(0)).rejects
      .toBeInstanceOf(WindowsHostWorkerProtocolError)
    await expect(pending).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
  })

  it('poisons a request waiter when sending the request fails with a non-Error reason', async () => {
    let sends = 0
    const bridge = new WindowsHostPipeWorkerBridge({
      generation: 7,
      stopRequested: () => false,
      send: () => {
        sends += 1
        if (sends === 3) throw 'message port closed'
      },
    })
    await bridge.announceReady(91n)
    await bridge.openConnection(connectionId)
    await expect(bridge.handleRequest(request)).rejects.toBe('message port closed')
    expect(bridge.state).toBe('failed')
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

  it('does not complete ready, disconnect, or stopped after a concurrent poison', async () => {
    for (const operation of ['ready', 'disconnect', 'stopped'] as const) {
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      let blockNext = false
      const bridge = new WindowsHostPipeWorkerBridge({
        generation: 7,
        stopRequested: () => true,
        send: () => blockNext ? blocked : undefined,
      })
      if (operation !== 'ready') await bridge.announceReady(91n)
      if (operation === 'disconnect') await bridge.openConnection(connectionId)
      blockNext = true
      const running = operation === 'ready'
        ? bridge.announceReady(91n)
        : operation === 'disconnect'
          ? bridge.closeConnection(0)
          : bridge.announceStopped()
      await Promise.resolve()
      expect(() => { bridge.receive({ type: 'malformed' }) }).toThrow(WindowsHostWorkerProtocolError)
      release()
      await expect(running).rejects.toBeInstanceOf(WindowsHostWorkerProtocolError)
    }
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
})

function readyMessage(): WindowsHostWorkerMessage {
  return { version: 1, type: 'ready', generation: 7, threadHandle: 91n }
}
