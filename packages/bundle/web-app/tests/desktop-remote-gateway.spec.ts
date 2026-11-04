import { expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { bindDesktopRemoteGateway } from '../src/desktop-remote-gateway.ts'

it('binds every private carrier request to its authenticated peer', async () => {
  const peer = {} as PeerScope
  const foreign = {} as PeerScope
  const invoke = vi.fn(async () => 'result')
  const stream = vi.fn(async () => (async function* () { yield 'output' })())
  const open = vi.fn(async () => (async function* () { yield 'frame' })())
  const respondRemoteEvent = vi.fn()
  const gateway = bindDesktopRemoteGateway(Object.assign({} as TypertGateway, {
    invoke, stream, wireStream: { open }, respondRemoteEvent,
  }), peer)
  const signal = new AbortController().signal
  const request = { namespace: 'session', method: 'list', args: {}, signal }
  expect(await gateway.invoke(request)).toBe('result')
  expect(invoke).toHaveBeenCalledWith({ ...request, peer })
  const values: unknown[] = []
  for await (const value of await gateway.stream(request)) values.push(value)
  expect(values).toEqual(['output'])
  expect(stream).toHaveBeenCalledWith({ ...request, peer })
  const uplink = (async function* () { yield 'input' })()
  const frames: unknown[] = []
  for await (const frame of await gateway.wireStream.open('terminal/attach', {}, uplink, foreign, signal)) frames.push(frame)
  expect(frames).toEqual(['frame'])
  expect(open).toHaveBeenCalledWith('terminal/attach', {}, uplink, peer, signal)
  const response = { id: 'event' } as never
  gateway.respondRemoteEvent(response)
  expect(respondRemoteEvent).toHaveBeenCalledWith(response)
})
