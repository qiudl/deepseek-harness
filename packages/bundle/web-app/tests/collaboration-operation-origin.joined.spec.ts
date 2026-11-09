import { DatabaseSync } from 'node:sqlite'
import { ProjectOperationMemoryDatabase } from '../../../host/desktop-host/src/project-operation-memory-database.ts'
import { ProjectOperationMemoryDatabaseFiles } from '../../../host/desktop-host/src/project-operation-memory-database-files.ts'
/** REQ-20261031-0006: explicit opt-in composition of actual Host, Cloud PostgreSQL and DSBot owners. */
import { fork } from 'node:child_process'
import { createPrivateKey, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationExecutionSelection } from '@deepseek-ai/dsh-api-session-controller'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { decodeHostControlFrame, encodeHostControlFrame, parseHostOperationOriginObservation,
  parseHostBotGroupPublicKeyring, parseHostBotIdentity, parseHostTwinBindingInput, parseHostProjectMemoryRequest,
  parseHostProjectMemoryEnvironment } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRemoteSessionJson, HostOperationOriginAttribution } from '@deepseek-ai/dsh-host-control-protocol'
import { ProjectOperationMemoryMetadata } from '../../../host/desktop-host/src/project-operation-memory-metadata.ts'
import { ProjectOperationMemorySourceExports } from '../../../host/desktop-host/src/project-operation-memory-source-exports.ts'
import { TwinBindingReceipts } from '../../../host/desktop-host/src/twin-binding-receipts.ts'
import { createPosixTwinBindingReceiptFile } from '../../../host/desktop-host/src/twin-binding-receipt-files.ts'
import { DesktopHost } from '../../../host/desktop-host/src/desktop-host.ts'
import { ProfileRegistry } from '../../../host/desktop-host/src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../../../host/desktop-host/src/unix-transport.ts'
import { installSessionReadTestServices } from '../../../api/session-controller/tests/test-remote.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as WebApp from '../src/index.ts'

const memoryComposition = process.env.DSH_TEST_OPERATION_MEMORY_JOINED === '1'
const memoryConsumer = memoryComposition && process.env.DSH_TEST_OPERATION_MEMORY_CONSUMER_JOINED === '1'
const cloudPath = process.env.DSH_TEST_OPERATION_ORIGIN_CLOUD_BRIDGE
const cloudNode = process.env.DSH_TEST_OPERATION_ORIGIN_CLOUD_NODE
const cloudRoot = process.env.DSH_TEST_OPERATION_ORIGIN_CLOUD_ROOT
const dsBotRoot = process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_ROOT

type ActualAccount = {
  authorityEnvironmentId: string
  accountIssuer: string
  accountSubject: string
  accountBindingId: string
  accountBindingVersion: number
}
type ActualPeer = { installationId: string; publicKey: string; hostInstanceId: string; processNonce: string }
type BridgeIdentity = {
  actualAccount: ActualAccount
  actualPeer: ActualPeer
  installationPrivateKeyPem: string
  keyring?: unknown
  botId?: string
  ownerUserId?: string
  projectId?: string
  twinAgentId?: string
}
type BridgeMetadata = BridgeIdentity & {
  keyring: unknown
  groupId: string
  groupVersion: number
  botId: string
  ownerUserId: string
  projectId: string
  twinAgentId: string
}
type Journal = {
  records: readonly Record<string, unknown>[]
  revisions: readonly Record<string, unknown>[]
  checkpoints: readonly Record<string, unknown>[]
  meta: Readonly<Record<string, unknown>>
}
type MemoryPlan = {
  id: string
  source_version: string
  journal_epoch: string
  through_sequence: string
  sync_start_sequence: string
  initial_result: { activationSequence: string }
}
type MemoryDelivery = {
  id: string
  from_sequence: string
  to_sequence: string
  events: readonly {
    sourcePolicy: string
    content: unknown
    sourceRevision: string
    taskRef: string
    invocationRef: string
    sourceLocator: object | null
  }[]
  read_envelope: { result: { checkpoint: object }; sourceProof: { sourceAuthorityVersion: string } }
}
type Observer = { settled(): Promise<void>; readJournal(): Journal; dispose(): Promise<void> }

