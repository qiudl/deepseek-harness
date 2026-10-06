// @vitest-environment jsdom
/** REQ-20260930-0004: the real parent-port carrier feeds the scope consumer without network fetch. */
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkerTunnel, type TunnelEndpoint } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { installRemoteCollaboration } from '../src/remote-collaboration.ts'

const workspace = '11111111-1111-4111-8111-111111111111'
const input = { workspace_id: workspace, session_id: 'session-1', operation: { kind: 'get' } }
const saved = { workspace_id: workspace, version: '2', selected_project_ids: ['project-1'] }
const capability = { schema: 'dsh-remote-collaboration/v1', methods: ['workspace'] }
interface RequestFrame { t: string; id: number; url?: string; body?: ArrayBuffer }
interface Rpc { type: string; rpcId: string; method: string; payload: { args: { request: typeof input } } }
type Reply = (path: string, rpc: Rpc | undefined) => Promise<{ status: number; value?: unknown }> | { status: number; value?: unknown }
const cleanups: Array<() => void> = []

function harness(reply: Reply) {
  vi.stubGlobal('MessageChannel', NodeMessageChannel)
  vi.stubGlobal('crypto', webcrypto)
  const channel = new MessageChannel()
  let closed = false
  const frames: RequestFrame[] = []
  channel.port1.addEventListener('message', (event: MessageEvent<RequestFrame>) => {
    const frame = event.data
    frames.push(frame)
    if (frame.t !== 'req' || frame.url === undefined) return
    const path = new URL(frame.url).pathname
    const rpc: Rpc | undefined = frame.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(frame.body)) as Rpc
    void Promise.resolve(reply(path, rpc)).then(({ status, value }) => {
      if (closed) return
      channel.port1.postMessage({ t: 'res', id: frame.id, status,
        headers: { 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(value)).buffer }) })
    })
  })
  channel.port1.start()
  channel.port2.start()
  const endpoint: TunnelEndpoint = {
    postMessage(message) { channel.port2.postMessage(message) },
    addEventListener(type, listener) { channel.port2.addEventListener(type, listener as EventListener) },
  }
  const tunnel = new WorkerTunnel(endpoint)
  cleanups.push(() => { closed = true; channel.port1.close(); channel.port2.close() })
  return { fetch: tunnel.fetch, frames }
}
function bridge(): {
  collaborationScopeAvailable: boolean
  collaborationExecutionAvailable: boolean
  collaborationWorkspace(value: unknown): Promise<unknown> } {
  const host: unknown = Reflect.get(window, '__DSH_DESKTOP_HOST__')
  if (typeof host !== 'object' || host === null || !('collaborationWorkspace' in host)) throw Error('bridge is missing')
  return host as ReturnType<typeof bridge>
}
function envelope(rpc: Rpc | undefined, value: unknown) {
  if (rpc === undefined) throw Error('RPC is required')
  return { type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }
}
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  Reflect.deleteProperty(window, '__DSH_DESKTOP_HOST__')
  cleanups.splice(0).forEach((close) => { close() })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each([undefined, { ...capability, methods: [] }, { ...capability, methods: ['workspace', 'submit'] },
  { ...capability, schema: 'other' }, { ...capability, token: 'forged' }])('keeps unsupported parents out of scope mode: %j', async (advertised) => {
  const h = harness(() => ({ status: advertised === undefined ? 403 : 200, value: advertised }))
  await installRemoteCollaboration(h.fetch)
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toBeUndefined()
  expect(h.frames).toHaveLength(1)
})

it('unwraps the workspace result over the real tunnel and preserves ordinary network isolation', async () => {
  const network = vi.fn(() => { throw Error('network fetch is forbidden') })
  vi.stubGlobal('fetch', network)
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration__') return { status: 200, value: capability }
    if (rpc === undefined) throw Error('RPC is required')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { ok: true, value: saved }) }
  })
  await installRemoteCollaboration(h.fetch)
  expect(bridge().collaborationScopeAvailable).toBe(true)
  expect(bridge().collaborationExecutionAvailable).toBe(false)
  expect(await bridge().collaborationWorkspace(input)).toEqual({ ok: true, value: saved })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.rpcId).toBeTypeOf('string')
  expect(requests[0]).toMatchObject({ type: 'client-request', method: 'collaboration/workspace',
    payload: { args: { request: input } } })
  expect(network).not.toHaveBeenCalled()
})

it('rejects forged request identity before sending and rejects a different workspace response', async () => {
  const h = harness((path, rpc) => path === '/__collaboration__' ? { status: 200, value: capability } :
    { status: 200, value: envelope(rpc, { ok: true, value: { ...saved, workspace_id: 'other' } }) })
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationWorkspace({ ...input, computer_id: 'other' })).toEqual(
    { ok: false, errorCode: 'collaboration_scope_unavailable', refreshRequired: false })
  expect(h.frames.filter(frame => frame.t === 'req')).toHaveLength(1)
  expect(await bridge().collaborationWorkspace(input)).toEqual(
    { ok: false, errorCode: 'collaboration_scope_unavailable', refreshRequired: false })
})

