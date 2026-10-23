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
interface Rpc { type: string; rpcId: string; method: string; payload: { args: { request: unknown } } }
type Reply = (path: string, rpc: Rpc | undefined) => Promise<{ status: number; value?: unknown }> | { status: number; value?: unknown }
const cleanups: Array<() => void> = []

function harness(reply: Reply, supportsV2 = false) {
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
    if (path === '/__collaboration_v2__' && !supportsV2) {
      channel.port1.postMessage({ t: 'res', id: frame.id, status: 403, headers: {} })
      return
    }
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
  accountIdentity(): Promise<{ name: string; avatarUrl: string | null } | null>
  collaborationScopeAvailable: boolean
  collaborationExecutionAvailable: boolean
  collaborationWorkspace(value: unknown): Promise<unknown>
  collaborationSubmit(value: unknown): Promise<unknown>
  collaborationPending(value: unknown): Promise<unknown>
  collaborationDeliveries(value: unknown): Promise<unknown>
  collaborationConversations?(): Promise<unknown>
  collaborationGroupMessages?(value: unknown): Promise<unknown>
  collaborationGroupWork?(value: unknown): Promise<unknown>
  collaborationGroupMembers?(value: unknown): Promise<unknown>
  collaborationGroupPreparation?(value: unknown): Promise<unknown>
  collaborationGroupActivation?(value: unknown): Promise<unknown>
  collaborationArchive?(value: unknown): Promise<unknown> } {
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
  expect(h.frames).toHaveLength(2)
})

