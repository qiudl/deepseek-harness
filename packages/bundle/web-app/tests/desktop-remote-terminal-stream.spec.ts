import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopSessionControl } from '../src/desktop-session-control.ts'
import { DesktopRemoteTerminalStreams } from '../src/desktop-remote-terminal-stream.ts'

type Command = Extract<HostRemoteSessionCommand, { operation: 'terminal.apply' }>
function fixture(method: 'follow' | 'retain' = 'follow') {
  let now = 1000
  const control = new DesktopSessionControl(() => now)
  const owner = { kind: 'remote' as const, id: '123e4567-e89b-42d3-a456-426614174001' }
  const state = control.acquire('s', owner, { takeover: false })
  if (!('claim' in state)) throw new Error('claim missing')
  const command: Command = { operation: 'terminal.apply', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    session_id: 's', control: { controller_id: owner.id, generation: state.claim.generation, epoch: state.claim.epoch },
    request: { sessionId: 's', method, args: method === 'follow' ? { agentId: 's', id: 't', attachmentId: 'a' } : { sessionId: 's', id: 't' } } }
  return { command, control, manager: new DesktopRemoteTerminalStreams(control, () => now), advance: (value: number) => { now += value } }
}
const gateway = (stream: TypertGateway['stream']) => Object.assign({} as TypertGateway, { stream,
  wireStream: { open: async (_endpoint: string, payload: { args: Record<string, string> }, _uplink: AsyncIterable<unknown>,
    _peer: undefined, signal: AbortSignal) => stream({ namespace: 'terminal', method: 'attach', args: payload.args, signal } as Parameters<TypertGateway['stream']>[0]) },
})

