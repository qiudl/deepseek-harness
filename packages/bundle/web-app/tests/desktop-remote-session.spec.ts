import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { HOST_CONTROL_MAX_FRAME_BYTES } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopRemoteSessionExecutor, handleDesktopRemoteSessionRequest } from '../src/desktop-remote-session.ts'

describe('Desktop remote Session bridge', () => {
  it('uses the Session list gateway parameter name', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteSessionExecutor({ invoke } as unknown as TypertGateway)
    const signal = new AbortController().signal
    await expect(executor.execute({
      operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
    }, signal)).resolves.toEqual({ items: [] })
    expect(invoke).toHaveBeenCalledWith({
      namespace: 'session', method: 'list', args: { _request: {} }, signal,
    })
  })

  it('maps closed commands onto the existing Session Remote service', async () => {
    const invoke = vi.fn(async () => ({ accepted: true }))
    const gateway = { invoke } as unknown as TypertGateway
    const executor = new DesktopRemoteSessionExecutor(gateway)
    const signal = new AbortController().signal
    await expect(executor.execute({
      operation: 'session.prompt', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }],
      client_time_zone: 'Asia/Shanghai',
    }, signal)).resolves.toEqual({ accepted: true })
    expect(invoke).toHaveBeenCalledWith({
      namespace: 'session', method: 'prompt', signal,
      args: { request: {
        requestId: '123e4567-e89b-42d3-a456-426614174000', sessionId: 'session-1', mode: 'queue',
        content: [{ type: 'text', text: 'hello' }], clientTimeZone: 'Asia/Shanghai',
      } },
    })
  })

  it('returns the bounded opening history snapshot and closes the follow stream', async () => {
    const returned = vi.fn(async () => ({ done: true, value: undefined }))
    const iterator = {
      next: vi.fn(async () => ({ done: false, value: { type: 'snapshot', records: [{ type: 'event', event: {
        type: 'user/message', seq: 0, time: 1, data: {}, surfaceOp: 'append',
      } }] } })),
      return: returned,
    }
    const gateway = { stream: vi.fn(async () => ({ [Symbol.asyncIterator]: () => iterator })) } as unknown as TypertGateway
    const executor = new DesktopRemoteSessionExecutor(gateway)
    await expect(executor.execute({
      operation: 'session.history', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', max_events: 100,
    }, new AbortController().signal)).resolves.toMatchObject({ events: [{ type: 'event' }] })
    expect(returned).toHaveBeenCalledOnce()
  })

  it('keeps recent history within the Host control frame limit', async () => {
    const older = { type: 'event', event: { type: 'user/message', seq: 1, time: 1,
      data: { content: [{ type: 'text', text: 'x'.repeat(70_000) }] } } }
    const recent = { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2,
      data: { message: { content: [{ type: 'text', text: 'recent reply' }] } } } }
    const gateway = { stream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot', records: [older, recent] }
      },
    })) } as unknown as TypertGateway
    const executor = new DesktopRemoteSessionExecutor(gateway)
    const result = await executor.execute({
      operation: 'session.history', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', max_events: 100,
    }, new AbortController().signal)
    expect((result as { events: typeof recent[] }).events.map(item => item.event.seq)).toEqual([2])
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(HOST_CONTROL_MAX_FRAME_BYTES)
  })

  it('requires the private bearer token even when a browser cookie is present', async () => {
    const token = 'A'.repeat(43)
    const execute = vi.fn(async () => ({ items: [] }))
    const server = createServer((req, res) => {
      void handleDesktopRemoteSessionRequest(req, res, token, execute)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    try {
      await expect(fetch(origin, { method: 'POST', headers: { cookie: 'dsh-auth=fake' }, body: '{}' })
        .then(response => response.status)).resolves.toBe(403)
      const response = await fetch(origin, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ operation: 'session.list', command_id: '123e4567-e89b-42d3-a456-426614174000' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ value: { items: [] } })
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('binds an approval response to its projected operation digest', async () => {
    async function* events() {
      yield { type: 'ready', clientId: 'client-1', host: { home: '/hidden' } }
      yield { type: 'waterfall', event: 'approval/request', eventId: 'event-1', agentId: 'session-1',
        request: { toolName: 'bash', reason: 'run command' } }
    }
    const respondRemoteEvent = vi.fn()
    const gateway = {
      wireStream: { open: vi.fn(async () => events()) }, respondRemoteEvent,
    } as unknown as TypertGateway
    const executor = new DesktopRemoteSessionExecutor(gateway)
    const commandId = '123e4567-e89b-42d3-a456-426614174000' as never
    const value = await executor.execute({ operation: 'approval.poll', command_id: commandId, wait_ms: 100 },
      new AbortController().signal) as Record<string, unknown>
    const frame = (value.frames as Array<Record<string, unknown>>)[0]!
    const payload = frame.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      type: 'approval/requested', sessionId: 'session-1', toolName: 'bash', reason: 'run command',
    })
    await expect(executor.execute({
      operation: 'approval.respond', command_id: commandId, session_id: 'session-1',
      approval_id: payload.approvalId as string, outcome: 'allowed-once',
    }, new AbortController().signal)).rejects.toThrow('digest required')
    await expect(executor.execute({
      operation: 'approval.respond', command_id: commandId, session_id: 'session-1',
      approval_id: payload.approvalId as string, outcome: 'allowed-once',
      operation_digest: payload.operationDigest as never,
    }, new AbortController().signal)).resolves.toEqual({ accepted: true })
    expect(respondRemoteEvent).toHaveBeenCalledWith({
      clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', value: 'allowed-once' },
    })
  })
})
