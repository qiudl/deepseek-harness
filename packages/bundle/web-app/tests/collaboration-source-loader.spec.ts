import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { HostControlAuthority } from '../../../host/desktop-host/src/unix-transport.ts'
import { registryFileFixture } from '../../../host/desktop-host/tests/registry-file-fixture.ts'
import { UnixHostClient, DesktopHost, ProfileRegistry } from '@deepseek-ai/dsh-slark-desktop-host'
import { decodeHostControlFrame, encodeHostControlFrame, parseHostRootPlanningAttemptAuthorityChallenge } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostRootAnalysisOutput, parseHostRootSubmissionTarget, parseHostRootSubmissionDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
/** REQ-20260930-0004: Loader-mounted Source capture, real JSON journal and private HTTP. */
import { Context } from '@deepseek-ai/cordis'
import DeepSeekLlmApiExtensions from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginInventory from '@deepseek-ai/dsh-plugin-package-inventory-deepseek'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionController, { openCollaborationAnalysisJournal, createCollaborationAnalysisWriter, collaborationJournalDigest, parseCollaborationClarificationInput, parseCollaborationReferenceMetadata, parseCollaborationRootSubmission } from '@deepseek-ai/dsh-api-session-controller'
import type { CollaborationRootPlanningRecord } from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DshWebProfileWorkerFactory } from '@deepseek-ai/dsh-slark-desktop-host'
import type { HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installSessionReadTestServices, testSessionPersistence } from '../../../api/session-controller/tests/test-remote.ts'
import * as WebApp from '../src/index.ts'

