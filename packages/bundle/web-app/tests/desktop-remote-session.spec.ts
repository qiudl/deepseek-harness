import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'

import { encodeHostControlFrame, HOST_CONTROL_MAX_FRAME_BYTES,
  type HostRemoteSessionControlProof } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopRemoteSessionExecutor, handleDesktopRemoteSessionRequest } from '../src/desktop-remote-session.ts'
import { DesktopRemoteApprovalEvents } from '../src/desktop-remote-ui-stream.ts'
import { DesktopSessionControl } from '../src/desktop-session-control.ts'

function gatewayFixture(fields: object): TypertGateway {
  return Object.assign({} as TypertGateway, fields)
}

function remoteProof(control: DesktopSessionControl, sessionId: string): HostRemoteSessionControlProof {
  const controller_id = '123e4567-e89b-42d3-a456-426614174001'
  const state = control.acquire(sessionId, { kind: 'remote', id: controller_id }, { takeover: false })
  if (!('claim' in state)) throw new Error('missing remote claim')
  return { controller_id, generation: state.claim.generation, epoch: state.claim.epoch }
}

describe('Desktop remote Session bridge', () => {
  it('answers control operations from the selected Profile authority', async () => {
    const gateway = gatewayFixture({ invoke: vi.fn() })
    const control = new DesktopSessionControl(() => 1_000, 5_000)
    const executor = new DesktopRemoteSessionExecutor(gateway, undefined, control)
    const signal = new AbortController().signal
    const command_id = '123e4567-e89b-42d3-a456-426614174000' as never
    const controller_id = '123e4567-e89b-42d3-a456-426614174001'
    const state = await executor.execute({ operation: 'control.acquire', command_id,
      session_id: 'session-1', controller_id, takeover: false }, signal) as
      { claim: { generation: string; epoch: number } }
    expect(state.claim.epoch).toBe(1)
    expect(await executor.execute({ operation: 'control.status', command_id,
      session_id: 'session-1', controller_id }, signal)).toMatchObject({ outcome: 'controlled' })
    expect(await executor.execute({ operation: 'control.renew', command_id,
      session_id: 'session-1', controller_id, generation: state.claim.generation,
      epoch: state.claim.epoch }, signal)).toMatchObject({ outcome: 'controlled' })
    expect(await executor.execute({ operation: 'control.release', command_id,
      session_id: 'session-1', controller_id, generation: state.claim.generation,
      epoch: state.claim.epoch }, signal)).toEqual({ released: true })
    expect(control.status('session-1', { kind: 'remote', id: controller_id }).outcome).toBe('uncontrolled')
  })

  it('reuses the caller session identity when selecting its workspace', async () => {
    const invoke = vi.fn().mockResolvedValue({ sessionId: 'session-existing' })
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    await executor.execute({ operation: 'session.create', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      workspace_id: 'workspace-1', session_id: 'session-existing' }, signal)
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'create',
      args: { request: { workspaceId: 'workspace-1', sessionId: 'session-existing' } }, signal })
  })

  it('returns the actual native writer refusal without fabricating other failures', async () => {
    const refusal = Object.assign(new Error('writer held'), { isDSHRemoteError: true, code: 'session/writer-held' })
    const invoke = vi.fn().mockRejectedValueOnce(refusal).mockRejectedValueOnce(new Error('unexpected'))
      .mockRejectedValueOnce(refusal)
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const command = { operation: 'session.create' as const, command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      workspace_id: 'workspace-1', session_id: 'session-existing' }
    const signal = new AbortController().signal
    await expect(executor.execute(command, signal)).resolves.toEqual({ sessionCreateFailure: 'session/writer-held' })
    await expect(executor.execute(command, signal)).rejects.toThrow('unexpected')
    await expect(executor.execute({ operation: 'session.create', command_id: command.command_id }, signal)).rejects.toBe(refusal)
  })

  it('reports an uncontrolled Session and fences an observed takeover epoch', async () => {
    const control = new DesktopSessionControl()
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke: vi.fn() }), undefined, control)
    const signal = new AbortController().signal
    const command_id = '123e4567-e89b-42d3-a456-426614174000' as never
    const controller_id = '123e4567-e89b-42d3-a456-426614174001'
    expect(await executor.execute({ operation: 'control.status', command_id,
      session_id: 'session-1', controller_id }, signal)).toEqual({
      outcome: 'uncontrolled', generation: control.generation, epoch: 0,
    })
    const local = control.admitBrowserWrite('session-1')
    const observed = control.status('session-1', { kind: 'remote', id: controller_id })
    if (!('claim' in observed)) throw new Error('missing local claim')
    expect(await executor.execute({ operation: 'control.acquire', command_id,
      session_id: 'session-1', controller_id, takeover: true,
      expected_epoch: observed.claim.epoch }, signal)).toMatchObject({ outcome: 'held_elsewhere' })
    local()
    expect(await executor.execute({ operation: 'control.acquire', command_id,
      session_id: 'session-1', controller_id, takeover: true,
      expected_epoch: observed.claim.epoch }, signal)).toMatchObject({ outcome: 'controlled' })
  })

  it('admits a remote event response only through the selected Profile approval owner', async () => {
    const control = new DesktopSessionControl()
    const proof = remoteProof(control, 'session-1')
    const gateway = gatewayFixture({ invoke: vi.fn() })
    const command = { operation: 'remote.event.respond' as const,
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: proof, client_id: 'client-1', event_id: 'event-1',
      outcome: 'next' as const }
    const signal = new AbortController().signal
    await expect(new DesktopRemoteSessionExecutor(gateway, undefined, control)
      .execute(command, signal)).rejects.toThrow('approval events unavailable')
    const approvals = new DesktopRemoteApprovalEvents()
    const respond = vi.spyOn(approvals, 'respond').mockImplementation(() => {})
    await expect(new DesktopRemoteSessionExecutor(gateway, approvals, control)
      .execute(command, signal)).resolves.toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledWith(gateway, command)
  })
  it('creates a remote Session in the requested Host workspace', async () => {
    const invoke = vi.fn(async () => ({ sessionId: 'session-2' }))
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    await expect(executor.execute({ operation: 'session.create',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      workspace_id: 'workspace-1' }, signal)).resolves.toEqual({ sessionId: 'session-2' })
    expect(invoke).toHaveBeenCalledWith({ namespace: 'session', method: 'create',
      args: { request: { workspaceId: 'workspace-1' } }, signal })
  })

  it('uses the Session list gateway parameter name', async () => {
    const invoke = vi.fn(async () => ({ items: [] }))
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
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
    const gateway = gatewayFixture({ invoke })
    const control = new DesktopSessionControl()
    const executor = new DesktopRemoteSessionExecutor(gateway, undefined, control)
    const proof = remoteProof(control, 'session-1')
    const signal = new AbortController().signal
    await expect(executor.execute({ operation: 'session.prompt',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'unclaimed' }],
    } as never, signal)).rejects.toThrow('claim required')
    expect(invoke).not.toHaveBeenCalled()
    await expect(executor.execute({
      operation: 'session.prompt', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: proof, mode: 'queue', content: [{ type: 'text', text: 'hello' }],
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

  it('does not acknowledge takeover while a remote write is still settling', async () => {
    const pending = Promise.withResolvers<{ accepted: true }>()
    const invoke = vi.fn(() => pending.promise)
    const control = new DesktopSessionControl()
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }),
      undefined, control)
    const proof = remoteProof(control, 'session-1')
    const writing = executor.execute({ operation: 'session.cancel',
      command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', control: proof }, new AbortController().signal)
    await vi.waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
    const local = { kind: 'local' as const, id: 'desktop-browser' }
    expect(control.acquire('session-1', local,
      { takeover: true, expectedEpoch: proof.epoch }).outcome).toBe('held_elsewhere')
    pending.resolve({ accepted: true })
    await expect(writing).resolves.toEqual({ accepted: true })
    expect(control.acquire('session-1', local,
      { takeover: true, expectedEpoch: proof.epoch }).outcome).toBe('controlled')
    await expect(executor.execute({ operation: 'session.cancel',
      command_id: '123e4567-e89b-42d3-a456-426614174003' as never,
      session_id: 'session-1', control: proof }, new AbortController().signal))
      .rejects.toThrow('control lost')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('returns the bounded opening history snapshot and closes the follow stream', async () => {
    const returned = vi.fn(async () => ({ done: true, value: undefined }))
    const iterator = {
      next: vi.fn(async () => ({ done: false, value: { type: 'snapshot', records: [{ type: 'event', event: {
        type: 'user/message', seq: 0, time: 1, data: {}, surfaceOp: 'append',
      } }] } })),
      return: returned,
    }
    const gateway = gatewayFixture({ stream: vi.fn(async () => ({ [Symbol.asyncIterator]: () => iterator })) })
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
    const gateway = gatewayFixture({ stream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot', records: [older, recent] }
      },
    })) })
    const executor = new DesktopRemoteSessionExecutor(gateway)
    const result = await executor.execute({
      operation: 'session.history', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', max_events: 100,
    }, new AbortController().signal)
    expect((result as { events: typeof recent[] }).events.map(item => item.event.seq)).toEqual([2])
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(HOST_CONTROL_MAX_FRAME_BYTES)
  })

  it('projects display events and omits deep internal records before Host encoding', async () => {
    const internal = { type: 'event', event: { type: 'request/header', seq: 1, time: 1,
      data: { nested: { a: { b: { c: { d: { e: { f: { g: 'private' } } } } } } } } } }
    const assistant = { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2,
      data: { message: { content: [{ type: 'text', text: 'visible reply' }],
        privateMetadata: { nested: { a: { b: { c: { d: 'private' } } } } } } } } }
    const gateway = gatewayFixture({ stream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'snapshot', records: [internal, assistant] }
      },
    })) })
    const executor = new DesktopRemoteSessionExecutor(gateway)
    const result = await executor.execute({
      operation: 'session.history', command_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      session_id: 'session-1', max_events: 100,
    }, new AbortController().signal)
    expect((result as { events: unknown[] }).events).toEqual([{ type: 'event', event: {
      type: 'assistant/message', seq: 2, time: 2,
      data: { message: { content: [{ text: 'visible reply' }] } },
    } }])
    expect(() => encodeHostControlFrame({
      version: 1, type: 'result', request_id: '123e4567-e89b-42d3-a456-426614174000' as never,
      method: 'profile.remote_session', result: { value: result },
    })).not.toThrow()
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

  it('returns a distinct status when a stale remote proof loses control', async () => {
    const token = 'A'.repeat(43)
    const control = new DesktopSessionControl()
    const proof = remoteProof(control, 'session-1')
    const observed = control.browserStatus('session-1')
    if (!('claim' in observed)) throw new Error('missing remote claim')
    expect(control.takeoverBrowser('session-1', observed.claim.epoch).outcome).toBe('controlled')
    const invoke = vi.fn()
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }),
      undefined, control)
    const server = createServer((req, res) => {
      void handleDesktopRemoteSessionRequest(req, res, token,
        (command, signal) => executor.execute(command, signal))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const response = await fetch(origin, { method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ operation: 'session.cancel',
          command_id: '123e4567-e89b-42d3-a456-426614174000',
          session_id: 'session-1', control: proof }) })
      expect(response.status).toBe(409)
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('returns capacity status without creating another remote Session claim', async () => {
    const token = 'A'.repeat(43)
    const control = new DesktopSessionControl(() => 1_000, 30_000, 1)
    remoteProof(control, 'session-1')
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke: vi.fn() }),
      undefined, control)
    const server = createServer((req, res) => {
      void handleDesktopRemoteSessionRequest(req, res, token,
        (command, signal) => executor.execute(command, signal))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const response = await fetch(origin, { method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ operation: 'control.acquire',
          command_id: '123e4567-e89b-42d3-a456-426614174000',
          session_id: 'session-2', controller_id: '123e4567-e89b-42d3-a456-426614174002', takeover: false }) })
      expect(response.status).toBe(429)
      expect(control.status('session-2', { kind: 'remote', id: '123e4567-e89b-42d3-a456-426614174002' }))
        .toMatchObject({ outcome: 'uncontrolled' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error)
        else resolve()
      }))
    }
  })

  it('returns an uncacheable validation error for malformed private Session input', async () => {
    const token = 'A'.repeat(43)
    const execute = vi.fn(async () => ({ accepted: true }))
    const server = createServer((req, res) => {
      void handleDesktopRemoteSessionRequest(req, res, token, execute)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      const response = await fetch(origin, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body: '{invalid' })
      expect(response.status).toBe(422)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(execute).not.toHaveBeenCalled()
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
    const gateway = gatewayFixture({
      wireStream: { open: vi.fn(async () => events()) }, respondRemoteEvent,
    })
    const control = new DesktopSessionControl()
    const executor = new DesktopRemoteSessionExecutor(gateway, undefined, control)
    const proof = remoteProof(control, 'session-1')
    const commandId = '123e4567-e89b-42d3-a456-426614174000' as never
    const value = await executor.execute({ operation: 'approval.poll', command_id: commandId, wait_ms: 100 },
      new AbortController().signal) as Record<string, unknown>
    const frame = (value.frames as Array<Record<string, unknown>>)[0]!
    const payload = frame.payload as Record<string, unknown>
    expect(payload).toMatchObject({
      type: 'approval/requested', sessionId: 'session-1', toolName: 'bash', reason: 'run command',
    })
    await expect(executor.execute({
      operation: 'approval.respond', command_id: commandId, session_id: 'session-1', control: proof,
      approval_id: payload.approvalId as string, outcome: 'allowed-once',
    }, new AbortController().signal)).rejects.toThrow('digest required')
    await expect(executor.execute({
      operation: 'approval.respond', command_id: commandId, session_id: 'session-1', control: proof,
      approval_id: payload.approvalId as string, outcome: 'allowed-once',
      operation_digest: payload.operationDigest as never,
    }, new AbortController().signal)).resolves.toEqual({ accepted: true })
    expect(respondRemoteEvent).toHaveBeenCalledWith({
      clientId: 'client-1', eventId: 'event-1', outcome: { kind: 'result', value: 'allowed-once' },
    })
  })
})