type OriginObserverOptions = {
  ctx: Context
  root: string
  profileId: string
  botId: string
  sessionId: string
  dsBotRoot: string
  dsBotCommit?: string
}

class JoinedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('original-native-call'),
        name: 'read_origin_fixture', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Original native operation complete.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(!cloudPath || !cloudNode || !cloudRoot || !dsBotRoot)(
  'joins actual original Root admission, consumption, Host signing, Cloud claim and atomic DSBot references' + (memoryComposition ? ' with source memory delivery' : ''), async () => {
    if (!cloudPath || !cloudNode || !cloudRoot || !dsBotRoot) throw Error('joined_fixture_paths_required')
    const root = await mkdtemp(join(tmpdir(), 'req0006-origin-joined-')), cwd = await realpath(root), ctx = new Context()
    const child = fork(cloudPath, [], { execPath: cloudNode, cwd: cloudRoot, execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let diagnostics = '', counter = 0
    const acquired: {
      observer?: Observer
      client?: UnixHostClient
      cloudInitialized?: boolean
      database?: ProjectOperationMemoryDatabase
    } = {}
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
    const collect = (value: Buffer) => { diagnostics = (diagnostics + value.toString('utf8')).slice(-16384) }
    child.stdout?.on('data', collect); child.stderr?.on('data', collect)
    const hostCall = async (method: string, params: unknown): Promise<unknown> => {
      const client = acquired.client
      if (!client) throw Error('joined_host_client_not_ready')
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw Error('joined_host_call_invalid')
      const input = params as Omit<Parameters<UnixHostClient['operateProjectOperationMemory']>[0], 'request'> & { request: unknown; input?: unknown }
      if (method === 'host_bot_identity') return client.resolveBotIdentityV2(params as Parameters<UnixHostClient['resolveBotIdentityV2']>[0])
      if (method === 'host_twin_binding') return client.operateTwinBinding({ ...input, input: parseHostTwinBindingInput(input.input ?? input.request) })
      if (method === 'host_memory') return client.operateProjectOperationMemory({ ...input, request: parseHostProjectMemoryRequest(input.request) })
      throw Error('joined_host_method_invalid')
    }
    child.on('message', (value: unknown) => {
      if (value && typeof value === 'object' && 'host_call_id' in value && typeof value.host_call_id === 'string') {
        const id = value.host_call_id
        void (async () => {
          if (!('method' in value) || typeof value.method !== 'string' || !('params' in value)) throw Error('host_bridge_not_ready')
          return hostCall(value.method, value.params)
        })().then((result) => { child.send({ host_call_id: id, result }) }, (error: unknown) => {
          child.send({ host_call_id: id, error: error instanceof Error ? error.message : 'host_bridge_request_failed' })
        })
        return
      }
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number') return
      const entry = pending.get(value.id)
      if (!entry) return
      pending.delete(value.id)
      if ('error' in value) entry.reject(Error(String(value.error)))
      else if ('result' in value) entry.resolve(value.result)
      else entry.reject(Error('invalid_cloud_bridge_response'))
    })
    child.once('exit', (code) => {
      for (const entry of pending.values()) entry.reject(Error('cloud_bridge_exit_' + String(code) + ':' + diagnostics))
      pending.clear()
    })
    const call = async <T>(method: string, params: unknown = {}): Promise<T> => {
      const id = ++counter
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('cloud_bridge_timeout_' + method + ':' + diagnostics)) }, 30000)
        pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) } })
        child.send({ id, method, params })
      })
      return result as T
    }
    let facility: DomainFacility | undefined, backend: JsonStorageBackend | undefined
    const token = 'B'.repeat(43), routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
    const server = createServer((req, res) => {
      const handler = routes.get(req.url ?? '')
      if (handler) void handler(req, res); else res.writeHead(404).end()
    })
    onTestFinished(async () => {
      acquired.client?.close(); await acquired.observer?.dispose(); await ctx.fiber.dispose()
      await facility?.closeAll(); await backend?.close(); await acquired.database?.close()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error) reject(error); else resolve()
      }))
      if (child.connected) { if (acquired.cloudInitialized) await call('close'); child.disconnect() }
      if (child.exitCode === null) child.kill('SIGTERM')
      vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
    })
    for (const name of ['DSH_PROFILE_SOURCE_TOKEN', 'DSH_PROFILE_WORKSPACE_MODEL_TOKEN', 'DSH_PROFILE_MODEL_TOKEN',
      'DSH_PROFILE_REMOTE_SESSION_TOKEN', 'DSH_PROFILE_REMOTE_UI_TOKEN', 'DSH_PROFILE_DELIVERY_TOKEN']) vi.stubEnv(name, '')
    ctx.provide('webServer', { host: '127.0.0.1', port: 0, register(route: { path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
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
    const plugins = { storage: Storage, sessions: SessionStore, persistence: JsonlPersistence, agents: AgentRegistry,
      llm: LlmRuntime, prompt: SystemPrompt, tools: Tools, executor: NativeToolExecutor, loop: AgentLoop,
      workspace: WorkspaceRegistry, controller: SessionController, web: WebApp,
      domain: { name: 'joined-domain', inject: ['storage'], apply(c: Context) {
        backend = new JsonStorageBackend(join(root, 'state')); c.storage.backend.register('json', backend)
        facility = new DomainFacility(c, { backend: 'json' }); c.storage.mount('domain', facility); c.provide('storageDomain', facility)
      } } }
    await writeFile(join(root, 'cordis.yml'), JSON.stringify(Object.keys(plugins).filter(id => id !== 'web').map(id => ({
      id, name: `joined:${id}`, config: id === 'persistence' ? { root: join(root, 'sessions'), compression: 'none' }
        : id === 'controller' ? { nativeOpen: false } : {},
    }))))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const internal = ctx.loader.internal
    if (!internal) throw Error('joined_loader_unavailable')
    ctx.loader.internal = new Proxy(internal, {
      get(target, key) {
        if (key === 'import') return async (specifier: string) => {
          const plugin = plugins[specifier.slice('joined:'.length) as keyof typeof plugins]
          if (!plugin) throw Error('unknown_joined_plugin')
          return typeof plugin === 'function' ? { default: plugin } : plugin
        }
        const value: unknown = Reflect.get(target, key, target)
        const bound: unknown = typeof value === 'function' ? value.bind(target) : value
        return bound
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await ctx.loader.await(); for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const model = new JoinedModel(); ctx.llm.registerAdapter(['fixture'], model)
    await writeFile(join(root, 'native-fixture.txt'), 'PRIVATE_RESULT_BODY', { mode: 0o600 })
    let executions = 0
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_origin_fixture', description: 'Read the owned fixture file',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { executions++; return readFile(join(root, 'native-fixture.txt'), 'utf8') },
    })))
    const agent = await ctx.agentLoop.create(SessionId('original-session'), { provider: 'fixture', model: 'selected' }, { cwd })
    const workspace = await ctx.workspaceRegistry.create(cwd); await workspace.attachSession(agent.id)
    const identity = await call<BridgeIdentity>('identity_prepare', { federatedHost: true,
      ...(memoryConsumer ? { memoryConsumer: true } : {}) })
    const account = { issuer: identity.actualAccount.accountIssuer, subject: identity.actualAccount.accountSubject,
      authorityEnvironmentId: identity.actualAccount.authorityEnvironmentId, accountBindingHandle: identity.actualAccount.accountBindingId,
      authorityBindingVersion: identity.actualAccount.accountBindingVersion, keyHandle: 'joined:key',
      unlockMaterial: Buffer.alloc(32, 7).toString('base64url') }
    const registryRoot = join(root, 'registry'); await mkdir(registryRoot, { mode: 0o700 })
    const registry = new ProfileRegistry({ root: registryRoot, deviceIndexKey: Buffer.alloc(32, 8), clock: { now: Date.now } })
    const profile = await registry.registerAccount(account)
    const initialized = memoryComposition ? null : await call<BridgeMetadata>('init', { workspaceId: workspace.id, sessionId: agent.id,
      hostProfileId: profile.profileId, federatedHost: true })
    if (initialized) acquired.cloudInitialized = true
    const keyring = parseHostBotGroupPublicKeyring(initialized?.keyring ?? identity.keyring)
    const botId = initialized?.botId ?? identity.botId
    if (!botId) throw Error('joined_actual_bot_identity_missing')
    const policy = parseHostProjectMemoryEnvironment({ audience: 'urn:slark:project-memory:v1', environmentKey: 'staging', keyring })
    if (memoryComposition) {
      vi.stubEnv('DSH_PROFILE_PROJECT_OPERATION_MEMORY_ENVIRONMENTS', JSON.stringify([policy]))
      vi.stubEnv('DSH_PROFILE_SOURCE_TOKEN', token)
    }
    vi.stubEnv('DSH_PROFILE_ID', profile.profileId); vi.stubEnv('DSH_PROFILE_ANALYSIS_TOKEN', token)
    vi.stubEnv('DSH_PROFILE_OPERATION_ORIGIN_KEYRINGS', JSON.stringify([keyring]))
    await ctx.loader.create({ name: 'joined:web', config: {
      openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [],
    } })
    await ctx.loader.await(); for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const dsBot = await import(/* @vite-ignore */ new URL('./fixtures/dsbot-operation-origin.test-support.mjs', import.meta.url).href) as {
      attachDsBotOperationObserver(input: OriginObserverOptions): Promise<Observer>
    }
    const observer = await dsBot.attachDsBotOperationObserver({ ctx, root, profileId: profile.profileId,
      botId, sessionId: agent.id, dsBotRoot,
      ...process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_COMMIT ? { dsBotCommit: process.env.DSH_TEST_OPERATION_ORIGIN_DSBOT_COMMIT } : {} })
    acquired.observer = observer
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw Error('joined_server_unavailable')
    const host = new DesktopHost({ registry, clock: { now: Date.now }, runtimeGeneration: 1,
      ensureProfileWorker: async () => undefined,
      verifyAccountAccessToken: (access) => {
        if (access !== 'joined-current-account') throw Error('invalid_current_account')
        return { issuer: account.issuer, subject: account.subject }
      } })
    const peer = identity.actualPeer, installationPrivateKey = createPrivateKey(identity.installationPrivateKeyPem)
    const uid = process.getuid?.(); if (uid === undefined) throw Error('joined_posix_owner_missing')
    const privateFile = (name: string) => createPosixTwinBindingReceiptFile(join(root, name), uid)
    const databaseFiles = memoryComposition ? await ProjectOperationMemoryDatabaseFiles.posix({ root: join(root, 'memory-sqlite'), legacyRoots: [],
      profileId: profile.profileId, installationId: peer.installationId, publicKey: peer.publicKey,
      uid, pid: process.pid, processNonce: randomUUID() }) : undefined
    const database = databaseFiles ? await ProjectOperationMemoryDatabase.open(databaseFiles) : undefined
    if (database) acquired.database = database
    const memoryMetadata = () => {
      if (!database) throw Error('joined_actual_database_missing')
      return new ProjectOperationMemoryMetadata({ profileId: profile.profileId, installationId: peer.installationId,
        publicKey: peer.publicKey, database })
    }
    const sourceExports = () => {
      if (!database) throw Error('joined_actual_database_missing')
      return new ProjectOperationMemorySourceExports({ profileId: profile.profileId, installationId: peer.installationId,
        publicKey: peer.publicKey, database, environments: [policy] })
    }
    const authority = new HostControlAuthority({ host, now: Date.now, diagnostics: { record(event) { console.error('joined control rejection', event) } }, identity: {
      installationId: peer.installationId, installationPublicKey: peer.publicKey, hostInstanceId: peer.hostInstanceId,
      processNonce: peer.processNonce, installationPrivateKey, executableSignatureDigest: 'a'.repeat(64), runtimeGeneration: 1, schemaGeneration: 1,
    }, ...(memoryComposition ? {
      trustedBotGroupKeyrings: [keyring], projectOperationMemoryEnvironments: [policy],
      createProjectOperationMemoryMetadata: memoryMetadata,
      createProjectOperationMemorySourceExports: sourceExports,
      createTwinBindingReceiptStore: () => new TwinBindingReceipts({ profileId: profile.profileId, installationId: peer.installationId, publicKey: peer.publicKey, file: privateFile('twin-receipts') }),
      resolveBotIdentity: async (selected: string, requested: string, signal: AbortSignal) => {
        expect(selected).toBe(profile.profileId)
        const response = await fetch(`http://127.0.0.1:${address.port}/internal/desktop-bot-identity`, { method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ bot_id: requested }), signal })
        if (!response.ok) throw Error('joined_actual_bot_read_failed_' + String(response.status))
        return parseHostBotIdentity(await response.json())
      },
    } : {}), profilePersistenceGeneration: () => 1, rootFeedbackSupported: true, projectOperationOriginSupported: true,
    collaborationAnalysis: async (selectedProfile, command, signal) => {
      expect(selectedProfile).toBe(profile.profileId)
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/desktop-collaboration-analysis`, { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(command), signal })
      if (!response.ok) throw Error('joined_worker_response_' + String(response.status))
      const result = await response.json() as { value: HostRemoteSessionJson }
      return result.value
    } })
    const ownerId = randomUUID(), lifetime = new AbortController(), connection = authority.openSession(ownerId, lifetime.signal)
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: peer.installationId,
      trustedInstallationPublicKey: peer.publicKey, trustedExecutableSignatureDigest: 'a'.repeat(64), now: Date.now }, {
      call: async frame => decodeHostControlFrame(encodeHostControlFrame(await connection.handleRequest(
        decodeHostControlFrame(encodeHostControlFrame(frame))))),
      isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); connection.close() },
    })
    acquired.client = client
    await host.ensureAccountProfile({ ...account, accountAccessToken: 'joined-current-account', ownerId })
    if (memoryComposition) expect(await client.resolveBotIdentityV2({ ...account, botId }))
      .toMatchObject({ bot_id: botId, host_profile_id: profile.profileId })
    const metadata = initialized ?? await call<BridgeMetadata>('init', { workspaceId: workspace.id, sessionId: agent.id,
      hostProfileId: profile.profileId, federatedHost: true })
    acquired.cloudInitialized = true
    expect(metadata.actualAccount).toMatchObject(identity.actualAccount); expect(metadata.actualPeer).toEqual(identity.actualPeer)
    const signal = new AbortController().signal, controller = ctx.sessionController
    const originalHistory = memoryComposition ? await call<MemoryPlan>('memory_prepare', { requestId: randomUUID(), mode: 'history' }) : null
    if (originalHistory) expect(originalHistory.through_sequence).toBe('0')
    const preparedSource = await call<{ input: Parameters<SessionController['captureCollaborationGroupRoot']>[0]; namespaceId: string }>('source_prepare')
    await ctx.workspaceRegistry.installGroupInputFence({ workspaceId: workspace.id, sessionId: agent.id,
      groupId: metadata.groupId, groupVersion: metadata.groupVersion })
    const captured = await controller.captureCollaborationGroupRoot(preparedSource.input, signal), submission = captured.submission
    const target = { namespace_id: submission.namespace_id, command_id: submission.command_id,
      workspace_id: submission.source.workspace_id, session_id: submission.source.session_id,
      source_message_id: submission.source.source_message_id, source_revision: submission.source.source_revision }
    const admitted = await call<{ receipt: unknown }>('root_admit', { submission })
    await controller.acceptCollaborationRoot(target, admitted.receipt, signal)
    const planning = await call<{ selection: CollaborationExecutionSelection }>('plan_prepare')
    const execution = await controller.collaborationRootExecution({ action: 'prepare', target, selection: planning.selection }, signal)
    expect(execution).not.toBeNull()
    const executionReceipt = await call('execution_admit', { executionCommandId: execution?.execution_command_id })
    await controller.collaborationRootExecution({ action: 'accept', target, selection: planning.selection, receipt: executionReceipt }, signal)
    const delivery = await call<{ delivery_id: string }>('delivery')
    await controller.receiveCollaborationDelivery({ namespace_id: submission.namespace_id, projection: delivery }, signal)
    const query = { target, selection: planning.selection, delivery_id: delivery.delivery_id }
    const before = await controller.collaborationRootFeedback({ ...query, action: 'read' }, signal)
    const prepared = await controller.collaborationRootConsumption({ ...query, action: 'consumer_prepare',
      expected_event_count: before.event_count, expected_log_digest: before.log_digest }, signal)
    if (prepared.kind !== 'consumer' || !prepared.record) throw Error('joined_consumer_prepare')
    const grant = await call('consumption_prepare', { command: prepared.record.command })
    await controller.collaborationRootConsumption({ ...query, action: 'consumer_start', grant }, signal)
    await agent.whenIdle(); await observer.settled()
    const consumption = await client.collaborationAnalysis({ ...account,
      command: { action: 'root_feedback', operation: { ...query, action: 'consumer_read' } } })
    if (consumption.kind !== 'root_feedback' || !consumption.record || typeof consumption.record !== 'object'
      || !('receipt' in consumption.record)) throw Error('joined_signed_consumption_missing')
    await call('consumption_ack', { receipt: consumption.record.receipt })
    const gaps = observer.readJournal(); expect(gaps.records).toHaveLength(2); expect(gaps.revisions).toHaveLength(0)
    const read = await client.collaborationAnalysis({ ...account, command: { action: 'root_operation_origin',
      operation: { ...query, action: 'read', request_id: randomUUID(), nonce: 'a'.repeat(64), after_result_seq: null } } })
    if (read.kind !== 'root_operation_origin' || !read.record || typeof read.record !== 'object' || !('observation' in read.record))
      throw Error('joined_signed_observation_missing')
    const observation = parseHostOperationOriginObservation(read.record.observation)
    expect(observation.pairs).toHaveLength(1); expect(JSON.stringify(observation)).not.toContain('PRIVATE_RESULT_BODY')
    const attribution = await call<HostOperationOriginAttribution>('attribute', { observation })
    expect(attribution.ownerUserId).toBe(metadata.ownerUserId); expect(attribution.projectId).toBe(metadata.projectId)
    const bound = await client.collaborationAnalysis({ ...account, command: { action: 'root_operation_origin',
      operation: { ...query, action: 'bind', observation, attribution } } })
    expect(bound).toEqual({ kind: 'root_operation_origin', record: { published: true } })
    const references = observer.readJournal()
    expect(references.records).toEqual(gaps.records); expect(references.checkpoints).toEqual(gaps.checkpoints)
    expect(references.revisions).toHaveLength(2)
    for (const revision of references.revisions) {
      expect(revision).toMatchObject({ source_revision: '2', record_state: 'reference' })
      expect(JSON.parse(String(revision.record_json))).toMatchObject({ classification: { state: 'reference',
        initiatorRef: metadata.ownerUserId, projectId: metadata.projectId, dependencyCoverage: 'unknown' } })
    }
    await expect(client.collaborationAnalysis({ ...account, command: { action: 'root_operation_origin',
      operation: { ...query, action: 'bind', observation, attribution } } })).rejects.toThrow()
    expect(observer.readJournal()).toEqual(references)
    const freshRead = await client.collaborationAnalysis({ ...account, command: { action: 'root_operation_origin',
      operation: { ...query, action: 'read', request_id: randomUUID(), nonce: 'b'.repeat(64), after_result_seq: null } } })
    if (freshRead.kind !== 'root_operation_origin' || !freshRead.record || typeof freshRead.record !== 'object'
      || !('observation' in freshRead.record)) throw Error('joined_fresh_observation_missing')
    const freshObservation = parseHostOperationOriginObservation(freshRead.record.observation)
    const freshClaim = await call<HostOperationOriginAttribution>('attribute', { observation: freshObservation })
    expect(await client.collaborationAnalysis({ ...account, command: { action: 'root_operation_origin',
      operation: { ...query, action: 'bind', observation: freshObservation, attribution: freshClaim } } }))
      .toEqual({ kind: 'root_operation_origin', record: { published: true } })
    expect(observer.readJournal()).toEqual(references)
    expect(executions).toBe(1); expect(model.requests).toHaveLength(2)
    if (memoryComposition && originalHistory) {
      // The snapshot made before the real native operation never expands to include its later origin revision.
      const historical = await call<MemoryDelivery>('memory_page', { planId: originalHistory.id, deliveryId: randomUUID(),
        batchId: randomUUID(), pageSize: 50, maxBytes: 24576 })
      expect(historical.events).toHaveLength(0); expect(historical.from_sequence).toBe('0'); expect(historical.to_sequence).toBe('0')
      await call('memory_complete', { deliveryId: historical.id })
      const plan = await call<MemoryPlan>('memory_prepare', { requestId: randomUUID(), mode: 'delta' })
      expect(plan.sync_start_sequence).toBe('0')
      const delivery = await call<MemoryDelivery>('memory_page', { planId: plan.id, deliveryId: randomUUID(),
        batchId: randomUUID(), pageSize: 50, maxBytes: 24576 })
      expect(delivery.events).toHaveLength(2)
      for (const event of delivery.events) expect(event).toMatchObject({ sourcePolicy: 'live_reference_v1', content: null,
        sourceRevision: '2', taskRef: submission.root_task_id, invocationRef: executionReceipt && typeof executionReceipt === 'object'
          && 'invocation_id' in executionReceipt ? executionReceipt.invocation_id : 'missing-original-invocation' })
      expect(delivery.read_envelope.sourceProof.sourceAuthorityVersion).toBe(plan.source_version)
      if (!databaseFiles) throw Error('joined_actual_database_missing')
      const readonlyDatabase = new DatabaseSync(databaseFiles.path, { readOnly: true })
      const row = readonlyDatabase.prepare("SELECT payload FROM memory_records WHERE kind='published' AND json_extract(payload,'$.checkpoint.sequence')=?").get(delivery.to_sequence)
      readonlyDatabase.close()
      const manifest = row && typeof row.payload === 'string' ? JSON.parse(row.payload) as { previousCheckpoint: { sequence: string } } : undefined
      expect(manifest?.previousCheckpoint.sequence).toBe(delivery.from_sequence)
      const receipt = await call('memory_complete', { deliveryId: delivery.id })
      expect(receipt).toMatchObject({ stage: 'delivery_committed', checkpoint: delivery.read_envelope.result.checkpoint })
      expect(await call('memory_complete', { deliveryId: delivery.id })).toEqual(receipt)
      const next = await call<MemoryPlan>('memory_prepare', { requestId: randomUUID(), mode: 'delta' })
      expect(next.sync_start_sequence).toBe(delivery.to_sequence)
      expect(next.initial_result.activationSequence).toBe(originalHistory.initial_result.activationSequence)
      const empty = await call<MemoryDelivery>('memory_page', { planId: next.id, deliveryId: randomUUID(),
        batchId: randomUUID(), pageSize: 50, maxBytes: 24576 })
      expect(empty.events).toHaveLength(0); expect(empty.from_sequence).toBe(delivery.to_sequence)
      expect(empty.to_sequence).toBe(delivery.to_sequence)
      await call('memory_complete', { deliveryId: empty.id })
      const counts = await call<Record<string, number>>('memory_counts')
      expect(counts.dsh_memory_references).toBe(2); expect(counts.dsh_project_operation_materials).toBe(0)
      expect(executions).toBe(1); expect(model.requests).toHaveLength(2)
      expect(observer.readJournal()).toEqual(references)
      const readonlyMetadata = new DatabaseSync(databaseFiles.path, { readOnly: true })
      const rows = readonlyMetadata.prepare("SELECT payload FROM memory_records WHERE kind='delivery'").all()
      readonlyMetadata.close()
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_RESULT_BODY')
      console.info('joined actual SQLite memory budget', database?.usage())
      if (memoryConsumer) {
        // This final operation ends the actual binding; no further source reads follow it.
        const consumed = await call<{
          selectedReferenceCount: number
          searches: number
          physicalPosts: number
          firstAllowed: boolean
          afterWithdrawalDenied: boolean
          protectedContextDigest: string
          sourceKind: string
          modelKind: string
          transport: string
        }>('memory_consumer')
        expect(consumed.selectedReferenceCount).toBeGreaterThan(0)
        expect(consumed.searches).toBeGreaterThan(0)
        expect(consumed).toMatchObject({ physicalPosts: 1, firstAllowed: true, afterWithdrawalDenied: true,
          sourceKind: 'actual_host_dsbot', modelKind: 'synthetic_loopback', transport: 'in_process_framed_host' })
        expect(consumed.protectedContextDigest).toMatch(/^[a-f0-9]{64}$/u)
        expect(executions).toBe(1); expect(model.requests).toHaveLength(2)
        console.info('joined current owner DM consumer', consumed)
      }
    }
  }, 120000,
)