it('falls back to the legacy capability when the v2 probe rejects', async () => {
  const paths: string[] = []
  await installRemoteCollaboration(async (path) => {
    paths.push(String(path))
    if (path === '/__collaboration_v2__') throw Error('unsupported capability')
    return Response.json(capability)
  })
  expect(bridge().collaborationScopeAvailable).toBe(true)
  expect(paths).toEqual(['/__collaboration_v2__', '/__collaboration__'])
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
  expect(h.frames.filter(frame => frame.t === 'req')).toHaveLength(2)
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
    if (path === '/__collaboration_v2__') return new Response(null, { status: 403 })
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


const executionCapability = { ...capability,methods:['workspace','submit','pending','deliveries'] }
const original = { workspace_id:workspace,session_id:'session-1',source_message_id:'message-1',source_revision:'1' }
const originalRequest = { ...original,original_message:'@Guide · 项目一 检查方案',active_mentions:[{ mention_id:'mention-1',
  source_span:{ source_message_id:'message-1',source_revision:'1',start:0,end:12 },
  display_snapshot:{ agent_name:'Guide',project_name:'项目一' },binding:{ kind:'resolved',target:{ project_id:'212',agent_id:'guide' },capability_snapshot:'a'.repeat(64) } }] }
const submitted = { ok:true,value:{ source:original,submission_state:'accepted',invocation_id:'invocation-1' } }
it('REQ-20260930-0004: complete parent capability installs ordinary @ submission and original result reads', async () => {
  const requests:Rpc[] = []
  const h = harness((path,rpc) => {
    if (path === '/__collaboration__') return { status:200,value:executionCapability }
    if (rpc === undefined) throw Error('missing RPC')
    requests.push(rpc)
    const result = path.endsWith('/submit') ? submitted : path.endsWith('/pending')
      ? { ok:true,value:{ source:original,plan:null,pending_items:[],frozen_task_count:0 } } : { ok:true,value:{ deliveries:[] } }
    return { status:200,value:envelope(rpc,result) }
  })
  await installRemoteCollaboration(h.fetch)
  expect(bridge().collaborationExecutionAvailable).toBe(true)
  expect(await bridge().collaborationSubmit(originalRequest)).toEqual(submitted)
  expect(await bridge().collaborationPending({ source:original })).toEqual(
    { ok:true,value:{ source:original,plan:null,pending_items:[],frozen_task_count:0 } })
  expect(await bridge().collaborationDeliveries({ source:original,limit:5 })).toEqual({ ok:true,value:{ deliveries:[] } })
  expect(requests.map(request => request.method)).toEqual(['collaboration/submit','collaboration/pending','collaboration/deliveries'])
  expect(requests[0]?.payload.args.request).toEqual(originalRequest)
  expect(requests[1]?.payload.args.request).toEqual({ source:original })
})
it('REQ-20260930-0004: execution consumer refuses injected authority and altered original coordinates without retry', async () => {
  const requests:Rpc[] = []
  const h = harness((path,rpc) => {
    if (path === '/__collaboration__') return { status:200,value:executionCapability }
    if (rpc === undefined) throw Error('missing RPC')
    requests.push(rpc)
    return { status:200,value:envelope(rpc,{ ...submitted,value:{ ...submitted.value,source:{ ...original,session_id:'other' } } }) }
  })
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationSubmit({ ...originalRequest,token:'child' })).toMatchObject({ ok:false,reconciliationRequired:false })
  expect(await bridge().collaborationSubmit(originalRequest)).toMatchObject({ ok:false,reconciliationRequired:true })
  expect(requests).toHaveLength(1)
  expect(await bridge().collaborationDeliveries({ source:original,namespace_id:'other' })).toMatchObject({ ok:false })
  expect(requests).toHaveLength(1)
})
it('REQ-20261011-0002: reads only Main-clipped conversation summaries and checks the global count', async () => {
  const advertised = { ...capability, methods: ['workspace', 'conversations'] }
  const page = { items: [{ workspace_id: workspace, session_id: 'session-1', first_source_at: '1',
    last_activity_at: '2', source_count: 1, pending_count: 2, planning_count: 0, running_count: 0, issue_count: 0,
    first_pending_digest: 'a'.repeat(64), pinned: false, archived: false }], global_pending_count: 2 }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { ok: true, value: page }) }
  })
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationConversations?.()).toEqual({ ok: true, value: page })
  expect(requests[0]?.method).toBe('collaboration/conversations')
  expect(requests[0]?.payload.args.request).toEqual({})
  page.items[0]!.archived = true
  expect(await bridge().collaborationConversations?.()).toEqual({ ok: true, value: page })
  page.global_pending_count = 1
  expect(await bridge().collaborationConversations?.()).toMatchObject({ ok: false })
})
it('REQ-20261011-0002: archive capability sends only action coordinates over the parent port', async () => {
  const advertised = { ...capability, methods: ['workspace', 'archive'] }
  const request = { workspace_id: workspace, session_id: 'session-1', action: 'archive' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { state: 'archived' }) }
  })
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationArchive?.(request)).toEqual({ state: 'archived' })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.method).toBe('collaboration/archive')
  expect(requests[0]?.payload.args.request).toEqual(request)
  expect(await bridge().collaborationArchive?.({ ...request, archive_token: 'forged' })).toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: a group message capability preserves older scope and requires exact commands', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMessages'] }
  const command = { operation: 'send', workspace_id: workspace, session_id: 'session-1',
    request_id: '33333333-3333-4333-8333-333333333333', expected_group_version: 2, body: 'hello' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { state: 'recorded',
      message_id: '44444444-4444-4444-8444-444444444444', seq: 1 }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(bridge().collaborationScopeAvailable).toBe(true)
  expect(await bridge().collaborationGroupMessages?.(command)).toMatchObject({ state: 'recorded', seq: 1 })
  expect(requests[0]?.method).toBe('collaboration/groupMessages')
  expect(requests[0]?.payload.args.request).toEqual(command)
  expect(await bridge().collaborationGroupMessages?.({ ...command, actor_ref: 'bot' }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: Root planning receives only committed group message coordinates', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupWork'] }
  const command = { workspace_id: workspace, session_id: 'session-1',
    message_id: '44444444-4444-4444-8444-444444444444' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { ok: true, planning: 'recorded',
      root: { root_task_id: 'root', root_trace_id: 'trace', source_descriptor: {
        workspace_id: workspace, session_id: 'session-1', source_message_id: command.message_id } },
      checkpoint: {} }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupWork?.(command)).toMatchObject({ ok: true, planning: 'recorded' })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.method).toBe('collaboration/groupWork')
  expect(requests[0]?.payload.args.request).toEqual(command)
  expect(await bridge().collaborationGroupWork?.({ ...command, body: '@Guide do it' }))
    .toMatchObject({ ok: false, reconciliationRequired: true })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: group Agent chips and recovered Source traverse the real remote carrier', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMessages'] }
  const messageId = '44444444-4444-4444-8444-444444444444'
  const requestId = '33333333-3333-4333-8333-333333333333'
  const groupId = '22222222-2222-4222-8222-222222222222'
  const label = '@Guide · Project'
  const body = `${label}\nPlease review`
  const ref = `slark-agent:${'a'.repeat(64)}`
  const span = { mention_id: '55555555-5555-4555-8555-555555555555', actor_ref: ref,
    start: 0, end: label.length, agent_name: 'Guide', project_name: 'Project',
    capability_snapshot: 'b'.repeat(64) }
  const send = { operation: 'send', workspace_id: workspace, session_id: 'session-1',
    request_id: requestId, expected_group_version: 2, body,
    mention_refs: [ref], mention_spans: [span] }
  const work = { operation: 'work-source', workspace_id: workspace,
    session_id: 'session-1', message_id: messageId }
  const source = { workspace_id: workspace, session_id: 'session-1',
    source_message_id: messageId, source_revision: '1', original_message: body,
    active_mentions: [{ mention_id: span.mention_id,
      source_span: { source_message_id: messageId, source_revision: '1', start: 0, end: label.length },
      display_snapshot: { agent_name: 'Guide', project_name: 'Project' },
      binding: { kind: 'resolved', target: { project_id: 'project-1', agent_id: 'agent-1' },
        capability_snapshot: span.capability_snapshot } }] }
  const requests: Rpc[] = []
  let wrongSource = false
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, rpc.payload.args.request &&
      (rpc.payload.args.request as { operation: string }).operation === 'send'
      ? { state: 'recorded', message_id: messageId, seq: 1 }
      : { state: 'recorded_source', group_id: groupId, request_id: requestId,
        payload_digest: 'c'.repeat(64), message_seq: 1,
        source: wrongSource ? { ...source, source_message_id: groupId } : source }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMessages?.(send)).toMatchObject({ state: 'recorded', message_id: messageId })
  expect(await bridge().collaborationGroupMessages?.(work)).toMatchObject({ state: 'recorded_source', source })
  expect(requests.map(request => request.payload.args.request)).toEqual([send, work])
  expect(await bridge().collaborationGroupMessages?.({ ...send, mention_spans: [{ ...span, end: 2 }] }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(2)
  wrongSource = true
  expect(await bridge().collaborationGroupMessages?.(work)).toEqual({ state: 'retry_required' })
})
it('REQ-20261020-0010: a member capability keeps the remote bridge installed and sends exact commands', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2',
    methods: ['workspace', 'groupMessages', 'groupMembers'] }
  const command = { operation: 'status', workspace_id: workspace, session_id: 'session-1' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { state: 'snapshot',
      group_id: '22222222-2222-4222-8222-222222222222', membership_version: 1,
      last_seq: 0, members: [{ member_id: '33333333-3333-4333-8333-333333333333',
        actor_kind: 'human', actor_ref: 'owner', role: 'owner', cycle: 1,
        joined_seq: 0, sources: [] }] }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(bridge().collaborationScopeAvailable).toBe(true)
  expect(await bridge().collaborationGroupMembers?.(command)).toMatchObject({ state: 'snapshot',
    membership_version: 1 })
  expect(requests[0]?.method).toBe('collaboration/groupMembers')
  expect(requests[0]?.payload.args.request).toEqual(command)
  expect(await bridge().collaborationGroupMembers?.({ ...command, owner: 'forged' }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: Bot picker accepts only public sorted identities', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2',
    methods: ['workspace', 'groupMembers'] }
  const command = { operation: 'bots', workspace_id: workspace, session_id: 'session-1',
    after_bot_id: '', limit: 50 }
  let extra = false
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    return { status: 200, value: envelope(rpc, { state: 'bot_roster', bots: [{
      bot_id: 'my_bot', actor_ref: 'deepseek-bot:my_bot', display_name: 'My Bot',
      ...(extra ? { private_config: 'secret' } : {}) }], next_cursor: null }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMembers?.(command)).toMatchObject({ state: 'bot_roster',
    bots: [{ bot_id: 'my_bot', display_name: 'My Bot' }] })
  extra = true
  expect(await bridge().collaborationGroupMembers?.(command)).toEqual({ state: 'retry_required' })
  expect(await bridge().collaborationGroupMembers?.({ ...command, limit: 101 }))
    .toEqual({ state: 'retry_required' })
})
it('REQ-20261020-0010: unresolved member inventory rejects private fields', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2',
    methods: ['workspace', 'groupMembers'] }
  const member_id = '33333333-3333-4333-8333-333333333333'
  const delivery_id = '44444444-4444-4444-8444-444444444444'
  const command = { operation: 'inflight', workspace_id: workspace, session_id: 'session-1',
    member_id, after_delivery_id: '', limit: 50 }
  let extra = false
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    return { status: 200, value: envelope(rpc, { state: 'inflight', member_id,
      member_cycle: 1, deliveries: [{ delivery_id, message_seq: 7,
        payload_digest: 'a'.repeat(64), state: 'pending_reconciliation',
        ...(extra ? { body: 'private' } : {}) }], next_cursor: null }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMembers?.(command)).toMatchObject({ state: 'inflight',
    deliveries: [{ delivery_id, message_seq: 7 }] })
  extra = true
  expect(await bridge().collaborationGroupMembers?.(command)).toEqual({ state: 'retry_required' })
  expect(await bridge().collaborationGroupMembers?.({ ...command, limit: 101 }))
    .toEqual({ state: 'retry_required' })
})
it('REQ-20261020-0010: personal proxy commands carry only binding facts', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2',
    methods: ['workspace', 'groupMembers'] }
  const commands: Rpc[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    commands.push(rpc)
    const requested = rpc.payload.args.request as { operation?: string }
    return { status: 200, value: envelope(rpc, requested.operation === 'proxy_status'
      ? { state: 'proxy_binding', binding_id: null, binding_epoch: 0, bot_ref: null,
        binding_state: 'unbound' }
      : { state: 'proxy_bound', binding_id: bindingId, binding_epoch: 1,
        bot_ref: 'deepseek-bot:my_bot' }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_status',
    workspace_id: workspace, session_id: 'session-1' })).toMatchObject({ state: 'proxy_binding' })
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_select',
    workspace_id: workspace, session_id: 'session-1',
    request_id: '66666666-6666-4666-8666-666666666666',
    expected_binding_epoch: 0, bot_id: 'my_bot' })).toMatchObject({ state: 'proxy_bound' })
  expect(commands).toHaveLength(2)
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_select',
    workspace_id: workspace, session_id: 'session-1',
    request_id: '66666666-6666-4666-8666-666666666666',
    expected_binding_epoch: 0, bot_id: '../other' })).toEqual({ state: 'retry_required' })
  expect(commands).toHaveLength(2)
})
it('REQ-20261020-0010: proxy replacement and unbind require exact fenced replies', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMembers'] }
  const commands: Rpc[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let forged = false
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    commands.push(rpc)
    const requested = rpc.payload.args.request as { operation: string }
    const replace = requested.operation === 'proxy_replace'
    return { status: 200, value: envelope(rpc, { state: 'proxy_changed',
      operation: replace ? 'replace' : 'unbind', binding_id: bindingId, binding_epoch: 2,
      binding_state: replace ? 'transferring' : 'unbound',
      bot_ref: forged ? 'deepseek-bot:forged' : replace ? 'deepseek-bot:next_bot' : null }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  const base = { workspace_id: workspace, session_id: 'session-1',
    request_id: '66666666-6666-4666-8666-666666666666', expected_binding_epoch: 1 }
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_replace', ...base,
    bot_id: 'next_bot' })).toMatchObject({ state: 'proxy_changed', operation: 'replace' })
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_unbind', ...base }))
    .toMatchObject({ state: 'proxy_changed', operation: 'unbind' })
  expect(commands).toHaveLength(2)
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_replace', ...base,
    bot_id: '../other' })).toEqual({ state: 'retry_required' })
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_unbind', ...base,
    expected_binding_epoch: 0 })).toEqual({ state: 'retry_required' })
  expect(commands).toHaveLength(2)
  forged = true
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_unbind', ...base }))
    .toEqual({ state: 'retry_required' })
})

