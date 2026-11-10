/** Actual Loader/SessionController/JSONL/private HTTP; auxiliary UI services, model and Cloud permits are controlled. */
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SessionController, { collaborationJournalDigest } from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import type { HostTaskCoordinationEnvironment } from '@deepseek-ai/dsh-host-control-protocol'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { onTestFinished, vi } from 'vitest'
import { installSessionReadTestServices } from '../../../api/session-controller/tests/test-remote.ts'
import * as WebApp from '../src/index.ts'

class TaskAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeResponse: (() => void) | undefined
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.beforeResponse?.()
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('actual-task-native'),
        name: 'task_fixture_effect', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
/** Create an actual original admitted Root, result and fresh prepared consumer without executing it.
 * @param options - Explicit public policy, actual parent Profile and controlled effect.
 * @returns Original records and the actual private HTTP endpoint; nothing mints a public execution token.
 */
export async function actualTaskLoader(options: { profileId: string
  workerId: string
  environment: HostTaskCoordinationEnvironment
  body(): Promise<string> }) {
  const directory = await mkdtemp(join(tmpdir(), 'req0006-task-consumer-')), cwd = await realpath(directory)
  const ctx = new Context(), token = 'B'.repeat(43)
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '')
    if (handler) void handler(req, res)
    else res.writeHead(404).end()
  })
  let facility: DomainFacility | undefined, backend: JsonStorageBackend | undefined
  onTestFinished(async () => {
    await ctx.fiber.dispose(); await facility?.closeAll(); await backend?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error); else resolve()
    }))
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true })
  })
  for (const name of ['DSH_PROFILE_SOURCE_TOKEN', 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN', 'DSH_PROFILE_MODEL_TOKEN',
    'DSH_PROFILE_REMOTE_SESSION_TOKEN', 'DSH_PROFILE_REMOTE_UI_TOKEN', 'DSH_PROFILE_DELIVERY_TOKEN']) vi.stubEnv(name, '')
  vi.stubEnv('DSH_PROFILE_OPERATION_ORIGIN_KEYRINGS', '[]')
  vi.stubEnv('DSH_PROFILE_PROJECT_OPERATION_MEMORY_ENVIRONMENTS', '[]')
  vi.stubEnv('DSH_PROFILE_ANALYSIS_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_ID', options.profileId)
  vi.stubEnv('DSH_PROFILE_WORKER_ID', options.workerId)
  vi.stubEnv('DSH_PROFILE_TASK_COORDINATION_ENVIRONMENTS', JSON.stringify([options.environment]))
  ctx.provide('webServer', { host: '127.0.0.1', port: 0,
    register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
      routes.set(route.path, route.handler); return () => routes.delete(route.path)
    } } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} },
    resources: { register: () => () => {} } } as never)
  ctx.provide('typertGateway', { getPendingRemoteEvents: () => [] } as never)
  new RemoteAccessService(ctx)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'selected' }) } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
    maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  ctx.provide('fs', {} as never)
  installSessionReadTestServices(ctx)
  const plugins = { storage: Storage, sessions: SessionStore, persistence: JsonlPersistence, agents: AgentRegistry, llm: LlmRuntime,
    prompt: SystemPrompt, tools: Tools, executor: NativeToolExecutor, loop: AgentLoop, workspace: WorkspaceRegistry,
    controller: SessionController, web: WebApp,
    domain: { name: 'task-domain', inject: ['storage'], apply(c: Context) {
      backend = new JsonStorageBackend(join(directory, 'state')); c.storage.backend.register('json', backend)
      facility = new DomainFacility(c, { backend: 'json' }); c.storage.mount('domain', facility); c.provide('storageDomain', facility)
    } } }
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `task:${id}`,
    config: id === 'persistence' ? { root: join(directory, 'sessions'), compression: 'none' }
      : id === 'web' ? { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }
        : id === 'controller' ? { nativeOpen: false } : {} }))))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('missing actual Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key): unknown {
    if (key === 'import') return async (specifier: string) => {
      const plugin = plugins[specifier.slice('task:'.length) as keyof typeof plugins]
      if (!plugin) throw Error('unknown task fixture plugin')
      return typeof plugin === 'function' ? { default: plugin } : plugin
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(directory, 'cordis.yml')).href } })
  await ctx.loader.await(); for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const adapter = new TaskAdapter(); ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'task_fixture_effect', description: 'Perform the isolated task effect',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => options.body() })))
  const agent = await ctx.agentLoop.create(SessionId('actual-original-task'), { provider: 'fixture', model: 'selected' }, { cwd })
  const workspace = await ctx.workspaceRegistry.create(cwd); await workspace.attachSession(agent.id)
  ctx.provide('dsBotSlarkExternalGroup', { describeLocalBotSession: ({ sessionId }: { sessionId: string }) =>
    sessionId === agent.id ? { sessionId, botId: 'fixture-bot' } : null })
  const source = { workspace_id: workspace.id, session_id: agent.id, source_message_id: 'actual-source', source_revision: '1',
    original_message: '@Guide isolated original task', active_mentions: [{ mention_id: 'fixture-mention',
      source_span: { source_message_id: 'actual-source', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'Slark' }, binding: { kind: 'resolved' as const,
        target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] }
  const signal = new AbortController().signal, controller = ctx.sessionController
  const captured = await controller.captureCollaborationRoot({ namespace_id: 'n2_' + 'a'.repeat(64), source,
      continuation_policy: 'follow_authorized_plan' }, signal), root = captured.submission
  const target = { namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: workspace.id,
    session_id: agent.id, source_message_id: source.source_message_id, source_revision: '1' }
  await controller.acceptCollaborationRoot(target, { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, signal)
  const selection = { plan_id: 'plan-1', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64), task_id: 'task-1',
    task_revision: '1', task_digest: 'd'.repeat(64), expected_scope_version: '0' }
  const prepared = await controller.collaborationRootExecution({ action: 'prepare', target, selection }, signal)
  if (!prepared) throw Error('missing actual prepared command')
  const execution = await controller.collaborationRootExecution({ action: 'accept', target, selection, receipt: {
    execution_command_id: prepared.execution_command_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
    root_revision: '1', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', invocation_id: 'actual-invocation',
    admission: 'recorded', max_invocations: 1, max_runtime_ms: 1000, expires_at: new Date(Date.now() + 1200000).toISOString() } }, signal)
  if (!execution || execution.state !== 'admitted') throw Error('missing actual admitted command')
  const answer = 'isolated result'
  await controller.receiveCollaborationDelivery({ namespace_id: root.namespace_id, projection: { delivery_id: 'actual-delivery',
    invocation_id: 'actual-invocation', plan_id: 'plan-1', task_id: 'task-1', task_revision: '1', source_locator: { workspace_id: source.workspace_id, session_id: source.session_id,
      source_message_id: source.source_message_id, source_revision: source.source_revision },
    source_snapshot_digest: root.source_digest, execution_state: 'succeeded', invocation_state_version: '3', delivery_state: 'pending',
    delivery_state_version: '1', result_digest: collaborationJournalDigest({ state: 'succeeded', answer, failure_code: null }),
    target: { project_id: '212', agent_id: 'guide' }, target_display_snapshot: { project_name: 'Slark', agent_name: 'Guide' }, answer } }, signal)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing loopback address')
  const execute = async (command: unknown, owned: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/desktop-collaboration-analysis`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(command), signal: owned })
    if (!response.ok) throw Error('actual private request failed: ' + String(response.status))
    const value = await response.json() as { value: unknown }
    return value.value
  }
  const query = { action: 'read', target, selection, delivery_id: 'actual-delivery' }
  const observed = await controller.collaborationRootFeedback(query, signal)
  const consumer = await controller.collaborationRootConsumption({ ...query, action: 'consumer_prepare',
    expected_event_count: observed.event_count, expected_log_digest: observed.log_digest }, signal)
  if (consumer.kind !== 'consumer' || consumer.record?.state !== 'prepared') throw Error('consumer not prepared')
  const record = consumer.record, b = record.binding
  const business = { namespace_id: b.namespace_id, root_task_id: b.root_task_id, root_trace_id: b.root_trace_id, task_revision: 1,
    execution_command_id: b.execution_command_id, delivery_id: b.delivery_id, result_digest: b.result_digest, message_id: b.message_id,
    session_id: b.source_locator.session_id, ...record.command }
  const { namespace_id: _namespace, ...wire } = business
  const grant = { ...wire, command_digest: collaborationJournalDigest(business), consumer_attempt_id: randomUUID(),
    consumer_step_id: randomUUID(), issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(), dispatch_granted: true }
  return { ctx, controller, agent, workspace, root, target, selection, execution, record, adapter, directory,
    start: { ...query, action: 'consumer_start', grant }, execute }
}
