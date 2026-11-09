import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
/** REQ-20261004-0008: real Loader, AgentLoop, JSONL writer and private HTTP feedback path. */
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
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { randomUUID, createHash, generateKeyPairSync, sign } from 'node:crypto'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { parseHostOperationOriginObservation, parseHostOperationOriginAttribution, encodeHostOperationOriginObservation, encodeHostOperationOriginAttribution } from '@deepseek-ai/dsh-host-control-protocol'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installSessionReadTestServices } from '../../../api/session-controller/tests/test-remote.ts'
import * as WebApp from '../src/index.ts'

interface OriginJournalSnapshot {
  meta: Readonly<Record<string, unknown>>
  records: readonly Readonly<Record<string, unknown>>[]
  revisions: readonly Readonly<Record<string, unknown>>[]
  checkpoints: readonly Readonly<Record<string, unknown>>[]
}
interface ActualDsBotOriginObserver {
  settled(): Promise<void>
  readJournal(): OriginJournalSnapshot
  dispose(): Promise<void>
}

type OriginObserverOptions = {
  ctx: Context
  root: string
  profileId: string
  botId: string
  sessionId: string
  dsBotRoot: string
  dsBotCommit?: string
}

class FeedbackAdapter extends LlmAdapter {
  native = false
  readonly requests: GenerateOptions[] = []
  before: (options: GenerateOptions) => Promise<void> = async () => {}
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.before(options)
    if (this.native && this.requests.length === 1) {
      const block = { type: 'tool-call' as const, id: ToolCallId('original-native-call'), name: 'read_origin_fixture', arguments: '{}' }
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '已结合协作结果' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已结合协作结果' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
it.each(['success', 'checkpoint_failure', 'checkpoint_false', 'cancel', 'origin'] as const)('consumes a fresh grant once through the real Loader: %s', async (mode) => {
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
  const install = generateKeyPairSync('ed25519'), cloud = generateKeyPairSync('ed25519'), hostProfileId = randomUUID(), environmentId = randomUUID()
  const issuer = 'https://cloud.test', keyId = 'dsh-assertion-loader', now = Date.now()
  vi.stubEnv('DSH_PROFILE_ID', hostProfileId)
  vi.stubEnv('DSH_PROFILE_OPERATION_ORIGIN_KEYRINGS', JSON.stringify([{ version: 1, environmentId, issuer, keys: [{ kid: keyId,
    publicKeyPem: cloud.publicKey.export({ format: 'pem', type: 'spki' }).toString(), validFrom: now - 1000, validUntil: now + 240000 }] }]))
  ctx.provide('webServer', { host: '127.0.0.1', port: 0, register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
    routes.set(route.path, route.handler); return () => routes.delete(route.path)
  } } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} },
    resources: { register: () => () => {} } } as never)
  ctx.provide('typertGateway', { getPendingRemoteEvents: () => [] } as never)
  new RemoteAccessService(ctx)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'selected' }) } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  ctx.provide('fs', {} as never)
  installSessionReadTestServices(ctx)
  const plugins = { storage: Storage, sessions: SessionStore, persistence: JsonlPersistence, agents: AgentRegistry, llm: LlmRuntime,
    prompt: SystemPrompt, tools: Tools, executor: NativeToolExecutor, loop: AgentLoop,
    workspace: WorkspaceRegistry, controller: SessionController, web: WebApp,
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
  const adapter = new FeedbackAdapter(); adapter.native = mode === 'origin'; ctx.llm.registerAdapter(['fixture'], adapter)
  if (mode === 'origin') ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_origin_fixture', description: 'Read the local test fixture',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'PRIVATE_RESULT_BODY',
  })))
  const agent = await ctx.agentLoop.create(SessionId('original-session'), { provider: 'fixture', model: 'selected' }, { cwd })
  const workspace = await ctx.workspaceRegistry.create(cwd); await workspace.attachSession(agent.id)
  let actualDsBot: ActualDsBotOriginObserver | undefined
  const dsBotRoot = process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_ROOT
  if (mode === 'origin' && dsBotRoot) {
    const helper = await import(/* @vite-ignore */ new URL('./fixtures/dsbot-operation-origin.test-support.mjs', import.meta.url).href) as {
      attachDsBotOperationObserver(input: OriginObserverOptions):
      Promise<ActualDsBotOriginObserver>
    }
    actualDsBot = await helper.attachDsBotOperationObserver({ ctx, root: directory, profileId: hostProfileId,
      botId: 'original-bot', sessionId: agent.id, dsBotRoot,
      ...process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_COMMIT ? { dsBotCommit: process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_COMMIT } : {} })
    const owned = actualDsBot
    onTestFinished(() => owned.dispose())
  }
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
  expect(await controller.collaborationRootConsumption({ ...query, action: 'continuation_read' }, signal)).toEqual({ kind: 'continuation', commit: null })
  const beforeResponse = await post(query)
  expect(beforeResponse.status).toBe(200)
  const before = await beforeResponse.json() as { value: { event_count: number; log_digest: string } }
  const preparedResponse = await post({ ...query, action: 'consumer_prepare', expected_event_count: before.value.event_count, expected_log_digest: before.value.log_digest })
  expect(preparedResponse.status).toBe(200)
  type Consumer = Awaited<ReturnType<SessionController['collaborationRootConsumption']>>
  const prepared = await preparedResponse.json() as { value: Consumer }
  if (prepared.value.kind !== 'consumer') throw Error('unexpected observation')
  const record = prepared.value.record
  if (!record || record.state !== 'prepared') throw Error('consumer not prepared')
  const b = record.binding
  const business = { namespace_id:b.namespace_id,root_task_id:b.root_task_id,root_trace_id:b.root_trace_id,task_revision:1,
    execution_command_id:b.execution_command_id,delivery_id:b.delivery_id,result_digest:b.result_digest,message_id:b.message_id,
    session_id:b.source_locator.session_id,...record.command }
  const { namespace_id:_namespace,...wire }=business
  const grant={ ...wire,command_digest:collaborationJournalDigest(business),consumer_attempt_id:randomUUID(),consumer_step_id:randomUUID(),
    issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+60000).toISOString(),dispatch_granted:true }
  const checkpoint = mode === 'checkpoint_failure' ? vi.spyOn(ctx.sessions,'flush').mockRejectedValueOnce(Error('checkpoint persistence failed'))
    : mode === 'checkpoint_false' ? vi.spyOn(ctx.sessions,'flush').mockResolvedValueOnce(false) : undefined
  const start = { ...query,action:'consumer_start',grant }
  if (mode === 'cancel') {
    const parent = new AbortController(), entered = Promise.withResolvers<undefined>()
    onTestFinished(() => { parent.abort() })
    adapter.before = async (options) => {
      entered.resolve(undefined)
      const active = options.signal
      if (!active) throw Error('missing Provider cancellation')
      await new Promise<void>((resolve) => { active.addEventListener('abort', () => { resolve() }, { once: true }) })
      active.throwIfAborted()
    }
    const rejection = expect(controller.collaborationRootConsumption(start, parent.signal)).rejects.toThrow('parent-cancelled')
    await entered.promise
    parent.abort(Error('parent-cancelled'))
    await rejection
  } else {
    const started = await post(start)
    expect(started.status).toBe(200)
    await started.body?.cancel() // Parent loses the reply after the Profile completes its durable operation.
  }
  checkpoint?.mockRestore()
  await agent.whenIdle()
  await actualDsBot?.settled()
  expect(adapter.requests).toHaveLength(mode === 'origin' ? 2 : mode === 'success' || mode === 'cancel' ? 1 : 0)
  for(let n=0;n<20;n++) expect((await post(start)).status).toBe(200)
  expect(adapter.requests).toHaveLength(mode === 'origin' ? 2 : mode === 'success' || mode === 'cancel' ? 1 : 0)
  const read = await post({ ...query,action:'consumer_read' })
  expect(read.status).toBe(200)
  const consumed = await read.json() as { value:Consumer }
  if (consumed.value.kind !== 'consumer') throw Error('unexpected observation')
  expect(consumed.value.record?.state).toBe('consumed')
  expect(consumed.value.observation).toMatchObject({ status:'context_applied',continuation_observed:mode === 'success' || mode === 'origin' })
  expect(consumed.value.record?.binding.root_trace_id).toBe(root.root_trace_id)
  if(mode === 'success' || mode === 'origin') {
    expect(adapter.requests[0]?.traceparent).toMatch(new RegExp('^00-' + root.root_trace_id + '-[a-f0-9]{16}-01$'))
    expect(JSON.stringify(adapter.requests[0])).toContain(root.root_trace_id)
    expect(JSON.stringify(adapter.requests[0])).toContain(answer)
  }
  if (mode === 'cancel') {
    const failed = vi.spyOn(facility!, 'open').mockRejectedValueOnce(Error('observation_open_failed'))
    await expect(controller.collaborationRootConsumption({ ...query, action: 'continuation_read' }, signal)).rejects.toThrow('observation_open_failed')
    failed.mockRestore()
    return
  }
  const observation = await post({ ...query, action: 'continuation_read' })
  expect(observation.status).toBe(200)
  const observed = await observation.json() as { value: { kind: string
    commit: null | { observation_id: string; consumption: { root_trace_id: string } } } }
  expect(observed.value.kind).toBe('continuation')
  if (mode === 'success' || mode === 'origin') {
    expect(observed.value.commit?.consumption.root_trace_id).toBe(root.root_trace_id)
    const repeat = await post({ ...query, action: 'continuation_read' })
    expect(await repeat.json()).toEqual(observed)
  } else expect(observed.value.commit).toBeNull()
  expect(adapter.requests).toHaveLength(mode === 'origin' ? 2 : mode === 'success' ? 1 : 0)
  if (mode === 'origin') {
    const actualAccount = { authorityEnvironmentId: environmentId, accountIssuer: 'https://account.test', accountSubject: 'account',
      accountBindingId: 'host-alias', accountBindingVersion: 2, hostProfileId }
    const actualPeer = { installationId: randomUUID(), publicKey: (install.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url'),
      hostInstanceId: randomUUID(), processNonce: 'loader-process' }
    if (!actualDsBot) ctx.provide('dsBotSlarkExternalGroup', { describeLocalBotSession: ({ sessionId }: { sessionId: string }) => ({ sessionId, botId: 'original-bot' }) })
    const initialJournal = actualDsBot?.readJournal()
    if (initialJournal) {
      expect(initialJournal.records).toHaveLength(2); expect(initialJournal.revisions).toHaveLength(0)
      for (const row of initialJournal.records)
        expect(JSON.parse(String(row.record_json))).toMatchObject({ classification: { state: 'gap' } })
    }
    const origin = async (operation: unknown) => fetch(`http://127.0.0.1:${address.port}/internal/desktop-collaboration-analysis`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'root_operation_origin', binding_key: 'b'.repeat(64), operation, actualAccount, actualPeer }) })
    const read = await origin({ ...query, action: 'read', request_id: randomUUID(), nonce: 'a'.repeat(64), after_result_seq: null })
    expect(read.status).toBe(200)
    const readBody = await read.json() as { value: { observation: unknown; eof: boolean } }
    const unsigned = parseHostOperationOriginObservation(readBody.value.observation)
    const observation = { ...unsigned, signature: sign(null, Buffer.from(encodeHostOperationOriginObservation(unsigned)), install.privateKey).toString('base64url') }
    expect(observation.pairs).toHaveLength(1); expect(observation.pairs[0]!.toolName).toBe('read_origin_fixture')
    expect(JSON.stringify(readBody)).not.toContain('PRIVATE_RESULT_BODY')
    const binding = observation.binding, attribution = parseHostOperationOriginAttribution({ ...actualAccount, peer: actualPeer,
      botId: observation.botId, schemaVersion: 1, purpose: 'project_operation_origin_attribution', issuer, keyId,
      requestId: observation.requestId, nonce: observation.nonce, issuedAt: Date.now(), expiresAt: observation.expiresAt,
      observationDigest: createHash('sha256').update(encodeHostOperationOriginObservation(observation)).digest('hex'),
      admissionId: randomUUID(), consumptionId: observation.consumption.consumptionId, namespaceId: binding.namespaceId,
      rootTaskId: binding.rootTaskId, rootTraceId: binding.rootTraceId, executionCommandId: binding.executionCommandId,
      deliveryId: binding.deliveryId, invocationId: binding.invocationId, sourceDigest: binding.sourceDigest,
      ownerUserId: 'original-root-owner', projectId: '212', bindingId: randomUUID(), bindingGeneration: '1', scopeVersion: '1', signature: 'A'.repeat(86) })
    let captured: object | undefined
    ctx.on('project-operation/origin', async (token, signal) => {
      captured = token; signal.throwIfAborted()
      expect(ctx.get('projectOperationOrigins')?.read(token)).toMatchObject([{ botId: 'original-bot', ownerUserId: 'original-root-owner',
        projectId: '212', toolName: 'read_origin_fixture', rootRef: binding.rootTaskId }])
      return actualDsBot ? undefined : true
    }, { prepend: true })
    const bound = await origin({ ...query, action: 'bind', observation, attribution: { ...attribution,
      signature: sign(null, Buffer.from(encodeHostOperationOriginAttribution(attribution)), cloud.privateKey).toString('base64url') } })
    expect(bound.status).toBe(200); expect(await bound.json()).toEqual({ value: { published: true } })
    expect(captured).toBeDefined()
    expect(ctx.get('projectOperationOrigins')?.read(captured as import('@deepseek-ai/dsh-api-session-controller').ProjectOperationOriginToken)).toBeNull()
    expect(adapter.requests).toHaveLength(2)
    if (actualDsBot && initialJournal) {
      const revised = actualDsBot.readJournal()
      expect(revised.records).toEqual(initialJournal.records); expect(revised.checkpoints).toEqual(initialJournal.checkpoints)
      expect(revised.revisions).toHaveLength(2)
      for (const row of revised.revisions) {
        expect(row).toMatchObject({ source_revision: '2', record_state: 'reference' })
        expect(JSON.parse(String(row.record_json))).toMatchObject({ classification: {
          state: 'reference', initiatorRef: 'original-root-owner', projectId: '212', dependencyCoverage: 'unknown',
        } })
      }
      // Restart verification with fresh proof identity; unchanged original events retain the same journal revision.
      const freshRead = await origin({ ...query, action: 'read', request_id: randomUUID(), nonce: 'b'.repeat(64), after_result_seq: null })
      const freshBody = await freshRead.json() as { value: { observation: unknown } }
      const next = parseHostOperationOriginObservation(freshBody.value.observation)
      const freshObservation = { ...next, signature: sign(null, Buffer.from(encodeHostOperationOriginObservation(next)), install.privateKey).toString('base64url') }
      const freshClaim = { ...attribution, requestId: next.requestId, nonce: next.nonce, issuedAt: Date.now(), expiresAt: next.expiresAt,
        observationDigest: createHash('sha256').update(encodeHostOperationOriginObservation(freshObservation)).digest('hex') }
      const retry = await origin({ ...query, action: 'bind', observation: freshObservation, attribution: { ...freshClaim,
        signature: sign(null, Buffer.from(encodeHostOperationOriginAttribution(freshClaim)), cloud.privateKey).toString('base64url') } })
      expect(await retry.json()).toEqual({ value: { published: true } })
      expect(actualDsBot.readJournal()).toEqual(revised); expect(adapter.requests).toHaveLength(2)
    }
  }
  const handle=await ctx.sessionPersistence.open(agent.id,'read')
  try {
    const { events }=await handle.read()
    expect(events.filter(e=>e.type==='user/message' && e.data.id===b.message_id)).toHaveLength(1)
  } finally {await handle.close()}
  if (mode === 'origin') { await ctx.fiber.dispose(); expect(ctx.get('projectOperationOrigins')).toBeUndefined() }
})