it.each(['wrong-rpc', 'missing-version', 'wrong-inner-envelope', 'oversized-directory', 'bad-capability'])('refuses invalid %s replies after an operation actually executes', async (kind) => {
  let calls = 0
  const h = harness((path, rpc) => {
    if (path === '/__collaboration__') return { status: 200, value: capability }
    calls++
    const agent = { project_id: 'p', project_name: 'Project', agent_id: 'a', agent_name: 'Agent',
      available: true, reason_code: 'ready', capability_snapshot: 'f'.repeat(64) }
    const value = kind === 'missing-version' ? { workspace_id: workspace, selected_project_ids: [] } :
      kind === 'oversized-directory' ? { items: [agent, agent], next_cursor: null, scope_version: '1' } :
        kind === 'bad-capability' ? { items: [{ ...agent, capability_snapshot: 'bad' }], next_cursor: null, scope_version: '1' } : saved
    const wire = envelope(rpc, { ok: true, value })
    if (kind === 'wrong-rpc') wire.rpcId = 'substituted'
    if (kind === 'wrong-inner-envelope') wire.result = { ok: true, value: { ok: true, value: {} } }
    return { status: 200, value: wire }
  })
  await installRemoteCollaboration(h.fetch)
  const request = kind === 'oversized-directory' || kind === 'bad-capability'
    ? { ...input, operation: { kind: 'agents', query: { limit: 1 } } } : input
  expect(await bridge().collaborationWorkspace(request)).toMatchObject({ ok: false })
  expect(calls).toBe(1)
})

it('preserves a validated conflict and the apply refresh requirement', async () => {
  const conflict = { ok: false, errorCode: 'scope_conflict', refreshRequired: true, currentScope: saved }
  const h = harness((path, rpc) => path === '/__collaboration__' ? { status: 200, value: capability } :
    { status: 200, value: envelope(rpc, conflict) })
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationWorkspace({ ...input,
    operation: { kind: 'apply', expected_version: '1', selected_project_ids: ['project-2'] } })).toEqual(conflict)
})

it('cancels a submitted save on pagehide without claiming it was not committed', async () => {
  const started = Promise.withResolvers<undefined>()
  const h = harness((path) => {
    if (path === '/__collaboration__') return { status: 200, value: capability }
    started.resolve(undefined)
    return new Promise(() => {})
  })
  await installRemoteCollaboration(h.fetch)
  const host = bridge()
  const pending = host.collaborationWorkspace({ ...input,
    operation: { kind: 'apply', expected_version: '1', selected_project_ids: [] } })
  await started.promise
  window.dispatchEvent(new Event('pagehide'))
  expect(await pending).toEqual({ ok: false, errorCode: 'collaboration_scope_unavailable', refreshRequired: true })
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toBeUndefined()
  expect(await host.collaborationWorkspace(input)).toMatchObject({ ok: false, refreshRequired: false })
})

it('bounds an ignored discovery cancellation and removes its page listener', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => new Promise<Response>(() => {}))
  const remove = vi.spyOn(window, 'removeEventListener')
  const pending = installRemoteCollaboration(fetch)
  await vi.advanceTimersByTimeAsync(5_000)
  await pending
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toBeUndefined()
  expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('does not install a late capability reply after the page closes', async () => {
  const delayed = Promise.withResolvers<Response>()
  const pending = installRemoteCollaboration(async () => delayed.promise)
  window.dispatchEvent(new Event('pagehide'))
  await pending
  delayed.resolve(new Response(JSON.stringify(capability)))
  await Promise.resolve()
  expect(Reflect.get(window, '__DSH_DESKTOP_HOST__')).toBeUndefined()
})

it.each(['projects', 'agents', 'apply'] as const)('publishes validated %s data through the consumer', async (kind) => {
  const project = { project_id: 'p', project_name: 'Project' }
  const value = kind === 'apply' ? saved : { items: [kind === 'agents' ? { ...project,
    agent_id: 'a', agent_name: 'Agent', available: false, reason_code: 'agent_stopped', capability_snapshot: 'f'.repeat(64),
  } : project], next_cursor: null, ...(kind === 'agents' ? { scope_version: '1' } : {}) }
  const h = harness((path, rpc) => path === '/__collaboration__' ? { status: 200, value: capability } :
    { status: 200, value: envelope(rpc, { ok: true, value }) })
  await installRemoteCollaboration(h.fetch)
  const request = { ...input, operation: kind === 'apply' ?
    { kind, expected_version: '1', selected_project_ids: ['p'] } : { kind, query: { limit: 20 } } }
  expect(await bridge().collaborationWorkspace(request)).toEqual({ ok: true, value })
})

it('covers response-body reads with the operation deadline and cancels the stalled reader', async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const started = Promise.withResolvers<undefined>()
  const fetch = vi.fn(async (path: URL | string) => {
    if (path === '/__collaboration__') return new Response(JSON.stringify(capability))
    started.resolve(undefined)
    return new Response(new ReadableStream<Uint8Array>({ cancel }))
  })
  await installRemoteCollaboration(fetch)
  const pending = bridge().collaborationWorkspace({ ...input,
    operation: { kind: 'apply', expected_version: '1', selected_project_ids: [] } })
  await started.promise
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await pending).toMatchObject({ ok: false, refreshRequired: true })
  expect(cancel).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
