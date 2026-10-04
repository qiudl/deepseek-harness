/**
 * Web runtime glue behavior: dist resolution through the bundle's own hook,
 * the frontend-static child claiming the fallback seat, the web-surface
 * prompt section and bash runtime variables, and readiness publication through
 * the URL line and default-browser handoff.
 */

import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as AppBoot from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { WebServer, type WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { apply, Config, internals } from '../src/index.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

let dist: string | undefined

beforeEach(() => {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.unstubAllEnvs()
  internals.resolveDistIndex = originalResolve
  internals.openBrowser = originalOpenBrowser
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

const originalResolve = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

type BrowserLauncher = ChildProcess & { stderr: PassThrough }

/** Minimal browser-launcher process for the native handoff adapter. */
function launcher(): BrowserLauncher {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as BrowserLauncher
}

/** Stage a dist fixture and point the bundle's resolver at it. */
function stageDist(): string {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-app-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
  return index
}

/** A fake webServer capturing the fallback seat and index taps. */
function fakeHttpServer(host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1'): { server: WebServer; seat: () => unknown; routes: Map<string, WebRoute> } {
  let fallback: unknown
  const routes = new Map<string, WebRoute>()
  const serviceCtx = new Context()
  onTestFinished(() => serviceCtx.fiber.dispose())
  const server = new WebServer(serviceCtx, { host, port: 4567 })
  Object.defineProperty(server, 'port', { configurable: true, value: 4567 })
  vi.spyOn(server, 'registerFallback').mockImplementation((handler) => {
    fallback = handler
    return () => { fallback = undefined }
  })
  vi.spyOn(server, 'renderIndex').mockImplementation(html => html)
  vi.spyOn(server, 'collectIndexInjections').mockReturnValue([{ kind: 'script', placement: 'head', text: 'fixtureBoot()' }])
  vi.spyOn(server, 'register').mockImplementation((route) => {
    routes.set(route.path, route)
    return () => { routes.delete(route.path) }
  })
  return { server, seat: () => fallback, routes }
}

/** Deterministic Host Connection face for URL publication and frontend injection. */
function provideConnection(ctx: Context): void {
  ctx.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl)
      url.pathname = '/'
      url.searchParams.set('token', 'test-token')
      return url.href
    },
    authorizeIndex: () => true,
    requestRejection: () => undefined,
    rpc: {},
  } as never)
}

/** A fake Loader whose settlement the test controls (the URL line waits on it). */
function provideLoader(ctx: Context, settle: () => Promise<void> = async () => {}): void {
  ctx.provide('loader', { await: settle, entries: () => [] } as never)
}

interface BashContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

