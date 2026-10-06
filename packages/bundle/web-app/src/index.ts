/**
 * @deepseek-ai/dsh-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * harness-source and web-surface prompt sections, the bash-visible web runtime
 * variable, the process-token URL line, and the default-browser handoff. The
 * model and shell retain the clean URL. App command-line values arrive through
 * the `webStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection, auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import { describeCollaborationReference } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { handleDesktopCollaborationSourceRequest, handleDesktopCollaborationSourceSnapshotRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationReferenceGrantRequest, handleDesktopCollaborationReferenceCaptureRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationDeliveryRequest } from './desktop-collaboration-delivery.ts'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from './desktop-collaboration-analysis.ts'
import { openCollaborationAnalysisJournal } from '@deepseek-ai/dsh-api-session-controller'
import { handleDesktopWorkspaceModelSelectionRequest } from './desktop-workspace-model-selection.ts'
import { generateDesktopModelText, handleDesktopModelRequest } from './desktop-model.ts'
import { DesktopRemoteSessionExecutor, handleDesktopRemoteSessionRequest } from './desktop-remote-session.ts'
import { DesktopSessionControl } from './desktop-session-control.ts'
import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest } from './desktop-remote-ui.ts'
import { DesktopRemoteApprovalEvents, DesktopRemoteUiStreamExecutor,
  handleDesktopRemoteUiStreamRequest } from './desktop-remote-ui-stream.ts'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Runtime service that releases Web rows after bind-dependent values resolve. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `DSH_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** Bind-dependent Web values shared by the trust fence and URL display. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: string[]
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open resolves at PowerShell spawn; keep it referenced until that launcher hands the URL to Windows.
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // The parent turns this exit into the manual-URL warning.
  console.error(error)
  process.exitCode = 1
}
`

/**
 * Resolve one LAN-trust snapshot from the active server bind.
 *
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port and
 * an OS-assigned port is unknowable before bind.
 * @param bindHost - the active webserver bind host.
 * @param extra - explicit `--trusted-host` values, in argument order.
 * @returns the LAN display addresses and invocation-derived fence authorities.
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/** Model-visible orientation and acceptance boundary for sessions created through `dsh web`. */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/**
 * Dist location is workspace knowledge of this bundle: anchored on the
 * frontend package manifest, not configured. Existence is a request-time
 * concern — the fallback owner reads files per request, so a composition
 * whose page never reaches the fallback seat (the static worker preview
 * ships its own page and carries no dist) boots without one.
 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only when the frontend package is absent from the checkout */
    throw new Error('web-app: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** Start the maintained platform opener without forwarding Harness credentials. */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** Hand one URL to the operating system's default browser. */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** Test hooks for the built dist and native browser handoff; production never mutates them. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
} = { resolveDistIndex, openBrowser }