it('REQ-20261020-0010: current Host handoff steps accept only scoped metadata', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMembers'] }
  const commands: Rpc[] = []
  const bindingId = '55555555-5555-4555-8555-555555555555'
  let forged = false
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    commands.push(rpc)
    const requested = rpc.payload.args.request as { operation: string }
    const operation = requested.operation.slice('proxy_handoff_'.length)
    return { status: 200, value: envelope(rpc, operation === 'seal'
      ? { state: 'handoff_sealed', handoff_id: bindingId, namespace_count: 2, item_count: 3,
        ...(forged ? { task_body: 'private' } : {}) }
      : { state: 'handoff_step', operation,
        result: operation === 'complete' ? 'active' : 'recorded' }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  const base = { workspace_id: workspace, session_id: 'session-1',
    binding_id: bindingId, target_epoch: 2 }
  for (const operation of ['seal', 'revoke', 'attach', 'complete'] as const)
    expect(await bridge().collaborationGroupMembers?.({ operation: `proxy_handoff_${operation}`, ...base }))
      .toMatchObject({ state: operation === 'seal' ? 'handoff_sealed' : 'handoff_step' })
  expect(commands).toHaveLength(4)
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_handoff_revoke', ...base,
    target_epoch: 0 })).toEqual({ state: 'retry_required' })
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_handoff_attach', ...base,
    task_body: 'private' })).toEqual({ state: 'retry_required' })
  expect(commands).toHaveLength(4)
  forged = true
  expect(await bridge().collaborationGroupMembers?.({ operation: 'proxy_handoff_seal', ...base }))
    .toEqual({ state: 'retry_required' })
})

