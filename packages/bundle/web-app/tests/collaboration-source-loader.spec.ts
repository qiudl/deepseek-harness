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
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DshWebProfileWorkerFactory } from '@deepseek-ai/dsh-slark-desktop-host'
import type { HostCollaborationSourceTarget, HostCollaborationSourceDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
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

it('loads the Source owners from cordis.yml and reads the committed journal through the actual worker HTTP client', async () => {
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
  const adapter = new FixtureAdapter(), prepared = vi.spyOn(adapter, 'prepareSnapshot'), stream = vi.spyOn(adapter, 'stream')
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
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('expected loopback server')
  const origin = `http://127.0.0.1:${address.port}`, target = { workspace_id: workspace.id, session_id: sessionId,
    source_message_id: 'message-1', source_revision: '1' }
  const factory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: process.execPath, dshEntrypointPath: process.execPath,
  }) as unknown as {
    inspectCollaborationSource(origin: string, token: string, target: HostCollaborationSourceTarget, signal: AbortSignal,
      stopped: () => boolean): Promise<HostCollaborationSourceDescriptor>
  }
  const result = await factory.inspectCollaborationSource(origin, token, target, new AbortController().signal, () => false)
  expect(result).toEqual(await ctx.sessionController.inspectCollaborationSource(target, new AbortController().signal))
  expect((await fetch(`${origin}/internal/desktop-collaboration-source`, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(target) })).status).toBe(403)
  await expect(factory.inspectCollaborationSource(origin, token, { ...target, source_message_id: 'missing' }, new AbortController().signal, () => false)).rejects.toThrow()
  await workspace.detachSession(sessionId)
  await expect(factory.inspectCollaborationSource(origin, token, target, new AbortController().signal, () => false)).rejects.toThrow()
  expect(session.seq).toBe(seq)
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(prepared).toHaveBeenCalledTimes(1)
  expect(stream).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
  expect(routes.size).toBe(0)
})