describe('native terminal stream permits', () => {
  it('acknowledges ordered input even when the native output reader is paused', async () => {
    const f = fixture()
    const received: unknown[] = []
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async (_endpoint, _payload, uplink) => (async function* () {
      yield { type: 'snapshot' }
      for await (const value of uplink) {
        received.push(value)
        if (value && typeof value === 'object' && 'sequence' in value) yield { type: 'ack', sequence: value.sequence }
      }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    expect((await opened.next()).value).toEqual({ type: 'snapshot' })
    const write: Command = { ...f.command, request: { ...f.command.request, method: 'write',
      args: { ...f.command.request.args, data: 'hello' } } }
    const resize: Command = { ...f.command, request: { ...f.command.request, method: 'resize',
      args: { ...f.command.request.args, cols: 80, rows: 24 } } }
    await f.manager.send(write, new AbortController().signal)
    await f.manager.send(resize, new AbortController().signal)
    expect(received).toEqual([{ type: 'write', sequence: 1, data: 'hello' }, { type: 'resize', sequence: 2, cols: 80, rows: 24 }])
    await expect(f.manager.send({ ...write, session_id: 'other' }, new AbortController().signal)).rejects.toThrow()
    await opened.return(undefined)
    await expect(f.manager.send(write, new AbortController().signal)).rejects.toThrow('unavailable')
  })
  it('ends the attachment and fails the pending write when its acknowledgement is lost', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async (_endpoint, _payload, uplink, _peer, signal) => (async function* () {
      yield { type: 'snapshot' }
      for await (const _value of uplink) {
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          else signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true })
        })
      }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    expect((await opened.next()).value).toEqual({ type: 'snapshot' })
    const unusedPermit = f.manager.issue(f.command)
    const command: Command = { ...f.command, request: { ...f.command.request, method: 'write',
      args: { ...f.command.request.args, data: 'once' } } }
    const controller = new AbortController()
    const pending = f.manager.send(command, controller.signal)
    const rejected = expect(pending).rejects.toThrow('result unknown')
    controller.abort()
    await rejected
    await expect(opened.next()).rejects.toThrow('result unknown')
    await expect(f.manager.send(command, new AbortController().signal)).rejects.toThrow('result unknown')
    expect(() => f.manager.issue(f.command)).toThrow('terminal input result unknown')
    await expect(f.manager.open(stream, unusedPermit.grantId, new AbortController().signal).next()).rejects.toThrow('result unknown')
    const readPermit = f.manager.issue({ ...f.command, request: { ...f.command.request, method: 'retain', args: { sessionId: 's', id: 't' } } })
    expect(readPermit.grantId).toBeTypeOf('string')
    f.advance(30_001)
    const acquired = f.control.acquire('s', { kind: 'remote', id: f.command.control.controller_id }, { takeover: false })
    if (!('claim' in acquired)) throw new Error('new claim missing')
    expect(f.manager.issue({ ...f.command, control: { ...f.command.control, generation: acquired.claim.generation, epoch: acquired.claim.epoch } }).grantId).toBeTypeOf('string')
  })
  it('rejects duplicate attachments and invalid input while keeping the original active', async () => {
    const f = fixture()
    const stream = gateway(async request => (async function* () {
      yield { type: 'snapshot' }
      if (!request.signal) throw new Error('missing signal')
      await new Promise<void>((_resolve, reject) => { request.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true }) })
    })())
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next()
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal).next()).rejects.toThrow('already active')
    await expect(f.manager.send({ ...f.command, request: { ...f.command.request, method: 'rename' } }, new AbortController().signal)).rejects.toThrow('method denied')
    await expect(f.manager.send({ ...f.command, request: { ...f.command.request, method: 'write',
      args: { ...f.command.request.args, data: 42 } } }, new AbortController().signal)).rejects.toThrow('invalid terminal input')
    await opened.return(undefined)
  })
  it('reports a terminal refusal without treating it as an acknowledged write', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async (_endpoint, _payload, uplink) => (async function* () {
      yield { type: 'snapshot' }
      for await (const value of uplink) {
        if (value && typeof value === 'object' && 'sequence' in value) yield { type: 'ack', sequence: value.sequence, refusal: 'read-only' }
      }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next()
    const command: Command = { ...f.command, request: { ...f.command.request, method: 'write',
      args: { ...f.command.request.args, data: 'not-written' } } }
    await expect(f.manager.send(command, new AbortController().signal)).rejects.toMatchObject({
      isDSHRemoteError: true, code: 'terminal/control-unavailable', details: { reason: 'read-only' },
    })
    await opened.return(undefined)
  })
  it('fails closed on an invalid acknowledgement rather than claiming input succeeded', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async (_endpoint, _payload, uplink) => (async function* () {
      yield { type: 'snapshot' }
      for await (const value of uplink) {
        if (value && typeof value === 'object' && 'sequence' in value) yield { type: 'ack', sequence: value.sequence, refusal: 'invalid' }
      }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next()
    const command: Command = { ...f.command, request: { ...f.command.request, method: 'write', args: { ...f.command.request.args, data: 'x' } } }
    await expect(f.manager.send(command, new AbortController().signal)).rejects.toThrow('invalid terminal refusal')
    await expect(opened.next()).rejects.toThrow('invalid terminal refusal')
    expect(() => f.manager.issue(f.command)).toThrow('result unknown')
  })
  it('fails closed on an acknowledgement for an unknown input', async () => {
    const f = fixture()
    const barrier = Promise.withResolvers<undefined>()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async () => (async function* () {
      yield { type: 'snapshot' }
      await barrier.promise
      yield { type: 'ack', sequence: 999 }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next(); barrier.resolve(undefined)
    await expect(opened.next()).rejects.toThrow('unexpected terminal acknowledgement')
  })
  it('surfaces a non-Error gateway failure and releases the attachment', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async () => { throw 'wire failed' }
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal).next()).rejects.toThrow('wire failed')
    expect(f.manager.issue(f.command).grantId).toBeTypeOf('string')
  })
  it('rejects input if the duplex uplink has closed', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    stream.wireStream.open = async (_endpoint, _payload, uplink, _peer, signal) => {
      await uplink[Symbol.asyncIterator]().return?.()
      return (async function* () {
        yield { type: 'snapshot' }
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          else signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }, { once: true })
        })
      })()
    }
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next()
    const command: Command = { ...f.command, request: { ...f.command.request, method: 'write', args: { ...f.command.request.args, data: 'x' } } }
    await expect(f.manager.send(command, new AbortController().signal)).rejects.toThrow('attachment closed')
    await expect(opened.next()).rejects.toThrow()
  })
  it('bounds concurrent input and fails all pending requests when the stream is canceled', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    const barrier = Promise.withResolvers<undefined>()
    stream.wireStream.open = async (_endpoint, _payload, uplink, _peer, signal) => (async function* () {
      yield { type: 'snapshot' }
      for await (const _value of uplink) { await barrier.promise; signal.throwIfAborted() }
    })()
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    await opened.next()
    const command: Command = { ...f.command, request: { ...f.command.request, method: 'write', args: { ...f.command.request.args, data: 'x' } } }
    const controller = new AbortController()
    const pending = Array.from({ length: 16 }, () => f.manager.send(command, controller.signal).catch((error: unknown) => error))
    await expect(f.manager.send(command, new AbortController().signal)).rejects.toThrow('queue full')
    controller.abort()
    const results = await Promise.all(pending)
    expect(results.every(error => error instanceof Error && error.message.includes('result unknown'))).toBe(true)
    barrier.resolve(undefined)
    await expect(opened.next()).rejects.toThrow()
  })
  it('ends a stalled attachment instead of buffering unbounded terminal output', async () => {
    const f = fixture()
    const stream = gateway(async () => { throw new Error('follow must use duplex attach') })
    let signal: AbortSignal | undefined
    stream.wireStream.open = async (_endpoint, _payload, _uplink, _peer, lifetime) => {
      signal = lifetime
      return (async function* () {
        yield { type: 'snapshot' }
        for (let index = 0; index < 40; index++) yield { type: 'output', data: String(index) }
      })()
    }
    const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    expect((await opened.next()).value).toEqual({ type: 'snapshot' })
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    await expect(opened.next()).rejects.toThrow('buffer full')
  })
  it('consumes once, preserves exact Gateway args, and refuses changed control before further output', async () => {
    for (const method of ['follow', 'retain'] as const) {
      const f = fixture(method)
      const permit = f.manager.issue(f.command)
      f.command.request.args.id = 'changed-after-issue'
      const stream = vi.fn(async (_request: Parameters<TypertGateway['stream']>[0]) => (async function* () { yield { type: 'ready' }; yield { type: 'output', data: 'secret' } })())
      const opened = f.manager.open(gateway(stream), permit.grantId, new AbortController().signal)
      expect((await opened.next()).value).toEqual({ type: 'ready' })
      expect(stream.mock.calls[0]?.[0]).toMatchObject({ namespace: 'terminal', method: method === 'follow' ? 'attach' : 'retain',
        args: method === 'follow' ? { agentId: 's', id: 't' } : { sessionId: 's', id: 't' } })
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('controlled')
      await expect(opened.next()).rejects.toThrow('control lost')
      await expect(f.manager.open(gateway(stream), permit.grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    }
  })
  it('expires and bounds unused permits, rejecting control loss without starting a terminal', async () => {
    const f = fixture()
    const permits = Array.from({ length: 16 }, () => f.manager.issue(f.command))
    expect(() => f.manager.issue(f.command)).toThrow('full')
    f.advance(10_000)
    const next = f.manager.issue(f.command)
    const never = gateway(async () => (async function* () { throw new Error('must not open') })())
    await expect(f.manager.open(never, permits[0]?.grantId ?? 'missing', new AbortController().signal).next()).rejects.toThrow('unavailable')
    f.advance(20_001)
    await expect(f.manager.open(never, next.grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    expect(() => f.manager.issue(f.command)).toThrow('control lost')
    expect(() => f.manager.issue({ ...f.command, request: { ...f.command.request, method: 'list' } })).toThrow('method denied')
  })
  it('caps active attachments and releases capacity on end or cancellation', async () => {
    const f = fixture()
    const stream = gateway(async () => (async function* () { yield 1; yield 2 })())
    const opened = Array.from({ length: 8 }, (_, index) => f.manager.open(stream, f.manager.issue({ ...f.command,
      request: { ...f.command.request, args: { ...f.command.request.args, attachmentId: `a${index}` } } }).grantId, new AbortController().signal))
    await Promise.all(opened.map(value => value.next()))
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal).next()).rejects.toThrow('unavailable')
    await opened[0]?.return(undefined)
    const accepted = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
    const values: unknown[] = []
    for await (const value of accepted) values.push(value)
    expect(values).toEqual([1, 2])
    await Promise.all(opened.slice(1).map(value => value.return(undefined)))
    const controller = new AbortController(); controller.abort(Error('closed view'))
    await expect(f.manager.open(stream, f.manager.issue(f.command).grantId, controller.signal).next()).rejects.toThrow('closed view')
  })
  it('cancels an idle attachment when control expires, including the pre-first-frame hold', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      let observed: AbortSignal | undefined
      const stream = gateway(async request => (async function* () {
        const signal = request.signal
        if (!signal) throw new Error('missing signal')
        observed = signal
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'))
          }, { once: true })
        })
      })())
      const opened = f.manager.open(stream, f.manager.issue(f.command).grantId, new AbortController().signal)
      const pending = opened.next()
      const rejected = expect(pending).rejects.toThrow('control lost')
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('held_elsewhere')
      f.advance(30_001)
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
      expect(observed?.aborted).toBe(true)
      expect(f.control.takeoverBrowser('s', f.command.control.epoch).outcome).toBe('controlled')
    } finally { vi.useRealTimers() }
  })
})
