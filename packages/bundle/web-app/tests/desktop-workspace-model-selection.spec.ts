import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as WebApp from '../src/index.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { handleDesktopWorkspaceModelSelectionRequest } from '../src/desktop-workspace-model-selection.ts'

const token = 'A'.repeat(43)
const target = { workspace_id: '123e4567-e89b-42d3-a456-426614174000' as never, session_id: 'session' as never }
const selection = { ...target, provider: 'p', model: 'm' }

async function fixture(inspect = vi.fn(async () => selection)) {
  const server = createServer((req, res) => { void handleDesktopWorkspaceModelSelectionRequest(req, res, token, inspect) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  const post = (body: object, authorization = `Bearer ${token}`) => fetch(url, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { inspect, post }
}

it('requires the private worker token and rejects cookie-only or arbitrary identity requests', async () => {
  const f = await fixture()
  expect((await f.post(target, '')).status).toBe(403)
  expect((await f.post(target, `Bearer ${'B'.repeat(43)}`)).status).toBe(403)
  for (const body of [{ ...target, workspace_id: '/private' }, { ...target, provider: 'caller-model' },
    { ...target, session_id: '中'.repeat(86) }]) expect((await f.post(body)).status).toBe(400)
  expect(f.inspect).not.toHaveBeenCalled()
  const response = await f.post(target)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual(selection)
  expect(f.inspect).toHaveBeenCalledWith(target, expect.any(AbortSignal))
})

it('loads the Web plugin from cordis.yml and reads an actual Session without activation or appends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-workspace-selection-loader-'))
  const cwd = await realpath(directory)
  const ctx = new Context()
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '')
    if (handler) void handler(req, res)
    else res.writeHead(404).end()
  })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    }
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })
  vi.stubEnv('DSH_PROFILE_WORKSPACE_MODEL_TOKEN', token)
  vi.stubEnv('DSH_PROFILE_MODEL_TOKEN', '')
  vi.stubEnv('DSH_PROFILE_REMOTE_SESSION_TOKEN', '')
  vi.stubEnv('DSH_PROFILE_REMOTE_UI_TOKEN', '')
  ctx.provide('webServer', {
    host: '127.0.0.1', port: 0,
    register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  } as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('workspaceRegistry', { get: (id: string) => id === target.workspace_id
    ? { id, path: cwd, sessionIds: [target.session_id] } : undefined, archivedSessionIds: [] } as never)
  const workspace = ctx.workspaceRegistry.get(target.workspace_id)!
  ctx.workspaceRegistry.get = id => id === target.workspace_id ? workspace : undefined
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'default', model: 'default' }), cwd })
  const resume = vi.spyOn(controller, 'resolveAgent')
  const session = ctx.sessions.create(target.session_id, { meta: { cwd } })
  session.append('model/selection', { provider: 'actual', model: 'next', reasoningEffort: 'high' })
  const seq = session.seq
  await writeFile(join(directory, 'cordis.yml'), JSON.stringify([{ id: 'web-app', name: '@deepseek-ai/dsh-web-app',
    config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } }]))
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (specifier !== '@deepseek-ai/dsh-web-app') throw Error(`Unexpected plugin: ${specifier}`)
    return WebApp
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(directory, 'cordis.yml')).href } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'web-app')!
  await entry.fiber!.await()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/internal/desktop-workspace-model-selection`
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(target) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ...target, provider: 'actual', model: 'next', reasoning_effort: 'high' })
  expect(session.seq).toBe(seq)
  expect(ctx.agents.get(target.session_id)).toBeUndefined()
  expect(resume).not.toHaveBeenCalled()
  const cookie = await fetch(url, { method: 'POST', headers: { cookie: 'dsh-auth=browser' }, body: JSON.stringify(target) })
  expect(cookie.status).toBe(403)
  await ctx.fiber.dispose()
  expect(routes.size).toBe(0)
})

it('sanitizes reader failures and rejects mismatched or secret-bearing results', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(Error('private path and API key'))
  const failure = await f.post(target)
  expect(failure.status).toBe(422)
  expect(await failure.json()).toEqual({ error: 'unavailable' })
  f.inspect.mockResolvedValueOnce({ ...selection, session_id: 'other' as never })
  expect((await f.post(target)).status).toBe(422)
  f.inspect.mockResolvedValueOnce({ ...selection, api_key: 'private' } as typeof selection)
  expect((await f.post(target)).status).toBe(422)
})