class FixtureAdapter extends LlmAdapter {
  override async prepareSnapshot(provider: string, model: string): Promise<PreparedAdapterCall> {
    return { model: { provider, id: model, name: model }, stream: options => this.stream(options) }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

it.each(['root-analysis-budget', 'root-analysis-failure', 'root-analysis', 'root-submission', 'source-only', 'analysis', 'analysis-extension', 'analysis-profile', 'analysis-missing-domain', 'delivery', 'reference'] as const)('loads the Source owners and reads their journal through real HTTP (%s)', async (mode) => {
  const rootAnalysis = mode === 'root-analysis' || mode === 'root-analysis-failure' || mode === 'root-analysis-budget'
  const directory = await mkdtemp(join(tmpdir(), 'req0004-source-loader-'))
  const cwd = await realpath(directory), ctx = new Context(), token = 'A'.repeat(43)
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '')
    if (handler) void handler(req, res)
    else res.writeHead(404).end()
  })
  let facility: DomainFacility | undefined, backend: JsonStorageBackend | undefined
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await facility?.closeAll(); await backend?.close()
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })
  vi.stubEnv('DSH_PROFILE_SOURCE_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_ANALYSIS_TOKEN', ((mode === 'analysis-profile' || mode === 'analysis-missing-domain' || rootAnalysis) || mode === 'root-submission') ? 'B'.repeat(43) : '')
  vi.stubEnv('DSH_PROFILE_DELIVERY_TOKEN', mode === 'delivery' ? 'C'.repeat(43) : '')
  vi.stubEnv('DSH_PROFILE_REFERENCE_TOKEN', mode === 'reference' ? 'D'.repeat(43) : '')
  for (const key of ['DSH_PROFILE_WORKSPACE_MODEL_TOKEN', 'DSH_PROFILE_MODEL_TOKEN', 'DSH_PROFILE_REMOTE_SESSION_TOKEN', 'DSH_PROFILE_REMOTE_UI_TOKEN']) vi.stubEnv(key, '')
  // GUI/transport peers are fixtures; Source owners, registry, model runtime and storage load from YAML.
  ctx.provide('webServer', { host: '127.0.0.1', port: 0, register(route: { path: string; handler: typeof routes extends Map<string, infer T> ? T : never }) {
    routes.set(route.path, route.handler); return () => { routes.delete(route.path) }
  } } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
  ctx.provide('typert', { lookups: { configure: () => () => {} }, contexts: { configureHost: () => () => {} } } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'selected' }) } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
    maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } } as never)
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {} } as never)
  ctx.provide('fs', {} as never)
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('source-session'), cwd, createdAt: 1, isSeeded: false }
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, { list: async () => [header],
    inspect: async () => ({ meta: header, events: [] }) }) as never)
  installSessionReadTestServices(ctx)
  const plugins = {
    storage: Storage, sessions: SessionStore, agents: AgentRegistry, llm: LlmRuntime, workspace: WorkspaceRegistry,
    controller: SessionController, web: WebApp,
    extensions: DeepSeekLlmApiExtensions, inventory: PluginInventory,
    domain: { name: 'source-test-domain', inject: ['storage'], apply(domainCtx: Context) {
      backend = new JsonStorageBackend(join(directory, 'state'))
      domainCtx.storage.backend.register('json', backend)
      facility = new DomainFacility(domainCtx, { backend: 'json' })
      domainCtx.storage.mount('domain', facility)
      domainCtx.provide('storageDomain', facility)
    } },
  }
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `source-test:${id}`,
    ...(id === 'web' && mode === 'analysis-missing-domain' ? { isolate: { storageDomain: true } } : {}),
    config: id === 'web' ? { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }
      : id === 'controller' ? { nativeOpen: false } : {} }))))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw Error('expected native Loader')
  const fixtureImport = async (specifier: string) => {
    const plugin = plugins[specifier.slice('source-test:'.length) as keyof typeof plugins]
    if (!plugin) throw Error('unexpected plugin')
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
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect(ctx.get('sessionController')).toBeDefined()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('expected loopback server')
  const origin = `http://127.0.0.1:${address.port}`
  let providerRequests = 0
  routes.set('/v1/messages', async (req, res) => {
    providerRequests++
    if (mode === 'analysis-extension') { res.writeHead(500).end(); return }
    const body: Uint8Array[] = []; for await (const chunk of req) body.push(chunk as Uint8Array)
    const wire = JSON.parse(Buffer.concat(body).toString()) as {
      model: unknown
      max_tokens: unknown
      tools?: unknown
      system: unknown
      messages: unknown
    }
    const persisted = JSON.parse(await readFile(join(directory, 'state', mode === 'root-submission'
      ? 'collaboration_root_planning_v1.json' : 'collaboration_analysis_v2.json'), 'utf8')) as {
      tables: { attempts: Record<string, { manifest_json: string; manifest?: unknown; dispatch: { attempt_id: string } }> }
    }
    const record = mode === 'root-submission' ? Object.values(persisted.tables.attempts)[0]! : Object.values(persisted.tables.attempts).find(value => (JSON.parse(value.manifest_json) as { prompt_version: string }).prompt_version === (providerRequests === 2 ? '2' : '1'))!
    expect(record.dispatch.attempt_id).toBe('fixture-attempt')
    const manifest = (mode === 'root-submission' ? record.manifest : JSON.parse(record.manifest_json)) as {
      prompt_version: string
      request: { system: string; messages: { content: { text: string }[] }[] }
    }
    expect(wire).not.toHaveProperty('dsh_plugin_packages')
    expect(wire.model).toBe('selected'); expect(wire.max_tokens).toBe(8192)
    expect(wire.tools ?? []).toEqual([])
    expect(wire.system).toBe(manifest.request.system)
    expect(wire.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: manifest.request.messages[0]!.content[0]!.text }] }])
    expect(wire.messages).toHaveLength(1)
    expect(req.headers['x-api-key']).toBe('fixture-source-key')
    const result = JSON.stringify({ intent: 'delegate', task_candidates: [{ mention_ids: ['mention-1'],
      question: '@Guide 请分析', source_evidence_spans: [{ source_message_id: 'message-1', source_revision: '1', start: 0, end: 10 }],
      reference_ids: [], independent: true, dependency_candidate_indices: [] }], pending_candidates: [] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end([
      { type: 'message_start', message: { id: 'fixture-response', model: 'selected', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: mode === 'root-analysis-failure' ? 'private-provider-invalid-json' : result } },
      { type: 'content_block_stop', index: 0 },
      ...(mode === 'root-analysis-budget' ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'x'.repeat(17000) } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const adapter = mode === 'source-only' || mode === 'delivery' || mode === 'reference' || mode === 'analysis-missing-domain' ? new FixtureAdapter() : new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: origin, models: [{ id: 'selected' }] }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'fixture-source-key' } }), resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
    // Malformed external extension JSON must not introduce tools into the logged Source analysis request.
    prepareExtensions: async request => mode === 'analysis-extension'
      ? { fields: { tools: [{ type: 'function', function: { name: 'injected_tool', description: '', parameters: {} } }] } as never, accept: async () => {} }
      : ctx.deepseekLlmApiExtensions.prepare(request),
  })
  const prepared = vi.spyOn(adapter, 'prepareSnapshot'), stream = vi.spyOn(adapter, 'stream')
  ctx.llm.registerAdapter(['fixture'], adapter)
  const workspace = await ctx.workspaceRegistry.create(cwd), sessionId = SessionId('source-session')
  await workspace.attachSession(sessionId)
  const session = ctx.sessions.create(sessionId, { meta: { cwd, createdAt: header.createdAt } })
  session.append('model/selection', { provider: 'fixture', model: 'selected' })
  const referenceText = '\ufeff范围说明😀\r\n只读分析，不修改文件'
  const referenceMessage = createUserMessage({ content: [{ type: 'text', text: referenceText }], source: { kind: 'user' } })
  if (mode === 'reference') session.append('user/message', referenceMessage, { surfaceOp: 'append' })
  const seq = session.seq, source = { workspace_id: workspace.id, session_id: sessionId, source_message_id: 'message-1', source_revision: '1',
    original_message: mode === 'reference' ? '@Guide 请引用前面那条范围说明并分析' : '@Guide 请分析',
    active_mentions: [{ mention_id: 'mention-1',
      source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
      binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] }
  const factory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: process.execPath,
    dshEntrypointPath: process.execPath,
  })
  const postAnalysis = async (body: unknown, authorization = `Bearer ${'B'.repeat(43)}`) =>
    fetch(`${origin}/internal/desktop-collaboration-analysis`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  if (mode === 'source-only') {
    expect((await ctx.sessionController.list({}, new AbortController().signal)).items
      .find(item => item.sessionId === header.id)?.blank).toBe(true)
  }
  const preparation =
    (mode === 'analysis-profile' || rootAnalysis)
      ? ((await factory['collaborationAnalysis'](
        origin,
        'B'.repeat(43),
        { action: rootAnalysis ? 'prepare_root' : 'prepare', ...(rootAnalysis?{ resume_binding_key:'f'.repeat(64) }:{}), binding_key: 'd'.repeat(64), input: rootAnalysis ? { source, namespace_id: 'n2_' + 'a'.repeat(64), continuation_policy: 'follow_authorized_plan' } : source },
        new AbortController().signal,
        () => false,
      )) as { kind: string; attempt_request_id: string; input_manifest_digest: string; source_digest: string; root?: unknown })
      : undefined
  const first =
    (mode === 'analysis-profile' || rootAnalysis)
      ? {
        kind: 'recovered' as const,
        snapshot: await ctx.sessionController.readCollaborationSourceSnapshot(
          {
            workspace_id: source.workspace_id,
            session_id: source.session_id,
            source_message_id: source.source_message_id,
            source_revision: source.source_revision,
          },
          new AbortController().signal,
        ),
      }
      : mode === 'root-submission'
        ? await ctx.sessionController.captureCollaborationRoot({ source, namespace_id: 'n2_' + 'a'.repeat(64),
          objective_ref: 'objective-1', task_grant_ref: 'grant-1', continuation_policy: 'display_only' }, new AbortController().signal)
        : await ctx.sessionController.captureCollaborationSource(source, new AbortController().signal)
  if (mode === 'source-only') {
    expect((await ctx.sessionController.list({}, new AbortController().signal)).items
      .find(item => item.sessionId === header.id)?.blank).toBe(false)
    expect(session.seq).toBe(seq)
    expect(providerRequests).toBe(0)
  }
  if ('submission' in first) {
    const submission = parseCollaborationRootSubmission(first.submission)
    expect(submission.state).toBe('pending')
    const disk = await readFile(join(directory, 'state', 'collaboration_root_submission_v1.json'), 'utf8')
    expect(disk).toContain(submission.root_trace_id)
    expect(disk).toContain(first.snapshot.host_journal_commit.journal_id)
    expect(providerRequests).toBe(0)
    const { workspace_id, session_id, source_message_id, source_revision } = first.snapshot
    const rootTarget = parseHostRootSubmissionTarget({ workspace_id, session_id, source_message_id, source_revision,
      namespace_id: submission.namespace_id, command_id: submission.command_id })
    const rootDescriptor = await factory['inspectCollaborationRoot'](origin, token, rootTarget, new AbortController().signal, () => false)
    expect(rootDescriptor.root_trace_id).toBe(submission.root_trace_id)
    expect(rootDescriptor.payload_digest).toBe(submission.payload_digest)
    expect(await ctx.sessionController.readCollaborationRoot(rootTarget, new AbortController().signal)).toEqual(submission)
    const receipt = { root_task_id: submission.root_task_id, root_trace_id: submission.root_trace_id,
      admission_id: submission.command_id, task_revision: 1, state_version: 1, state: 'active' }
    const command = { action: 'accept', target: rootTarget, receipt }
    await expect(factory['rootJournal'](origin, token, command, new AbortController().signal, () => false)).rejects.toThrow()
    const metadata = await factory['rootJournal'](origin, 'B'.repeat(43), { action:'read', target:rootTarget }, new AbortController().signal, () => false)
    expect(metadata).toEqual({ ...submission, source: undefined, source_descriptor: rootDescriptor.source_descriptor })
    const committed = await factory['rootJournal'](origin, 'B'.repeat(43), command, new AbortController().signal, () => false)
    expect(committed).toMatchObject({ state:'admitted', receipt })
    await expect(factory['rootJournal'](origin, 'B'.repeat(43), command, new AbortController().signal, () => true)).rejects.toThrow()
    await expect(factory['rootJournal'](origin, 'B'.repeat(43), { ...command,receipt:{ ...receipt,root_trace_id:'f'.repeat(32) } }, new AbortController().signal, () => false)).rejects.toThrow()
    const accepted = await ctx.sessionController.readCollaborationRoot(rootTarget, new AbortController().signal)
    expect(accepted).toEqual({ ...submission, state: 'admitted', receipt })
    expect(await ctx.sessionController.acceptCollaborationRoot(rootTarget, receipt, new AbortController().signal)).toEqual(accepted)
    const admittedDisk = JSON.parse(await readFile(join(directory, 'state', 'collaboration_root_submission_v1.json'), 'utf8')) as {
      tables: { submissions: Record<string, unknown> }
    }
    expect(JSON.stringify(admittedDisk)).toContain('"state":"admitted"')
    expect(providerRequests).toBe(0)
    expect(JSON.stringify(rootDescriptor)).not.toContain(first.snapshot.original_message)
    expect((await fetch(`${origin}/internal/desktop-collaboration-root`, {
      method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(rootTarget),
    })).status).toBe(403)
    await expect(factory['inspectCollaborationRoot'](origin, token, { ...rootTarget, namespace_id: 'n2_' + 'f'.repeat(64) },
      new AbortController().signal, () => false)).rejects.toThrow()
    await expect(factory['inspectCollaborationRoot'](origin, token, rootTarget, new AbortController().signal, () => true)).rejects.toThrow()
  }
  expect(await readFile(join(directory, 'state', 'collaboration_source_v2.json'), 'utf8')).toContain(
    first.snapshot.host_journal_commit.journal_id,
  )
  const target = {
    workspace_id: workspace.id,
    session_id: sessionId,
    source_message_id: 'message-1',
    source_revision: '1',
  }

  const result = await factory['inspectCollaborationSource'](origin, token, target, new AbortController().signal, () => false)
  expect(result).toEqual(await ctx.sessionController.inspectCollaborationSource(target, new AbortController().signal))
  const full=await factory['readCollaborationSourceSnapshot'](origin,token,target,new AbortController().signal,()=>false)
  expect(full.descriptor).toEqual(result);expect(JSON.parse(full.snapshot_json)).toEqual(first.snapshot)
  expect(full.snapshot_json).not.toMatch(/prepared|api_key|unlockMaterial/)
  expect((await fetch(`${origin}/internal/desktop-collaboration-source-snapshot`,{ method:'POST',headers:{ cookie:'dsh-auth=browser' },body:JSON.stringify(target) })).status).toBe(403)
  expect((await fetch(`${origin}/internal/desktop-collaboration-source`, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(target) })).status).toBe(403)
  await expect(factory['inspectCollaborationSource'](origin, token, { ...target, source_message_id: 'missing' }, new AbortController().signal, () => false)).rejects.toThrow()
  if (mode === 'reference') {
    const signal = new AbortController().signal
    const input = {
      source: { workspace_id: target.workspace_id, session_id: target.session_id,
        source_message_id: target.source_message_id, revision: target.source_revision },
      reference_request_id: 'explicit-message-reference', source_kind: 'message', source_locator: referenceMessage.id,
      source_version: '1', range: { unit: 'whole' }, recipient_mention_ids: ['mention-1'],
      source_evidence_spans: [{ source_message_id: target.source_message_id, source_revision: target.source_revision,
        start: 0, end: source.original_message.length }],
    }
    const capture = (capability = 'D'.repeat(43)) => factory['captureReferenceSelection'](
      origin, capability, input, signal, () => false,
    )
    await expect(capture(token)).rejects.toThrow()
    expect((await fetch(`${origin}/internal/desktop-collaboration-reference-capture`, {
      method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(input),
    })).status).toBe(403)
    const metadata = parseCollaborationReferenceMetadata(await capture())
    expect(metadata.descriptor).toEqual(result)
    expect(metadata.request.source.message_digest).toBe(createHash('sha256').update(source.original_message).digest('hex'))
    expect(metadata.request).toMatchObject({ source_kind: 'message', source_locator: referenceMessage.id, source_version: '1',
      range: { start: 0, end: referenceText.length, unit: 'utf16' }, mime_type: 'text/plain',
      byte_length: Buffer.byteLength(referenceText), content_digest: createHash('sha256').update(referenceText).digest('hex') })
    expect(JSON.stringify(metadata)).not.toContain(referenceText)
    expect(parseCollaborationReferenceMetadata(await capture())).toEqual(metadata)
    const saved = JSON.parse(await readFile(join(directory, 'state', 'collaboration_reference_v2.json'), 'utf8')) as {
      tables: { references: Record<string, { content_base64: string; reference_request_digest: string }> }
    }
    const records = Object.values(saved.tables.references)
    expect(records).toHaveLength(1)
    expect(Buffer.from(records[0]!.content_base64, 'base64').toString('utf8')).toBe(referenceText)
    expect(records[0]!.reference_request_digest).toBe(metadata.reference_request_digest)
    const contentQuery = { ...target, reference_request_digest: metadata.reference_request_digest, offset: 0 }
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie: 'dsh-auth=browser' }]) {
      expect((await fetch(`${origin}/internal/desktop-collaboration-reference-content`, {
        method: 'POST', headers, body: JSON.stringify(contentQuery),
      })).status).toBe(403)
    }
    const chunk = await factory['readReferenceContent'](origin, 'D'.repeat(43), contentQuery as never, signal, () => false)
    expect(chunk.descriptor).toEqual(metadata.descriptor)
    expect(chunk.reference_request_digest).toBe(metadata.reference_request_digest)
    expect(chunk.content_digest).toBe(metadata.request.content_digest)
    expect(chunk.total_bytes).toBe(Buffer.byteLength(referenceText))
    expect(Buffer.from(chunk.chunk_base64url, 'base64url')).toEqual(Buffer.from(referenceText).subarray(0, 32768))
    await expect(factory['readReferenceContent'](origin, 'D'.repeat(43),
      { ...contentQuery, reference_request_digest: 'c'.repeat(64) } as never, signal, () => false)).rejects.toThrow()
    await expect(factory['readReferenceContent'](origin, 'D'.repeat(43), contentQuery as never, AbortSignal.abort(), () => false))
      .rejects.toThrow()
    expect(await ctx.sessionController.readCollaborationReferenceGrant(target, metadata.reference_request_digest, signal))
      .toEqual({ ...metadata.descriptor, reference_request_digest: metadata.reference_request_digest })
    const grantResponse = await fetch(`${origin}/internal/desktop-collaboration-reference-grant`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, reference_request_digest: metadata.reference_request_digest }),
    })
    expect(grantResponse.status).toBe(200)
    expect(await grantResponse.json()).toEqual({ ...metadata.descriptor, reference_request_digest: metadata.reference_request_digest })
    expect(providerRequests).toBe(0)
    expect(session.seq).toBe(seq)
  }
  if (mode === 'delivery') {
    const sourcePath = join(directory, 'state', 'collaboration_source_v2.json')
    const sourceBytes = await readFile(sourcePath)
    const answer = '😀'.repeat(32768)
    const input = { namespace_id: 'fixture-namespace', projection: {
      delivery_id: 'fixture-delivery', invocation_id: 'fixture-invocation', plan_id: 'fixture-plan',
      task_id: 'fixture-task', task_revision: '1', source_locator: target,
      source_snapshot_digest: result.snapshot_digest, execution_state: 'succeeded', invocation_state_version: '2',
      target: { project_id: '212', agent_id: 'guide' },
      target_display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' }, answer,
      result_digest: collaborationJournalDigest({ state: 'succeeded', answer, failure_code: null }),
      delivery_state: 'pending', delivery_state_version: '1',
    } } as HostRemoteSessionJson
    const receive = (command: HostRemoteSessionJson, capability = 'C'.repeat(43)) =>
      factory['receiveCollaborationDelivery'](origin, capability, command, new AbortController().signal, () => false)
    await expect(receive(input, token)).rejects.toThrow()
    await expect(factory['receiveCollaborationDelivery'](origin, 'C'.repeat(43), input, new AbortController().signal, () => true)).rejects.toThrow()
    await expect(receive('x'.repeat(1024 * 1024))).rejects.toMatchObject({ code: 'invalid_input' })
    const receipt = await receive(input)
    expect(await receive(input)).toEqual(receipt)
    expect(receipt).not.toHaveProperty('answer')
    const persisted = JSON.parse(await readFile(join(directory, 'state', 'collaboration_delivery_v2.json'), 'utf8')) as {
      tables: { replies: Record<string, {
        answer: string
        namespace_id: string
        source_locator: typeof target
        target_display_snapshot: { agent_name: string; project_name: string }
        host_journal_commit: { commit_version: string }
      }> }
    }
    const replies = Object.values(persisted.tables.replies)
    expect(replies).toHaveLength(1)
    const saved = replies[0]!
    expect(saved.answer).toBe(answer)
    expect(Buffer.byteLength(saved.answer, 'utf8')).toBe(128 * 1024)
    expect(saved.source_locator).toEqual(target)
    expect(await readFile(sourcePath)).toEqual(sourceBytes)
    expect(providerRequests).toBe(0)
    await expect(JSON.stringify({ namespace_id: saved.namespace_id, source_message_id: saved.source_locator.source_message_id,
      target_display_snapshot: saved.target_display_snapshot, answer_utf8_bytes: Buffer.byteLength(saved.answer, 'utf8'),
      answer_complete: saved.answer === answer, commit_version: saved.host_journal_commit.commit_version }, null, 2) + '\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-delivery.reply.expected.txt'))
    await workspace.detachSession(sessionId)
    await expect(receive(input)).rejects.toThrow()
    expect(Object.values((JSON.parse(await readFile(join(directory, 'state', 'collaboration_delivery_v2.json'), 'utf8')) as typeof persisted).tables.replies)).toHaveLength(1)
    await workspace.attachSession(sessionId)
  }
  if (mode === 'analysis-missing-domain') {
    // Real Loader isolation removes storage only from the Web owner's context;
    // the Controller's already-open Source journal retains its original data.
    const nextId = 'message-missing-domain'
    const next = { ...source, source_message_id: nextId,
      active_mentions: source.active_mentions.map(mention => ({ ...mention,
        source_span: { ...mention.source_span, source_message_id: nextId } })) }
    const response = await postAnalysis({ action: 'prepare', binding_key: 'd'.repeat(64), input: next })
    expect(response.status).toBe(422)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'unavailable' })
    expect(await readFile(join(directory, 'state', 'collaboration_source_v2.json'), 'utf8')).toContain(nextId)
    await expect(readFile(join(directory, 'state', 'collaboration_analysis_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const root = (await ctx.sessionController.captureCollaborationRoot({ source, namespace_id: 'n2_' + 'a'.repeat(64),
      continuation_policy: 'display_only' }, new AbortController().signal)).submission
    const target = { namespace_id: root.namespace_id, command_id: root.command_id, workspace_id: source.workspace_id,
      session_id: source.session_id, source_message_id: source.source_message_id, source_revision: source.source_revision }
    await ctx.sessionController.acceptCollaborationRoot(target, { root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
      admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, new AbortController().signal)
    const planning = await postAnalysis({ action: 'read_root_attempt', binding_key: 'd'.repeat(64), target })
    expect(planning.status).toBe(422)
    expect(await planning.json()).toEqual({ error: 'unavailable' })
    expect(providerRequests).toBe(0)
  }
  const analysisJournal = mode !== 'root-submission' && mode !== 'analysis-missing-domain' && mode !== 'source-only' && mode !== 'analysis-profile' && !rootAnalysis && mode !== 'delivery' && mode !== 'reference' ? await openCollaborationAnalysisJournal(facility!) : undefined
  const analysisWriter = analysisJournal ? createCollaborationAnalysisWriter(analysisJournal, async (record) => {
    expect(providerRequests).toBe(0)
    return { attempt_request_id: record.attempt_request_id, plan_id: 'fixture-plan', expected_plan_revision: '1',
      attempt_id: 'fixture-attempt', attempt_fence: '1', input_manifest_digest: record.input_manifest_digest,
      source_digest: record.source_digest, lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true }
  }) : undefined
  if ((mode === 'analysis-profile' || rootAnalysis)) {
    expect(providerRequests).toBe(0)
    expect(preparation?.kind).toBe('prepared')
    if (rootAnalysis) {
      const root = parseHostRootSubmissionDescriptor(preparation?.root)
      expect(root.root_trace_id).toMatch(/^[a-f0-9]{32}$/u)
      const rootTarget = { ...target, namespace_id:root.namespace_id, command_id:root.command_id }
      const disk = await ctx.sessionController.readCollaborationRoot(rootTarget, new AbortController().signal)
      expect(disk.root_trace_id).toBe(root.root_trace_id)
      expect(disk.source_digest).toBe(preparation!.source_digest)
      const replay = await factory['collaborationAnalysis'](origin, 'B'.repeat(43), {
        action:'prepare_root',binding_key:'d'.repeat(64),input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' },
      }, new AbortController().signal, () => false)
      expect(replay).toEqual({ kind:'recovered',descriptor:root.source_descriptor,root })
      expect(replay).not.toHaveProperty('attempt_request_id')
      expect((await postAnalysis({ action:'recover_root',binding_key:'d'.repeat(64),input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } })).status).toBe(422)
      const pendingRootPath = join(directory,'state','collaboration_root_submission_v1.json')
      const pendingBytes = await readFile(pendingRootPath)
      const pendingLookup = await postAnalysis({ action:'reconcile_root',binding_key:'d'.repeat(64),input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } })
      expect(pendingLookup.status).toBe(200)
      expect((await pendingLookup.json() as { value: unknown }).value).toEqual({ kind:'recovered',descriptor:root.source_descriptor,root })
      expect(await ctx.sessionController.readCollaborationRoot(rootTarget,new AbortController().signal)).toEqual(disk)
      expect(await readFile(pendingRootPath)).toEqual(pendingBytes)
      expect(providerRequests).toBe(0)
      expect((await postAnalysis({ action:'reconcile_root',binding_key:'d'.repeat(64),input:{ source:{ ...source,original_message:'changed' },namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } })).status).toBe(422)


      const resume = { action:'resume_root',resume_binding_key:'f'.repeat(64),binding_key:'d'.repeat(64),input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } }
      expect((await postAnalysis(resume)).status).toBe(422)
      expect((await postAnalysis({ action:'read_root_output',binding_key:'d'.repeat(64),target:rootTarget })).status).toBe(422)
      await ctx.sessionController.acceptCollaborationRoot(rootTarget,{ root_task_id:root.root_task_id,root_trace_id:root.root_trace_id,
        admission_id:root.command_id,task_revision:1,state_version:1,state:'active' },new AbortController().signal)
      expect((await postAnalysis({ action: 'prepare_root_attempt', target: rootTarget, binding_key: 'd'.repeat(64) })).status).toBe(422)
      const resumed=await postAnalysis(resume)
      expect(resumed.status).toBe(200)
      expect((await resumed.json() as { value:unknown }).value).toEqual(preparation)
      expect((await postAnalysis({ ...resume,resume_binding_key:'e'.repeat(64) })).status).toBe(422)
      expect((await postAnalysis({ ...resume,input:{ ...resume.input,source:{ ...source,original_message:'changed' } } })).status).toBe(422)
      expect(providerRequests).toBe(0)
      expect(prepared).toHaveBeenCalledTimes(1)
    }
    expect(
      (await postAnalysis({ action: 'prepare', binding_key: 'd'.repeat(64), input: source }, `Bearer ${token}`)).status,
    ).toBe(403)
    const headersOnly = await fetch(`${origin}/internal/desktop-collaboration-analysis`, {
      method: 'POST',
      headers: { cookie: 'dsh-auth=browser' },
      body: '{}',
    })
    expect(headersOnly.status).toBe(403)
    const grant = {
      attempt_request_id: preparation!.attempt_request_id,
      input_manifest_digest: preparation!.input_manifest_digest,
      source_digest: preparation!.source_digest,
      plan_id: 'fixture-plan',
      expected_plan_revision: '1',
      attempt_id: 'fixture-attempt',
      attempt_fence: '1',
      lease_expires_at: new Date(Date.now() + 30000).toISOString(),
      dispatch_granted: true,
    }
    const dispatch = {
      action: 'dispatch',
      binding_key: 'd'.repeat(64),
      attempt_request_id: preparation!.attempt_request_id,
      grant,
    }
    expect((await postAnalysis({ ...dispatch, binding_key: 'e'.repeat(64) })).status).toBe(422)
    expect(providerRequests).toBe(0)
    if (mode === 'root-analysis-failure') {
      const inputPath = join(directory, 'state', 'collaboration_analysis_v2.json')
      const rootPath = join(directory, 'state', 'collaboration_root_submission_v1.json')
      const rootBytes = await readFile(rootPath)
      expect((await postAnalysis(dispatch)).status).toBe(422)
      expect(providerRequests).toBe(1)
      const inputBytes = await readFile(inputPath)
      expect((await postAnalysis(dispatch)).status).toBe(422)
      expect(providerRequests).toBe(1)
      await ctx.fiber.dispose()
      const saved = JSON.parse(await readFile(join(directory, 'state', 'collaboration_analysis_failure_v1.json'), 'utf8')) as { tables: { failures: Record<string, unknown> } }
      const rows = Object.values(saved.tables.failures)
      expect(rows).toHaveLength(1)
      const root = parseHostRootSubmissionDescriptor(preparation!.root)
      expect(rows[0]).toMatchObject({ reason: 'invalid_json', trace_id: root.root_trace_id,
        input_manifest_digest: preparation!.input_manifest_digest, source_digest: preparation!.source_digest,
        attempt_request_id: preparation!.attempt_request_id, dispatch_digest: collaborationJournalDigest(grant) })
      expect(JSON.stringify(rows)).not.toContain('private-provider')
      await expect(readFile(join(directory, 'state', 'collaboration_analysis_output_v2.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(inputPath)).toEqual(inputBytes)
      expect(await readFile(rootPath)).toEqual(rootBytes)
      expect(session.seq).toBe(seq)
      routes.delete('/v1/messages')
      expect(routes.size).toBe(0)
      return
    }
    const result = (await factory['collaborationAnalysis'](
      origin,
      'B'.repeat(43),
      dispatch,
      new AbortController().signal,
      () => false,
    )) as { jsonText: string }
    expect((JSON.parse(result.jsonText) as { intent: string }).intent).toBe('delegate')
    await expect(
      factory['collaborationAnalysis'](origin, 'B'.repeat(43), dispatch, new AbortController().signal, () => true),
    ).rejects.toThrow()
    expect(providerRequests).toBe(1)
    expect(await readFile(join(directory, 'state', 'collaboration_analysis_output_v2.json'), 'utf8')).toContain(
      'json_text',
    )
    expect((await postAnalysis(dispatch)).status).toBe(422)
    expect(providerRequests).toBe(1)
    if (mode === 'analysis-profile') {

      const replyInput = { ...source, source_message_id: 'reply-1', original_message: '只分析这份方案的规则，不修改文件。', active_mentions: [] }
      const captured = await factory['collaborationAnalysis'](origin, 'B'.repeat(43),
        { action: 'capture_reply', binding_key: 'd'.repeat(64), input: replyInput }, new AbortController().signal, () => false)
      expect(captured).toMatchObject({ kind: 'captured', descriptor: { source_message_id: 'reply-1' } })
      expect(providerRequests).toBe(1)
      const reply = await ctx.sessionController.readCollaborationSourceSnapshot({ workspace_id: source.workspace_id,
        session_id: source.session_id, source_message_id: 'reply-1', source_revision: '1' }, new AbortController().signal)
      expect(reply.model_snapshot.configuration_generation).not.toBe(first.snapshot.model_snapshot.configuration_generation)
      const clarification = parseCollaborationClarificationInput({ plan: { plan_id: 'fixture-plan', plan_revision: '3', input_version: '2' },
        clarification_request_id: 'reply-request', original_snapshot: first.snapshot, reply_snapshot: reply,
        original_snapshot_digest: collaborationJournalDigest(first.snapshot), reply_snapshot_digest: collaborationJournalDigest(reply),
        pending_items: [{ pending_item_id: 'pending-1', revision: '1', mention_ids: ['mention-1'], target: { project_id: '212', agent_id: 'guide' },
          reason: 'task_ambiguous', question: '要分析哪个方面？', source_evidence_spans: [{ source_message_id: 'message-1', source_revision: '1', start: 0, end: source.original_message.length }] }],
        frozen_task_ids: ['accepted-task'], mention_order: ['mention-1'], prior_replies: [] })
      const fresh = await factory['collaborationAnalysis'](origin, 'B'.repeat(43),
        { action: 'prepare_clarification', binding_key: 'd'.repeat(64), input: JSON.parse(JSON.stringify(clarification)) as HostRemoteSessionJson },
        new AbortController().signal, () => false) as {
        kind: string
        attempt_request_id: string
        input_manifest_digest: string
        source_digest: string
      }
      expect(fresh.kind).toBe('prepared'); expect(providerRequests).toBe(1)
      const nextDispatch = { action: 'dispatch', binding_key: 'd'.repeat(64), attempt_request_id: fresh.attempt_request_id,
        grant: { ...grant, attempt_request_id: fresh.attempt_request_id, input_manifest_digest: fresh.input_manifest_digest,
          source_digest: fresh.source_digest, expected_plan_revision: '3' } }
      await factory['collaborationAnalysis'](origin, 'B'.repeat(43), nextDispatch, new AbortController().signal, () => false)
      expect(providerRequests).toBe(2)
      expect((await postAnalysis(nextDispatch)).status).toBe(422)
      const records = JSON.parse(await readFile(join(directory, 'state', 'collaboration_analysis_v2.json'), 'utf8')) as {
        tables: { attempts: Record<string, { manifest_json: string }> } }
      const manifest = Object.values(records.tables.attempts).map(value => JSON.parse(value.manifest_json) as {
        prompt_version: string
        request: { system: string; messages: { content: { text: string }[] }[] } }).find(value => value.prompt_version === '2')!
      const visible = manifest.request.messages[0]!.content[0]!.text
      expect(visible).not.toContain('accepted-task'); expect(visible).toContain('不修改文件')
      await expect(JSON.stringify({ prompt_version: manifest.prompt_version, system: manifest.request.system, input: JSON.parse(visible) as Record<string, unknown> }, null, 2) + '\n')
        .toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-clarification.request.expected.txt'))
      expect(session.seq).toBe(seq)
    }
    if (rootAnalysis) {
      const root = parseHostRootSubmissionDescriptor(preparation?.root)
      const targetRoot = { ...target, namespace_id: root.namespace_id, command_id: root.command_id }
      const read = { action: 'read_root_output', binding_key: 'd'.repeat(64), target: targetRoot }
      expect((await postAnalysis({ action:'resume_root',resume_binding_key:'f'.repeat(64),binding_key:'d'.repeat(64),input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } })).status).toBe(422)
      await ctx.sessionController.acceptCollaborationRoot(targetRoot, { root_task_id: root.root_task_id,
        root_trace_id: root.root_trace_id, admission_id: root.command_id, task_revision: 1, state_version: 1, state: 'active' }, new AbortController().signal)
      const selection = { plan_id: 'execution-plan', expected_plan_revision: '1', candidate_digest: 'c'.repeat(64),
        task_id: 'execution-task', task_revision: '1', task_digest: 'e'.repeat(64), expected_scope_version: '0' }
      const executionCommand = { action: 'root_execution_journal', binding_key: 'd'.repeat(64),
        operation: { action: 'prepare', target: targetRoot, selection } }
      const preparedExecution = await factory['collaborationAnalysis'](origin, 'B'.repeat(43), executionCommand,
        new AbortController().signal, () => false)
      const storedExecution = await ctx.sessionController.collaborationRootExecution(
        { action: 'read', target: targetRoot, selection }, new AbortController().signal)
      expect(preparedExecution).toEqual(storedExecution)
      if (!storedExecution) throw Error('execution command was not persisted')
      expect(storedExecution.root.root_trace_id).toBe(root.root_trace_id)
      expect(await readFile(join(directory, 'state', 'collaboration_root_execution_v1.json'), 'utf8'))
        .toContain(storedExecution.execution_command_id)
      expect(await factory['collaborationAnalysis'](origin, 'B'.repeat(43), executionCommand,
        new AbortController().signal, () => false)).toEqual(preparedExecution)
      const executionReceipt = { execution_command_id: storedExecution.execution_command_id,
        root_task_id: root.root_task_id, root_trace_id: root.root_trace_id, root_revision: '1',
        plan_id: selection.plan_id, task_id: selection.task_id, task_revision: selection.task_revision,
        invocation_id: 'fixture-invocation', admission: 'recorded', max_invocations: 1, max_runtime_ms: 1200000,
        expires_at: '2026-10-01T00:00:00.000Z' }
      expect(await factory['collaborationAnalysis'](origin, 'B'.repeat(43), { ...executionCommand,
        operation: { ...executionCommand.operation, action: 'accept', receipt: executionReceipt } },
      new AbortController().signal, () => false)).toEqual({ ...storedExecution, state: 'admitted', receipt: executionReceipt })
      expect(providerRequests).toBe(1)
      expect((await postAnalysis(read, `Bearer ${token}`)).status).toBe(403)
      const recovered = parseHostRootAnalysisOutput(await factory['collaborationAnalysis'](origin, 'B'.repeat(43), read,
        new AbortController().signal, () => false))
      if (recovered.state !== 'saved') throw Error('saved root output was not recovered')
      expect(recovered.state).toBe('saved')
      expect(recovered.root).toEqual(root)
      expect(Buffer.from(recovered.json_base64url, 'base64url').toString('utf8')).toBe(result.jsonText)
      expect(recovered.dispatch).toEqual(grant)
      expect(recovered).not.toHaveProperty('manifest_json')
      expect(providerRequests).toBe(1)
      const recoverCommand = { action:'recover_root', binding_key:'d'.repeat(64), input:{ source,namespace_id:root.namespace_id,continuation_policy:'follow_authorized_plan' } }
      const rootPath = join(directory,'state','collaboration_root_submission_v1.json')
      const beforeRecovery = await readFile(rootPath)
      expect((await postAnalysis(recoverCommand, `Bearer ${token}`)).status).toBe(403)
      expect(await factory['collaborationAnalysis'](origin,'B'.repeat(43),recoverCommand,new AbortController().signal,()=>false)).toEqual({ kind:'recovered',descriptor:root.source_descriptor,root })
      for (const changed of [{ ...source,original_message:'changed' }, { ...source,source_message_id:'missing' }]) {
        expect((await postAnalysis({ ...recoverCommand,input:{ ...recoverCommand.input,source:changed } })).status).toBe(422)
      }
      expect((await postAnalysis({ ...recoverCommand,input:{ ...recoverCommand.input,namespace_id:'n2_'+'f'.repeat(64) } })).status).toBe(422)
      expect(await readFile(rootPath)).toEqual(beforeRecovery)
      await workspace.detachSession(sessionId)
      expect((await postAnalysis(recoverCommand)).status).toBe(422)
      await workspace.attachSession(sessionId)
      expect(providerRequests).toBe(1)
      expect(prepared).toHaveBeenCalledTimes(1)
    }

  }

  if (mode === 'analysis-extension') {
    if (first.kind !== 'captured') throw Error('expected original capture')
    await expect(first.analyze(analysisWriter!, new AbortController().signal)).rejects.toThrow('collaboration_analysis_failed')
    expect(providerRequests).toBe(0)
  }
  if (mode === 'analysis') {
    if (first.kind !== 'captured') throw Error('expected original capture')
    const result = await first.analyze(analysisWriter!, new AbortController().signal)
    const output: unknown = JSON.parse(result.jsonText)
    expect(output).toMatchObject({ task_candidates: [{ mention_ids: ['mention-1'] }] })
    expect(providerRequests).toBe(1)
    const manifest = JSON.parse([...analysisJournal!.records()][0]!.manifest_json) as {
      prompt_version: string
      request: { system: string; messages: { content: { text: string }[] }[] }
    }
    const input: unknown = JSON.parse(manifest.request.messages[0]!.content[0]!.text)
    await expect(JSON.stringify({ prompt_version: manifest.prompt_version, system: manifest.request.system,
      input, output }, null, 2) + '\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-analysis.request.expected.txt'))
    const retry = await ctx.sessionController.captureCollaborationSource(source, new AbortController().signal)
    expect(retry.kind).toBe('recovered'); expect(retry).not.toHaveProperty('analyze')
    await expect(first.analyze(async () => {}, new AbortController().signal)).rejects.toThrow('collaboration_analysis_call_used')
    expect(providerRequests).toBe(1)
  }
  await analysisJournal?.close()
  if (mode === 'root-submission' && 'submission' in first) {
    const originalRoot = parseCollaborationRootSubmission(first.submission)
    const targetRoot = { ...target, namespace_id: originalRoot.namespace_id, command_id: originalRoot.command_id }
    const admitted = await ctx.sessionController.readCollaborationRoot(targetRoot, new AbortController().signal)
    const sourcePath = join(directory, 'state', 'collaboration_source_v2.json')
    const sourceBytes = await readFile(sourcePath)
    const rootPath = join(directory, 'state', 'collaboration_root_submission_v1.json'), rootBytes = await readFile(rootPath)
    const signal = new AbortController().signal, privateToken = 'B'.repeat(43)
    // Host account storage is instance-local; Source and planning journals remain real files.
    const registry = new ProfileRegistry({ root: join(directory, 'authority'), deviceIndexKey: Buffer.alloc(32, 7), clock: { now: Date.now },
      ...registryFileFixture() })
    const account = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:loader', authorityBindingVersion: 1,
      issuer: 'https://accounts.example.test', subject: randomUUID(), keyHandle: 'keychain:loader',
      unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
    await registry.registerAccount(account)
    const host = new DesktopHost({ registry, clock: { now: Date.now }, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
      verifyAccountAccessToken: () => ({ issuer: account.issuer, subject: account.subject }) })
    const privateKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.from(
      '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex') })
    const identity = { installationId: randomUUID(), hostInstanceId: randomUUID(), processNonce: 'A'.repeat(43),
      installationPublicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
      installationPrivateKey: privateKey, executableSignatureDigest: '1'.repeat(64), runtimeGeneration: 5, schemaGeneration: 1 }
    const authority = new HostControlAuthority({ identity, host, profilePersistenceGeneration: () => 1, rootPlanningSupported: true,
      inspectRootPlanningAttempt: (_profile, target, id, binding, active) =>
        factory['inspectRootPlanningAttempt'](origin, privateToken, target, id, binding, active, () => false),
      collaborationAnalysis: (_profile, payload, active) =>
        factory['collaborationAnalysis'](origin, privateToken, payload, active, () => false) })
    const ownerId = randomUUID(), lifetime = new AbortController(), control = authority.openSession(ownerId, lifetime.signal)
    const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
      trustedInstallationPublicKey: identity.installationPublicKey,
      trustedExecutableSignatureDigest: identity.executableSignatureDigest }, {
      call: async frame => decodeHostControlFrame(encodeHostControlFrame(
        await control.handleRequest(decodeHostControlFrame(encodeHostControlFrame(frame))))),
      isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); control.close() },
    })
    onTestFinished(() =>{  client.close() })
    await host.ensureAccountProfile({ ...account, accountAccessToken: 'test', ownerId })
    const prepare = () => client.collaborationAnalysis({ ...account, command: { action: 'prepare_root_attempt', target: parseHostRootSubmissionTarget(targetRoot) } })
    const initial = await prepare()
    if (initial.kind !== 'root_attempt_prepared') throw Error('expected new preparation')
    const preparation = initial.preparation
    const proofChallenge = parseHostRootPlanningAttemptAuthorityChallenge({ schema_version: 1, scope: 'planning_attempt',
      expected_plan_revision: '1', ...Object.fromEntries(Object.entries(preparation).filter(([key]) => key !== 'root')),
      root_challenge: { schema_version: 1, namespace_id: admitted.namespace_id, command_id: admitted.command_id,
        root_task_id: admitted.root_task_id, root_trace_id: admitted.root_trace_id, payload_digest: admitted.payload_digest,
        source_challenge: { request_id: randomUUID(), challenge_nonce: 'A'.repeat(43),
          expires_at: Date.now() + 30000, audience: 'https://slark.example.test', environment_id: account.authorityEnvironmentId,
          account_issuer: account.issuer, account_subject: account.subject, ...preparation.root.source_descriptor, host_epoch: '1' } } })
    const proof = await client.attestRootPlanningAttemptAuthority({ ...account, challenge: proofChallenge })
    expect(proof.challenge.root_challenge.root_trace_id).toBe(admitted.root_trace_id)
    const command = (value: HostRemoteSessionJson, key = 'e'.repeat(64)) => factory['collaborationAnalysis'](
      origin, privateToken, { ...value as Record<string, HostRemoteSessionJson>, binding_key: key }, signal, () => false)
    expect(preparation.root.root_trace_id).toBe(originalRoot.root_trace_id)
    expect(preparation.model_snapshot).not.toEqual(first.snapshot.model_snapshot)
    expect(await prepare()).toEqual(initial)
    const inspect = { action: 'inspect_root_attempt', target: targetRoot, attempt_request_id: preparation.attempt_request_id }
    await expect(command(inspect)).rejects.toThrow()
    await expect(command(inspect, 'e'.repeat(64))).rejects.toThrow()
    const rows = JSON.parse(await readFile(join(directory, 'state', 'collaboration_root_planning_v1.json'), 'utf8')) as {
      records: Record<string, unknown>
    }
    expect(JSON.stringify(rows)).toContain(preparation.input_manifest_digest)
    expect(providerRequests).toBe(0)
    const grant = { attempt_request_id: preparation.attempt_request_id, namespace_id: admitted.namespace_id,
      root_task_id: admitted.root_task_id, root_trace_id: admitted.root_trace_id, model_snapshot: preparation.model_snapshot,
      plan_id: 'fixture-plan', expected_plan_revision: '1', attempt_id: 'fixture-attempt', attempt_fence: '1',
      input_manifest_digest: preparation.input_manifest_digest, source_digest: admitted.source_digest,
      lease_expires_at: new Date(Date.now() + 30000).toISOString(), dispatch_granted: true }
    const dispatch = { action: 'dispatch_root_attempt', attempt_request_id: preparation.attempt_request_id, grant }
    await expect(command(dispatch as HostRemoteSessionJson, 'e'.repeat(64))).rejects.toThrow()
    const output = await client.collaborationAnalysis({ ...account, command: { action: 'dispatch_root_attempt',
      attempt_request_id: preparation.attempt_request_id, grant: grant as HostRemoteSessionJson } })
    if (output.kind !== 'output') throw Error('expected output')
    const result = { jsonText: Buffer.from(output.json_base64url, 'base64url').toString('utf8') }
    expect(providerRequests).toBe(1)
    const recoveredEvidence = await client.collaborationAnalysis({ ...account, command: { action: 'read_root_attempt', target: parseHostRootSubmissionTarget(targetRoot) } })
    if (recoveredEvidence.kind !== 'root_attempt_evidence') throw Error('expected durable evidence')
    expect(recoveredEvidence.evidence.attempt?.preparation).toEqual(preparation)
    expect(recoveredEvidence.evidence.attempt?.dispatch).toEqual(grant)
    expect(Buffer.from(recoveredEvidence.evidence.attempt!.output!.json_base64url, 'base64url').toString('utf8')).toBe(result.jsonText)
    expect(providerRequests).toBe(1)
    await expect(command(dispatch as HostRemoteSessionJson)).rejects.toThrow()
    await expect(command(inspect)).rejects.toThrow()
    await expect(prepare()).rejects.toThrow()
    await expect(client.attestRootPlanningAttemptAuthority({ ...account, challenge: proofChallenge })).rejects.toThrow()
    const saved = JSON.parse(await readFile(join(directory, 'state', 'collaboration_root_planning_v1.json'), 'utf8')) as {
      tables: { attempts: Record<string, CollaborationRootPlanningRecord> }
    }
    const [record] = Object.values(saved.tables.attempts)
    expect(record!.manifest.root.source).toEqual(first.snapshot)
    expect(record!.output!.json_text).toBe(result.jsonText)
    const m = record!.manifest
    await expect(JSON.stringify({ prompt_version: m.prompt_version, system: m.request.system,
      input: JSON.parse(m.request.messages[0].content[0].text) as Record<string, unknown>, output: JSON.parse(result.jsonText) as Record<string, unknown> }, null, 2) + '\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-analysis.request.expected.txt'))
    expect(await readFile(sourcePath)).toEqual(sourceBytes)
    expect(await readFile(rootPath)).toEqual(rootBytes)
  }
  await workspace.detachSession(sessionId)
  await expect(factory['inspectCollaborationSource'](origin, token, target, new AbortController().signal, () => false)).rejects.toThrow()
  await expect(factory['readCollaborationSourceSnapshot'](origin,token,target,new AbortController().signal,()=>false)).rejects.toThrow()
  expect(session.seq).toBe(seq)
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(prepared).toHaveBeenCalledTimes(mode === 'root-submission' || mode === 'analysis-profile' || mode === 'analysis-missing-domain' ? 2 : 1)
  expect(stream).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
  routes.delete('/v1/messages')
  expect(routes.size).toBe(0)
})
