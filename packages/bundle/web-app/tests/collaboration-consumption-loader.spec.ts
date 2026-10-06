/** REQ-20261004-0008: real Loader, AgentLoop, JSONL writer and private HTTP feedback path. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import SessionController, { collaborationJournalDigest } from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installSessionReadTestServices } from '../../../api/session-controller/tests/test-remote.ts'
import * as WebApp from '../src/index.ts'

class FeedbackAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '已结合协作结果' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已结合协作结果' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
it.each(['success', 'checkpoint_failure'] as const)('consumes a fresh grant once through the real Loader: %s', async (mode) => {
  const directory = await mkdtemp(join(tmpdir(), 'req0008-feedback-loader-')), cwd = await realpath(directory)
  const ctx = new Context(), token = 'B'.repeat(43), routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const server = createServer((req, res) => { const handler = routes.get(req.url ?? ''); if (handler) void handler(req, res); else res.writeHead(404).end() })
  let facility: DomainFacility | undefined, backend: JsonStorageBackend | undefined
  onTestFinished(async () => {
    await ctx.fiber.dispose(); await facility?.closeAll(); await backend?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true })
  })
  for (const name of ['DSH_PROFILE_SOURCE_TOKEN', 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN', 'DSH_PROFILE_MODEL_TOKEN', 'DSH_PROFILE_REMOTE_SESSION_TOKEN', 'DSH_PROFILE_REMOTE_UI_TOKEN', 'DSH_PROFILE_DELIVERY_TOKEN']) vi.stubEnv(name, '')
  vi.stubEnv('DSH_PROFILE_ANALYSIS_TOKEN', token)
  ctx.provide('webServer', { host: '127.0.0.1', port: 0, register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
    routes.set(route.path, route.handler); return () => routes.delete(route.path)
  } } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} } } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'selected' }) } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  ctx.provide('fs', {} as never)
  installSessionReadTestServices(ctx)
  const plugins = { storage: Storage, sessions: SessionStore, persistence: JsonlPersistence, agents: AgentRegistry, llm: LlmRuntime,
    prompt: SystemPrompt, tools: Tools, loop: AgentLoop, workspace: WorkspaceRegistry, controller: SessionController, web: WebApp,
    domain: { name: 'feedback-domain', inject: ['storage'], apply(c: Context) {
      backend = new JsonStorageBackend(join(directory, 'state')); c.storage.backend.register('json', backend)
      facility = new DomainFacility(c, { backend: 'json' }); c.storage.mount('domain', facility); c.provide('storageDomain', facility)
    } } }
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `feedback:${id}`,
    config: id === 'persistence' ? { root: join(directory, 'sessions'), compression: 'none' }
      : id === 'web' ? { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }
        : id === 'controller' ? { nativeOpen: false } : {} }))))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('expected native Loader')
  const fixtureImport = async (specifier: string) => {
    const plugin = plugins[specifier.slice('feedback:'.length) as keyof typeof plugins]
    if (!plugin) throw Error('unknown fixture plugin')
    return typeof plugin === 'function' ? { default: plugin } : plugin
  }
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return fixtureImport
      const value: unknown = Reflect.get(target, key, target)
      const bound: unknown = typeof value === 'function' ? value.bind(target) : value
      return bound
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(directory, 'cordis.yml')).href } })
  await ctx.loader.await(); for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const adapter = new FeedbackAdapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('original-session'), { provider: 'fixture', model: 'selected' }, { cwd })
  const workspace = await ctx.workspaceRegistry.create(cwd); await workspace.attachSession(agent.id)
  const source = { workspace_id: workspace.id, session_id: agent.id, source_message_id: 'source-1', source_revision: '1', original_message: '@Guide 完成协作', active_mentions: [{ mention_id: 'mention-1', source_span: { source_message_id: 'source-1', source_revision: '1', start: 0, end: 6 }, display_snapshot: { agent_name: 'Guide', project_name: 'Slark' }, binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] }
  const signal = new AbortController().signal, controller = ctx.sessionController
  const captured = await controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source, continuation_policy: 'follow_authorized_plan' }, signal), root = captured.submission
  const target = { namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: workspace.id, session_id: agent.id, source_message_id: 'source-1', source_revision: '1' }
  await controller.acceptCollaborationRoot(target, { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'plan-1', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'task-1', task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const execution = await controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)
  await controller.collaborationRootExecution({ action: 'accept', target, selection, receipt: { execution_command_id: execution!.execution_command_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, root_revision: '1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', invocation_id: 'invocation-1', admission: 'recorded', max_invocations: 1, max_runtime_ms: 1000, expires_at: '2026-01-01T00:00:00.000Z' } }, signal)
  const answer = '协作已完成，结果 42'
  await controller.receiveCollaborationDelivery({ namespace_id: root.namespace_id, projection: { delivery_id: 'delivery-1', invocation_id: 'invocation-1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', source_locator: { workspace_id: workspace.id, session_id: agent.id, source_message_id: 'source-1', source_revision: '1' }, source_snapshot_digest: root.source_digest, execution_state: 'succeeded', invocation_state_version: '3', delivery_state: 'pending', delivery_state_version: '1', result_digest: collaborationJournalDigest({ state: 'succeeded', answer, failure_code: null }), target: { project_id: '212', agent_id: 'guide' }, target_display_snapshot: { project_name: 'Slark', agent_name: 'Guide' }, answer } }, signal)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port')
  const post = async (operation: unknown) => fetch(`http://127.0.0.1:${address.port}/internal/desktop-collaboration-analysis`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'root_feedback', binding_key: 'b'.repeat(64), operation }) })
  const query = { action: 'read', target, selection, delivery_id: 'delivery-1' }
  await controller.collaborationRootFeedback(query, signal)
  const beforeResponse = await post(query)
  expect(beforeResponse.status).toBe(200)
  const before = await beforeResponse.json() as { value: { event_count: number; log_digest: string } }
  const preparedResponse = await post({ ...query, action: 'consumer_prepare', expected_event_count: before.value.event_count, expected_log_digest: before.value.log_digest })
  expect(preparedResponse.status).toBe(200)
  type Consumer = Awaited<ReturnType<SessionController['collaborationRootConsumption']>>
  const prepared = await preparedResponse.json() as { value: Consumer }
  const record = prepared.value.record
  if (!record || record.state !== 'prepared') throw Error('consumer not prepared')
  const b = record.binding
  const business = { namespace_id:b.namespace_id,root_task_id:b.root_task_id,root_trace_id:b.root_trace_id,task_revision:1,
    execution_command_id:b.execution_command_id,delivery_id:b.delivery_id,result_digest:b.result_digest,message_id:b.message_id,
    session_id:b.source_locator.session_id,...record.command }
  const { namespace_id:_namespace,...wire }=business
  const grant={ ...wire,command_digest:collaborationJournalDigest(business),consumer_attempt_id:randomUUID(),consumer_step_id:randomUUID(),
    issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),dispatch_granted:true }
  const checkpoint = mode === 'checkpoint_failure' ? vi.spyOn(ctx.sessions,'flush').mockRejectedValueOnce(Error('checkpoint persistence failed')) : undefined
  const start = { ...query,action:'consumer_start',grant }
  const started = await post(start)
  expect(started.status).toBe(200)
  await started.body?.cancel() // Parent loses the reply after the Profile completes its durable operation.
  checkpoint?.mockRestore()
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(mode === 'success' ? 1 : 0)
  for(let n=0;n<20;n++) expect((await post(start)).status).toBe(200)
  expect(adapter.requests).toHaveLength(mode === 'success' ? 1 : 0)
  const read = await post({ ...query,action:'consumer_read' })
  expect(read.status).toBe(200)
  const consumed = await read.json() as { value:Consumer }
  expect(consumed.value.record?.state).toBe('consumed')
  expect(consumed.value.observation).toMatchObject({ status:'context_applied',continuation_observed:mode === 'success' })
  expect(consumed.value.record?.binding.root_trace_id).toBe(root.root_trace_id)
  if(mode === 'success') {
    expect(adapter.requests[0]?.traceparent).toMatch(new RegExp('^00-' + root.root_trace_id + '-[a-f0-9]{16}-01$'))
    expect(JSON.stringify(adapter.requests[0])).toContain(root.root_trace_id)
    expect(JSON.stringify(adapter.requests[0])).toContain(answer)
  }
  const handle=await ctx.sessionPersistence.open(agent.id,'read')
  try {
    const { events }=await handle.read()
    expect(events.filter(e=>e.type==='user/message' && e.data.id===b.message_id)).toHaveLength(1)
  } finally {await handle.close()}
})