describe('web-app runtime glue', () => {
  it.each(['', 'invalid', 'A'.repeat(43)])('registers private Desktop routes only for valid tokens (%s)', async (token) => {
    for (const name of ['DSH_PROFILE_MODEL_TOKEN', 'DSH_PROFILE_REMOTE_SESSION_TOKEN', 'DSH_PROFILE_REMOTE_UI_TOKEN']) {
      vi.stubEnv(name, token)
    }
    stageDist()
    const ctx = new Context()
    const gatewayCtx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await gatewayCtx.fiber.dispose() })
    const { server, routes } = fakeHttpServer()
    ctx.provide('webServer', server)
    provideConnection(ctx)
    const gateway = new TypertGatewayService(gatewayCtx, {})
    let browserAdmission: Parameters<typeof gateway.registerBrowserAdmission>[0] | undefined
    const registerBrowserAdmission = gateway.registerBrowserAdmission.bind(gateway)
    vi.spyOn(gateway, 'registerBrowserAdmission').mockImplementation((policy) => {
      browserAdmission = policy
      return registerBrowserAdmission(policy)
    })
    vi.spyOn(gateway, 'invoke').mockResolvedValue({ items: [] })
    vi.spyOn(gateway, 'stream').mockResolvedValue((async function* () {
      yield { type: 'baseline', value: { items: [] } }
    })() as never)
    ctx.provide('typertGateway', gateway)
    const llm = new LlmRuntime(ctx)
    const stream = vi.spyOn(llm, 'stream').mockImplementation(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'fixture answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await liveConfig(ctx, AgentDefaultModel, { provider: 'fixture', model: 'fixture-model' })
    const selection = vi.spyOn(ctx.agentDefaultModel, 'currentSelection').mockReturnValue({ provider: 'fixture', model: 'fixture-model' })
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    await ctx.fiber.await()
    if (token.length !== 43) {
      expect(routes.size).toBe(0)
      return
    }
    expect([...routes.keys()].sort()).toEqual([
      '/internal/desktop-model-text', '/internal/desktop-remote-session', '/internal/desktop-remote-ui',
      '/internal/desktop-remote-ui-stream',
    ])
    if (!browserAdmission) throw new Error('missing Desktop browser admission')
    expect(browserAdmission.localControlStatus?.('session-1')).toMatchObject({ outcome: 'uncontrolled' })
    const finishInvoke = browserAdmission.invoke('session/prompt', { request: { sessionId: 'session-1' } })
    const finishApproval = browserAdmission.eventResult('session-1')
    expect(browserAdmission.localControlStatus?.('session-1')).toMatchObject({ outcome: 'controlled' })
    expect(browserAdmission.localControlTakeover?.('session-1', 1)).toMatchObject({ outcome: 'controlled' })
    finishApproval?.()
    finishInvoke?.()
    const http = createServer((req, res) => { void routes.get(req.url!)!.handler(req, res) })
    onTestFinished(async () => {
      http.closeAllConnections()
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    })
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('missing fixture port')
    for (const [path, body, expected] of [
      ['/internal/desktop-model-text', { text: 'question' }, { provider: 'fixture', model: 'fixture-model', text: 'fixture answer' }],
      ['/internal/desktop-remote-session', { operation: 'session.list' }, { value: { items: [] } }],
      ['/internal/desktop-remote-ui', { endpoint: 'boot/injections', payload: { args: {} } },
        { value: { injections: [{ kind: 'script', placement: 'head', text: 'fixtureBoot()' }] } }],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      })
      expect(response.status, `${path}: ${await response.clone().text()} stream calls: ${stream.mock.calls.length}`).toBe(200)
      expect(await response.json()).toEqual(expected)
    }
    const remoteStream = await fetch(`http://127.0.0.1:${address.port}/internal/desktop-remote-ui-stream`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: 'workspace/follow', payload: { args: {} } }),
    })
    expect(remoteStream.status).toBe(200)
    expect(await remoteStream.text()).toBe(`${JSON.stringify({ type: 'item', value: {
      type: 'baseline', value: { items: [] },
    } })}\n${JSON.stringify({ type: 'end' })}\n`)
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
    expect(selection).toHaveBeenCalledOnce()
  })
  it('mounts dist serving, prompt section, bash variables, and publishes the URL with the LAN snapshot', async () => {
    stageDist()
    const ctx = new Context()
    // Editor markers and a project .env SSH value do not establish a remote launch.
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { VSCODE_IPC_HOOK_CLI: '/tmp/local-vscode-ipc' } },
      { source: 'project-env', path: '/work/.env', values: { SSH_CONNECTION: 'stale-project-value' } },
    ]))
    const { server, seat } = fakeHttpServer('0.0.0.0')
    ctx.provide('webServer', server)
    provideConnection(ctx)
    const contributions: BashContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: BashContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    provideLoader(ctx)
    const lifecycle: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((message) => { lifecycle.push(String(message)) })
    const openBrowser = vi.fn(async (url: string) => { lifecycle.push(`open:${url}`) })
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: ['lab.internal'] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    // Settle the injected registrations.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seat()).toBeDefined() // frontend-static claimed the fallback
    expect(ctx.get('webRuntime')).toEqual({
      lanAddresses: ['192.168.1.5'],
      trustedHosts: ['192.168.1.5', 'lab.internal'],
    })
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)')
    expect(log).toHaveBeenCalledWith('dsh web: opening the default browser; pass --no-open to disable')
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=test-token')
    expect(lifecycle).toEqual([
      'dsh web: http://127.0.0.1:4567/?token=test-token (LAN: http://192.168.1.5:4567/?token=test-token)',
      'dsh web: opening the default browser; pass --no-open to disable',
      'open:http://127.0.0.1:4567/?token=test-token',
    ])
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === 'harness:source')?.text).toContain('DeepSeek Harness implementation checkout')
    const section = assembly.sections.find(entry => entry.name === 'app:web-surface')
    expect(section?.text).toContain('http://127.0.0.1:4567')
    // The single update contract: the receiver is always on; no-refresh
    // reloads additionally need the rebuild watcher.
    expect(section?.text).toContain('pnpm run dev:web')
    const webRuntime = contributions.find(contribution => contribution.name === 'web-runtime')
    expect(webRuntime?.resolve()).toEqual({ DSH_WEB_URL: 'http://127.0.0.1:4567' })
    await ctx.fiber.dispose()
  })

  it('publishes no readiness side effect when printing and browser opening are disabled', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(entry => entry.name === 'app:web-surface')?.text)
      .toContain('rebuilding the affected Web artifacts')
    await ctx.fiber.dispose()
  })

  it('skips the surface context when disabled (the one-shot layer): no prompt section, no bash variables', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const contributions: BashContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: BashContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(entry => entry.name === 'app:web-surface')).toBe(false)
    expect(assembly.sections.some(entry => entry.name === 'harness:source')).toBe(false)
    expect(contributions).toEqual([])
    await ctx.fiber.dispose()
  })

  it('prints the loopback-only URL line when no LAN snapshot exists', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: false, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    await ctx.fiber.dispose()
  })

  it('does not publish readiness again when Connection reloads', async () => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    const first = ctx.plugin((connectionCtx: Context) => { provideConnection(connectionCtx) })
    await first
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: false, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledTimes(1)

    await first.dispose()
    await ctx.plugin((connectionCtx: Context) => { provideConnection(connectionCtx) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it.each([
    ['SSH_CONNECTION', '10.0.0.2 55000 10.0.0.9 22'],
    ['SSH_TTY', '/dev/pts/3'],
  ] as const)('prints the host URL but skips browser handoff when %s marks an SSH launch', async (name, value) => {
    vi.stubEnv(name, value)
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    apply(ctx, new Config({ openBrowser: true, printUrl: true, surfaceContext: false, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(openBrowser).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('defers readiness publication until Loader settlement and drops it on failure or teardown', async () => {
    stageDist()
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    // Settlement path: both actions wait for loader.await() so their consumers
    // can request the complete app immediately.
    const settled = new Context()
    settled.provide('webServer', fakeHttpServer().server)
    provideConnection(settled)
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    provideLoader(settled, () => settlement)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(settled, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=test-token')
    await settled.fiber.dispose()

    // Failed path: Loader reports the sibling failure; the app prints no URL
    // for a process that is about to exit.
    log.mockClear()
    openBrowser.mockClear()
    const failed = new Context()
    failed.provide('webServer', fakeHttpServer().server)
    provideConnection(failed)
    provideLoader(failed, async () => { throw new Error('boot failed') })
    apply(failed, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    await failed.fiber.dispose()

    // Torn-down path: settlement resolves after the webserver is gone — no
    // line, no crash.
    log.mockClear()
    openBrowser.mockClear()
    const torn = new Context()
    const child = torn.plugin((childCtx: Context) => {
      childCtx.provide('webServer', fakeHttpServer().server)
      provideConnection(childCtx)
    })
    await child
    let releaseTorn: () => void
    const tornSettlement = new Promise<void>((resolve) => { releaseTorn = resolve })
    provideLoader(torn, () => tornSettlement)
    apply(torn, new Config({ openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await child.dispose() // the webServer service goes away
    releaseTorn!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).not.toHaveBeenCalled()
    expect(openBrowser).not.toHaveBeenCalled()
    await torn.fiber.dispose()
  })

  it.each([
    { id: 'webserver', announces: false },
    { id: 'modules', announces: false },
    { id: 'connection', announces: false },
    { id: 'optional-tool', announces: true },
  ])('announces readiness=$announces after the $id sibling fails', async ({ id, announces }) => {
    stageDist()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.baseUrl = 'file:///'
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.failure = () => { throw new Error('sibling rejected') }
    await ctx.loader.root.update([{ id, name: 'cordis:failure' }])
    await ctx.loader.await()
    await expect(ctx.loader.resolve(id).fiber?.await()).rejects.toThrow('sibling rejected')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const openBrowser = vi.fn(async () => {})
    internals.openBrowser = openBrowser
    const audit = vi.spyOn(AppBoot, 'auditStartupEntries')
    apply(ctx, new Config({ openBrowser: true, printUrl: true, surfaceContext: false, trustedHosts: [] }))
    await vi.waitFor(() => { expect(audit).toHaveBeenCalledOnce() })
    await Promise.allSettled(audit.mock.results.map(result => result.value as Promise<void>))
    if (announces) {
      expect(log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:4567/?token=test-token')
      expect(openBrowser).toHaveBeenCalledWith('http://127.0.0.1:4567/?token=test-token')
    } else {
      expect(log).not.toHaveBeenCalled()
      expect(openBrowser).not.toHaveBeenCalled()
    }
  })

  it('fails loud when the prompt section resolves against a portless webserver', async () => {
    stageDist()
    const ctx = new Context()
    // A webserver whose bound port is gone (torn down mid-request): the
    // section must throw, never render a URL with an undefined port.
    const { server } = fakeHttpServer()
    Object.defineProperty(server, 'port', { get: () => undefined })
    ctx.provide('webServer', server)
    provideConnection(ctx)
    apply(ctx, new Config({ openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [] }))
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(ctx.systemPrompt.assemble()).rejects.toThrow('webServer service missing')
    await ctx.fiber.dispose()
  })

  it('anchors the dist index on the frontend package manifest without requiring a built dist', () => {
    // The production resolver (not the test hook): the anchor resolves on any
    // checkout, built or not — dist existence is the fallback owner's
    // request-time concern, so a dist-less composition (the static worker
    // preview ships its own page) still boots.
    expect(originalResolve()).toMatch(/dist[/\\]index\.html$/)
  })

  it.each([
    ['Error', new Error('no desktop'), 'no desktop'],
    ['non-Error', 'desktop unavailable', 'desktop unavailable'],
  ] as const)('keeps the server running and reports the manual URL when a browser failure is %s', async (_kind, failure, reason) => {
    stageDist()
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer().server)
    provideConnection(ctx)
    internals.openBrowser = vi.fn(async () => { throw failure })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    apply(ctx, new Config({ openBrowser: true, printUrl: false, surfaceContext: false, trustedHosts: [] }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith('dsh web: opening the default browser; pass --no-open to disable')
    expect(diagnostic).toHaveBeenCalledWith(
      `web-app: could not open the default browser because ${reason}; use the dsh web URL printed at startup`,
    )
    expect(ctx.get('webServer')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('scrubs the helper environment and reports helper spawn or exit failures', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
    vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
    const completed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completed)
    const completion = originalOpenBrowser('http://127.0.0.1:4567')
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      '--input-type=module',
      '--eval', expect.stringContaining('await import('),
      '--', 'http://127.0.0.1:4567',
    ])
    expect(args?.[2]).toContain("if (process.platform === 'win32')")
    expect(args?.[2]).toContain('launcher.ref()')
    expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(options?.env).not.toHaveProperty('DSH_HOME')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.stdio).toEqual(['ignore', 'inherit', 'pipe'])
    completed.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(completed.listenerCount('error')).toBe(0)

    const completedWithStderr = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completedWithStderr)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const completionWithStderr = originalOpenBrowser('http://127.0.0.1:4567')
    completedWithStderr.stderr?.write('launcher note\n')
    completedWithStderr.emit('close', 0)
    await expect(completionWithStderr).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith('launcher note\n')

    const failedWithReason = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failedWithReason)
    const reasonFailure = originalOpenBrowser('http://127.0.0.1:4567')
    const reasonAssertion = expect(reasonFailure).rejects.toThrow('desktop unavailable')
    failedWithReason.stderr?.write('Error: desktop unavailable\n    at fixture')
    failedWithReason.emit('close', 1)
    await reasonAssertion

    const failed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failed)
    const failure = originalOpenBrowser('http://127.0.0.1:4567')
    const failureAssertion = expect(failure).rejects.toThrow('exited with code 3')
    await Promise.resolve()
    failed.emit('close', 3)
    await failureAssertion

    const errored = launcher()
    vi.mocked(spawn).mockReturnValueOnce(errored)
    const error = originalOpenBrowser('http://127.0.0.1:4567')
    const errorAssertion = expect(error).rejects.toThrow('spawn failed')
    await Promise.resolve()
    errored.emit('error', new Error('spawn failed'))
    await errorAssertion
    expect(errored.listenerCount('close')).toBe(0)
  })
})