describe('REQ-20260930-0015 remote directory confirmation', () => {
  const command_id = '123e4567-e89b-42d3-a456-426614174000' as never
  const client_id = '123e4567-e89b-42d3-a456-426614174001'
  it('registers only a directory confirmed on this Host for the paired client, once', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('/tmp/confirmed-folder')
      .mockResolvedValue({ workspace: { workspaceId: 'workspace-new' }, created: true })
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    const picked = await executor.execute({ operation: 'directory.pick', command_id, client_id }, signal)
    expect((picked as { path: string }).path).toBe('/tmp/confirmed-folder')
    expect(typeof (picked as { grantId: string }).grantId).toBe('string')
    expect((picked as { grantId: string }).grantId.length).toBeGreaterThan(0)
    const command = { operation: 'workspace.create' as const, command_id, client_id,
      path: '/tmp/confirmed-folder', grant_id: (picked as { grantId: string }).grantId }
    await expect(executor.execute({ ...command, path: '/tmp/forged' }, signal)).rejects.toThrow()
    await expect(executor.execute({ ...command, client_id: '123e4567-e89b-42d3-a456-426614174002' }, signal)).rejects.toThrow()
    await expect(executor.execute(command, signal)).resolves.toMatchObject({ created: true })
    await expect(executor.execute(command, signal)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledWith({ namespace: 'directoryPicker', method: 'pick', args: {}, signal })
    expect(invoke).toHaveBeenLastCalledWith({ namespace: 'workspace', method: 'create',
      args: { request: { path: '/tmp/confirmed-folder' } }, signal })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('expires confirmations and isolates them between Profile workers', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/confirmed')
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    const picked = await executor.execute({ operation: 'directory.pick', command_id, client_id }, signal) as { grantId: string }
    const command = { operation: 'workspace.create' as const, command_id, client_id, path: '/tmp/confirmed', grant_id: picked.grantId }
    const other = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    await expect(other.execute(command, signal)).rejects.toThrow('confirmation required')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    try { await expect(executor.execute(command, signal)).rejects.toThrow('confirmation required') } finally { clock.mockRestore() }
    expect(invoke).toHaveBeenCalledOnce()
  })
  it('withdraws a previous confirmation when the client opens another chooser and cancels', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('/tmp/confirmed').mockResolvedValueOnce(null)
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    const signal = new AbortController().signal
    const picked = await executor.execute({ operation: 'directory.pick', command_id, client_id }, signal) as { grantId: string }
    await executor.execute({ operation: 'directory.pick', command_id, client_id }, signal)
    await expect(executor.execute({ operation: 'workspace.create', command_id, client_id,
      path: '/tmp/confirmed', grant_id: picked.grantId }, signal)).rejects.toThrow('confirmation required')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('returns cancellation without granting a path and rejects a late chooser settlement after abort', async () => {
    const controller = new AbortController()
    const invoke = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(async () => {
      controller.abort(); return '/tmp/late'
    })
    const executor = new DesktopRemoteSessionExecutor(gatewayFixture({ invoke }))
    await expect(executor.execute({ operation: 'directory.pick', command_id, client_id }, controller.signal))
      .resolves.toEqual({ path: null })
    await expect(executor.execute({ operation: 'directory.pick', command_id, client_id }, controller.signal)).rejects.toThrow()
  })
})