it('REQ-20261020-0010: group pending commands stay exact and use the verified parent bridge', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMessages'] }
  const command = { operation: 'pending_claim', workspace_id: workspace, session_id: 'session-1',
    group_id: '22222222-2222-4222-8222-222222222222', digest: 'a'.repeat(64) }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { state: 'pending',
      request_id: '33333333-3333-4333-8333-333333333333' }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMessages?.(command)).toMatchObject({ state: 'pending' })
  expect(requests[0]?.payload.args.request).toEqual(command)
  expect(await bridge().collaborationGroupMessages?.({ ...command, digest: 'bad' }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: group page accepts multiline messages but rejects malformed rows', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupMessages'] }
  const command = { operation: 'page', workspace_id: workspace, session_id: 'session-1', after_seq: 0, limit: 10 }
  let body = 'hello\nworld'
  const h = harness((path, rpc) => path === '/__collaboration_v2__' ? { status: 200, value: advertised }
    : { status: 200, value: envelope(rpc, { state: 'page', items: [{
      id: '44444444-4444-4444-8444-444444444444', seq: 1, actor_kind: 'human',
      actor_ref: 'alice', body, created_at: 1 }], next_seq: 1, has_more: false, last_seq: 1 }) }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupMessages?.(command)).toMatchObject({ state: 'page', items: [{ body }] })
  body = ''
  expect(await bridge().collaborationGroupMessages?.(command)).toEqual({ state: 'retry_required' })
})
it('REQ-20261020-0010: preparation sends only original Source coordinates', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupPreparation'] }
  const source = { workspace_id: workspace, session_id: 'session-1',
    source_message_id: 'message-1', source_revision: '1' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, { state: 'preparing',
      group_id: '44444444-4444-4444-8444-444444444444', version: 1,
      workspace_id: workspace, session_id: 'session-1' }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(bridge().collaborationScopeAvailable).toBe(true)
  expect(await bridge().collaborationGroupPreparation?.(source)).toMatchObject({ state: 'preparing', version: 1 })
  expect(requests[0]?.method).toBe('collaboration/groupPreparation')
  expect(requests[0]?.payload.args.request).toEqual(source)
  expect(await bridge().collaborationGroupPreparation?.({ ...source, host_snapshot_assertion: 'caller' }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(1)
})
it('REQ-20261020-0010: group lookup recovers only the mapped original Session', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2', methods: ['workspace', 'groupPreparation'] }
  const lookup = { operation: 'lookup', workspace_id: workspace, session_id: 'session-1' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, requests.length === 1 ? {
      state: 'group_active', group_id: '44444444-4444-4444-8444-444444444444',
      version: 2, last_seq: 3, workspace_id: workspace, session_id: 'session-1',
    } : { state: 'missing' }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupPreparation?.(lookup)).toMatchObject({
    state: 'group_active', version: 2, last_seq: 3 })
  expect(requests[0]?.payload.args.request).toEqual(lookup)
  expect(await bridge().collaborationGroupPreparation?.(lookup)).toEqual({ state: 'missing' })
  expect(await bridge().collaborationGroupPreparation?.({ ...lookup, owner: 'bob' }))
    .toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(2)
})
it('REQ-20261020-0010: activation uses a verified v2 Host capability and exact result', async () => {
  const advertised = { schema: 'dsh-remote-collaboration/v2',
    methods: ['workspace', 'groupActivation', 'groupMessages', 'groupPreparation'] }
  const input = { request_id: '33333333-3333-4333-8333-333333333333',
    workspace_id: workspace, session_id: 'session-1' }
  const requests: Rpc[] = []
  const h = harness((path, rpc) => {
    if (path === '/__collaboration_v2__') return { status: 200, value: advertised }
    if (!rpc) throw Error('missing RPC')
    requests.push(rpc)
    return { status: 200, value: envelope(rpc, requests.length === 1
      ? { state: 'group_active', group_id: '44444444-4444-4444-8444-444444444444', version: 2 }
      : { state: 'group_active', group_id: 'invalid', version: 2 }) }
  }, true)
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().collaborationGroupActivation?.(input)).toEqual({ state: 'group_active',
    group_id: '44444444-4444-4444-8444-444444444444', version: 2 })
  expect(requests[0]?.method).toBe('collaboration/groupActivation')
  expect(requests[0]?.payload.args.request).toEqual(input)
  expect(await bridge().collaborationGroupActivation?.({ ...input, request_id: 'invalid' }))
    .toEqual({ state: 'retry_required' })
  expect(await bridge().collaborationGroupActivation?.(input)).toEqual({ state: 'retry_required' })
  expect(requests).toHaveLength(2)
})
it('REQ-20260930-0004: execution consumer cancels accepted transport waits on pagehide without resubmitting the Agent', async () => {
  const started = Promise.withResolvers<undefined>()
  const h = harness((path) => {
    if (path === '/__collaboration__') return { status:200,value:executionCapability }
    started.resolve(undefined); return new Promise(() => {})
  })
  await installRemoteCollaboration(h.fetch)
  const host = bridge(),reading = host.collaborationSubmit(originalRequest)
  await started.promise; window.dispatchEvent(new Event('pagehide'))
  expect(await reading).toMatchObject({ ok:false,reconciliationRequired:true })
  expect(Reflect.get(window,'__DSH_DESKTOP_HOST__')).toBeUndefined()
  expect(h.frames.filter(frame => frame.t === 'req')).toHaveLength(3)
  expect(await host.collaborationDeliveries({ source:original })).toMatchObject({ ok:false })
})


it.each([
  [{ name: 'Alice', avatarUrl: 'data:image/png;base64,AQID' }, true],
  [{ name: 'Alice', avatarUrl: 'data:image/png;base64,' + 'A'.repeat(699048) + 'AAA=' }, true],
  [{ name: 'Alice', avatarUrl: 'https://other.test/picture?token=secret' }, false],
  [{ name: 'Alice', avatarUrl: null, token: 'secret' }, false],
  [null, false],
])('reads only credential-free display identity from the parent carrier: %j', async (identity, valid) => {
  const h = harness(path => ({ status: 200, value: path === '/__collaboration__' ? capability : identity }))
  await installRemoteCollaboration(h.fetch)
  expect(await bridge().accountIdentity()).toEqual(valid ? identity : null)
})
