/** REQ-20260930-0004: Loader-mounted Source capture, real JSON journal and private HTTP. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DshWebProfileWorkerFactory } from '@deepseek-ai/dsh-slark-desktop-host'
import type { HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot } from '@deepseek-ai/dsh-host-control-protocol'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
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

it.each(['source-only', 'analysis', 'analysis-extension'] as const)('loads the Source owners and reads their journal through real HTTP (%s)', async (mode) => {
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
  const header = { version: SESSION_FORMAT_VERSION, id: SessionId('source-session'), cwd, createdAt: 1, isSeeded: false }
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, { list: async () => [header],
    inspect: async () => ({ meta: header, events: [] }) }) as never)
  installSessionReadTestServices(ctx)
  const plugins = {
    storage: Storage, sessions: SessionStore, agents: AgentRegistry, llm: LlmRuntime, workspace: WorkspaceRegistry,
    controller: SessionController, web: WebApp,
    domain: { name: 'source-test-domain', inject: ['storage'], apply(domainCtx: Context) {
      backend = new JsonStorageBackend(join(directory, 'state'))
      domainCtx.storage.backend.register('json', backend)
      facility = new DomainFacility(domainCtx, { backend: 'json' })
      domainCtx.storage.mount('domain', facility)
      domainCtx.provide('storageDomain', facility)
    } },
  }
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `source-test:${id}`,
    config: id === 'web' ? { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }
      : id === 'controller' ? { nativeOpen: false } : {} }))))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    const plugin = plugins[specifier.slice('source-test:'.length) as keyof typeof plugins]
    if (!plugin) throw Error('unexpected plugin')
    return typeof plugin === 'function' ? { default: plugin } : plugin
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(directory, 'cordis.yml')).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect(ctx.get('sessionController')).toBeDefined()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('expected loopback server')
  const origin = `http://127.0.0.1:${address.port}`
  let providerRequests = 0
  routes.set('/chat/completions', async (req, res) => {
    providerRequests++
    if (mode === 'analysis-extension') { res.writeHead(500).end(); return }
    const body: Uint8Array[] = []; for await (const chunk of req) body.push(chunk as Uint8Array)
    const wire = JSON.parse(Buffer.concat(body).toString()) as { model: unknown; max_tokens: unknown; tools?: unknown; messages: unknown }
    const manifest = JSON.parse(await readFile(join(directory, 'analysis-request.json'), 'utf8')) as {
      prompt_version: string
      request: { system: string; messages: { content: { text: string }[] }[] }
    }
    expect(wire.model).toBe('selected'); expect(wire.max_tokens).toBe(8192)
    expect(wire.tools ?? []).toEqual([])
    expect(wire.messages).toEqual([{ role: 'system', content: manifest.request.system },
      { role: 'user', content: manifest.request.messages[0]!.content[0]!.text }])
    expect(wire.messages).toHaveLength(2)
    expect(req.headers.authorization).toBe('Bearer fixture-source-key')
    const result = JSON.stringify({ intent: 'delegate', task_candidates: [{ mention_ids: ['mention-1'],
      question: '请分析', source_evidence_spans: [{ source_message_id: 'message-1', source_revision: '1', start: 7, end: 10 }],
      reference_ids: [], independent: true, dependency_candidate_indices: [] }], pending_candidates: [] })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'fixture-response', choices: [{ index: 0, delta: { content: result }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  const adapter = mode === 'source-only' ? new FixtureAdapter() : new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: origin, models: [{ id: 'selected' }] }),
    resolveApiKey: async () => 'fixture-source-key', resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
    prepareExtensions: async () => ({ fields: mode === 'analysis-extension' ? { tools: [{ type: 'function', function: { name: 'injected_tool', description: '', parameters: {} } }] } : {}, accept: async () => {} }),
  })
  const prepared = vi.spyOn(adapter, 'prepareSnapshot'), stream = vi.spyOn(adapter, 'stream')
  ctx.llm.registerAdapter(['fixture'], adapter)
  const workspace = await ctx.workspaceRegistry.create(cwd), sessionId = SessionId('source-session')
  await workspace.attachSession(sessionId)
  const session = ctx.sessions.create(sessionId, { meta: { cwd } })
  session.append('model/selection', { provider: 'fixture', model: 'selected' })
  const seq = session.seq, source = { workspace_id: workspace.id, session_id: sessionId, source_message_id: 'message-1', source_revision: '1',
    original_message: '@Guide 请分析',
    active_mentions: [{ mention_id: 'mention-1',
      source_span: { source_message_id: 'message-1', source_revision: '1', start: 0, end: 6 },
      display_snapshot: { agent_name: 'Guide', project_name: 'qiu-slark' },
      binding: { kind: 'resolved' as const, target: { project_id: '212', agent_id: 'guide' }, capability_snapshot: 'a'.repeat(64) } }] }
  const first = await ctx.sessionController.captureCollaborationSource(source, new AbortController().signal)
  expect(await readFile(join(directory, 'state', 'collaboration_source_v2.json'), 'utf8')).toContain(first.snapshot.host_journal_commit.journal_id)
  const target = { workspace_id: workspace.id, session_id: sessionId,
    source_message_id: 'message-1', source_revision: '1' }
  const factory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
  }) as unknown as {
    inspectCollaborationSource(origin: string, token: string, target: HostCollaborationSourceTarget, signal: AbortSignal,
      stopped: () => boolean): Promise<HostCollaborationSourceDescriptor>
    readCollaborationSourceSnapshot(
      origin: string, token: string, target: HostCollaborationSourceTarget, signal: AbortSignal,
      stopped: () => boolean,
    ): Promise<HostCollaborationSourceSnapshot>
  }
  const result = await factory.inspectCollaborationSource(origin, token, target, new AbortController().signal, () => false)
  expect(result).toEqual(await ctx.sessionController.inspectCollaborationSource(target, new AbortController().signal))
  const full=await factory.readCollaborationSourceSnapshot(origin,token,target,new AbortController().signal,()=>false)
  expect(full.descriptor).toEqual(result);expect(JSON.parse(full.snapshot_json)).toEqual(first.snapshot)
  expect(full.snapshot_json).not.toMatch(/prepared|api_key|unlockMaterial/)
  expect((await fetch(`${origin}/internal/desktop-collaboration-source-snapshot`,{ method:'POST',headers:{ cookie:'dsh-auth=browser' },body:JSON.stringify(target) })).status).toBe(403)
  expect((await fetch(`${origin}/internal/desktop-collaboration-source`, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(target) })).status).toBe(403)
  await expect(factory.inspectCollaborationSource(origin, token, { ...target, source_message_id: 'missing' }, new AbortController().signal, () => false)).rejects.toThrow()
  if (mode === 'analysis-extension') {
    if (first.kind !== 'captured') throw Error('expected original capture')
    await expect(first.analyze(async (manifest) => {
      await writeFile(join(directory, 'analysis-request.json'), JSON.stringify(manifest), { mode: 0o600 })
    }, new AbortController().signal)).rejects.toThrow('collaboration_analysis_failed')
    expect(providerRequests).toBe(0)
  }
  if (mode === 'analysis') {
    if (first.kind !== 'captured') throw Error('expected original capture')
    const result = await first.analyze(async (manifest) => {
      expect(providerRequests).toBe(0)
      await writeFile(join(directory, 'analysis-request.json'), JSON.stringify(manifest), { mode: 0o600 })
    }, new AbortController().signal)
    expect(JSON.parse(result.jsonText) as unknown).toMatchObject({ task_candidates: [{ mention_ids: ['mention-1'] }] })
    expect(providerRequests).toBe(1)
    const manifest = JSON.parse(await readFile(join(directory, 'analysis-request.json'), 'utf8')) as {
      prompt_version: string
      request: { system: string; messages: { content: { text: string }[] }[] }
    }
    await expect(JSON.stringify({ prompt_version: manifest.prompt_version, system: manifest.request.system,
      input: JSON.parse(manifest.request.messages[0]!.content[0]!.text) as unknown, output: JSON.parse(result.jsonText) as unknown }, null, 2) + '\n')
      .toMatchFileSnapshot(join(import.meta.dirname, 'expected/collaboration-analysis.request.expected.txt'))
    const retry = await ctx.sessionController.captureCollaborationSource(source, new AbortController().signal)
    expect(retry.kind).toBe('recovered'); expect(retry).not.toHaveProperty('analyze')
    await expect(first.analyze(async () => {}, new AbortController().signal)).rejects.toThrow('collaboration_analysis_call_used')
    expect(providerRequests).toBe(1)
  }
  await workspace.detachSession(sessionId)
  await expect(factory.inspectCollaborationSource(origin, token, target, new AbortController().signal, () => false)).rejects.toThrow()
  await expect(factory.readCollaborationSourceSnapshot(origin,token,target,new AbortController().signal,()=>false)).rejects.toThrow()
  expect(session.seq).toBe(seq)
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(prepared).toHaveBeenCalledTimes(1)
  expect(stream).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
  routes.delete('/chat/completions')
  expect(routes.size).toBe(0)
})