/**
 * Mount the Web runtime: dist serving, surface prompt, the bash runtime
 * variable, the URL line, and the default-browser handoff.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  const desktopModelToken = process.env.DSH_PROFILE_MODEL_TOKEN
  if (desktopModelToken && /^[A-Za-z0-9_-]{43}$/u.test(desktopModelToken)) {
    ctx.inject(['llm', 'agentDefaultModel'], (modelCtx) => {
      modelCtx.effect(() => modelCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-model-text',
        handler: (req, res) => handleDesktopModelRequest(req, res, desktopModelToken,
          (text, signal) => generateDesktopModelText({
            text, signal,
            selection: () => modelCtx.agentDefaultModel.currentSelection(),
            stream: options => modelCtx.llm.stream(options),
          })),
      }))
    })
  }
  const analysisToken = process.env.DSH_PROFILE_ANALYSIS_TOKEN
  if (analysisToken && /^[A-Za-z0-9_-]{43}$/u.test(analysisToken)) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      const lifetime = new AbortController()
      const owner = new DesktopCollaborationAnalysis(
        (input, signal) => sessionCtx.sessionController.captureCollaborationSource(input, signal),
        async () => {
          const facility = sessionCtx.get('storageDomain')
          if (!facility) throw Error('collaboration_analysis_journal_unavailable')
          return openCollaborationAnalysisJournal(facility)
        }, lifetime.signal,
      )
      sessionCtx.effect(() => () => { lifetime.abort(); return owner.close() }, 'web-app: private analysis lifetime')
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-analysis',
        handler: (req, res) => handleDesktopCollaborationAnalysisRequest(req, res, analysisToken, owner),
      }))
    })
  }
  const sourceToken = process.env.DSH_PROFILE_SOURCE_TOKEN
  if (sourceToken && /^[A-Za-z0-9_-]{43}$/u.test(sourceToken)) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-source',
        handler: (req, res) => handleDesktopCollaborationSourceRequest(req, res, sourceToken,
          (target, signal) => sessionCtx.sessionController.inspectCollaborationSource(target, signal)),
      }))
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind:'exact',path:'/internal/desktop-collaboration-source-snapshot',
        handler:(req,res)=>handleDesktopCollaborationSourceSnapshotRequest(req,res,sourceToken,
          (target,signal)=>sessionCtx.sessionController.readCollaborationSourceSnapshot(target,signal)),
      }))
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-reference-grant',
        handler: (req, res) => handleDesktopCollaborationReferenceGrantRequest(req, res, sourceToken,
          (query, signal) => {
            const { reference_request_digest, ...target } = query
            return sessionCtx.sessionController.readCollaborationReferenceGrant(target, reference_request_digest, signal)
          }),
      }))
    })
  }
  const referenceToken = process.env.DSH_PROFILE_REFERENCE_TOKEN
  if (referenceToken && /^[A-Za-z0-9_-]{43}$/u.test(referenceToken)) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-reference-capture',
        handler: (req, res) => handleDesktopCollaborationReferenceCaptureRequest(req, res, referenceToken,
          async (selection, signal) => {
            const record = await sessionCtx.sessionController.captureCollaborationReferenceSelection(selection, signal)
            return describeCollaborationReference(record)
          }),
      }))
    })
  }
  const deliveryToken = process.env.DSH_PROFILE_DELIVERY_TOKEN
  if (deliveryToken && /^[A-Za-z0-9_-]{43}$/u.test(deliveryToken)) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-delivery',
        handler: (req, res) => handleDesktopCollaborationDeliveryRequest(req, res, deliveryToken,
          (value, signal) => sessionCtx.sessionController.receiveCollaborationDelivery(value, signal)),
      }))
    })
  }
  const workspaceModelToken = process.env.DSH_PROFILE_WORKSPACE_MODEL_TOKEN
  if (workspaceModelToken && /^[A-Za-z0-9_-]{43}$/u.test(workspaceModelToken)) {
    ctx.inject(['sessionController'], (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-workspace-model-selection',
        handler: (req, res) => handleDesktopWorkspaceModelSelectionRequest(req, res, workspaceModelToken,
          async (target, signal) => {
            const result = await sessionCtx.sessionController.inspectWorkspaceModelSelection(target.session_id, target.workspace_id, signal)
            return { workspace_id: result.workspaceId, session_id: result.sessionId,
              provider: result.selection.provider, model: result.selection.model,
              ...result.selection.reasoningEffort === undefined ? {} : { reasoning_effort: result.selection.reasoningEffort } }
          }),
      }))
    })
  }
  const desktopRemoteSessionToken = process.env.DSH_PROFILE_REMOTE_SESSION_TOKEN
  const remoteApprovalEvents = new DesktopRemoteApprovalEvents()
  if (desktopRemoteSessionToken && /^[A-Za-z0-9_-]{43}$/u.test(desktopRemoteSessionToken)) {
    ctx.inject(['typertGateway'], (remoteCtx) => {
      const control = new DesktopSessionControl()
      remoteCtx.effect(() => remoteCtx.typertGateway.registerBrowserAdmission({
        invoke: (endpoint, args) => control.admitBrowserInvoke(endpoint, args),
        eventResult: sessionId => control.admitBrowserWrite(sessionId),
        localControlStatus: sessionId => control.browserStatus(sessionId),
        localControlTakeover: (sessionId, expectedEpoch) => control.takeoverBrowser(sessionId, expectedEpoch),
      }), 'web-app: Desktop browser Session admission')
      const executor = new DesktopRemoteSessionExecutor(remoteCtx.typertGateway, remoteApprovalEvents, control)
      remoteCtx.effect(() => remoteCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-remote-session',
        handler: (req, res) => handleDesktopRemoteSessionRequest(
          req, res, desktopRemoteSessionToken,
          (command, signal) => executor.execute(command, signal),
        ),
      }))
    })
  }
  const desktopRemoteUiToken = process.env.DSH_PROFILE_REMOTE_UI_TOKEN
  if (desktopRemoteUiToken && /^[A-Za-z0-9_-]{43}$/u.test(desktopRemoteUiToken)) {
    ctx.inject(['typertGateway'], (remoteCtx) => {
      const executor = new DesktopRemoteUiExecutor(remoteCtx.typertGateway,
        () => remoteCtx.webServer.collectIndexInjections())
      const streamExecutor = new DesktopRemoteUiStreamExecutor(remoteCtx.typertGateway, remoteApprovalEvents)
      remoteCtx.effect(() => remoteCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-remote-ui',
        handler: (req, res) => handleDesktopRemoteUiRequest(req, res, desktopRemoteUiToken,
          (endpoint, payload, signal) => executor.execute(endpoint, payload, signal)),
      }))
      remoteCtx.effect(() => remoteCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-remote-ui-stream',
        handler: (req, res) => handleDesktopRemoteUiStreamRequest(req, res, desktopRemoteUiToken,
          (endpoint, payload, signal) => streamExecutor.open(endpoint, payload, signal)),
      }))
    })
  }
  // The loopback URL belongs to this host. Under SSH, the operator reaches it
  // through a local forwarding address that this process cannot derive.
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(launchEnvironmentOf(ctx))
  // Release dependent rows only after bind-dependent trust has been sampled once.
  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    ctx.inject(['connection'], (connectionCtx) => {
      // The URL line and browser handoff are readiness signals: supervisors RPC
      // as soon as they observe the line, while a browser requests the page as
      // soon as it opens. Neither may run while sibling rows such as the /api
      // route owner are still mounting. Await Loader settlement first; a
      // hand-built tree without a Loader is already the complete tree.
      const announceReady = (): void => {
        if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return
        const webUrl = localWebUrl(connectionCtx)
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl)
        // Reuse the exact LAN snapshot provided to the /api trust fence.
        const lanCandidate = runtime.lanAddresses[0]
        const port = connectionCtx.webServer.port
        const lanUrl = lanCandidate === undefined
          ? undefined
          : connectionCtx.connection.authenticatedUrl(`http://${lanCandidate}:${String(port)}`)
        ANNOUNCED_ROOTS.add(connectionCtx.root)
        if (config.printUrl) {
          console.log(`dsh web: ${authenticatedUrl}${lanUrl === undefined ? '' : ` (LAN: ${lanUrl})`}`)
        }
        if (handoffBrowser) {
          console.log('dsh web: opening the default browser; pass --no-open to disable')
          void internals.openBrowser(authenticatedUrl).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error)
            console.error(`web-app: could not open the default browser because ${reason}; use the dsh web URL printed at startup`)
          })
        }
      }
      // This row's own activation can precede a sibling failure. The app owns
      // readiness by waiting for its Loader tree, or announces at once in a
      // hand-built tree without Loader.
      const settled = connectionCtx.get('loader')?.await()
      if (settled === undefined) announceReady()
      else {
        void settled.then(async () => {
          await auditStartupEntries(connectionCtx.root, 'dsh web', () => {})
          // The tree can be disposed while the boot was in flight (early
          // SIGTERM); a URL line or browser tab for a dead server would only
          // mislead, and reading torn-down services would turn a clean shutdown
          // into a crash.
          if (connectionCtx.get('webServer') !== undefined
            && connectionCtx.get('connection') !== undefined) announceReady()
        }).catch(() => {
          // Boot owns the failure diagnostic; readiness remains unpublished.
        })
      }
    })
  }
}
