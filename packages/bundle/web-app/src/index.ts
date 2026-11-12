import { DesktopRuntimeEntryHost, runtimeEntryConfiguration, createDesktopRuntimeEntryLocator } from './desktop-runtime-entry-host.ts'
import { parseHostTaskCoordinationEnvironments } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopTaskCoordination } from './desktop-task-coordination.ts'
import { DesktopProjectOperationMemory } from './desktop-project-operation-memory.ts'
import { parseHostProjectMemoryEnvironments } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopOperationOrigin, parseOperationOriginKeyrings } from './desktop-operation-origin.ts'
import { handleDesktopNativeRoomRetirementRequest } from './desktop-native-room-retirement.ts'
import { handleDesktopBoundBotRoomsRequest } from './desktop-bound-bot-rooms.ts'
import { bindDesktopRemoteGateway } from './desktop-remote-gateway.ts'
import { DesktopRemoteTerminalStreams } from './desktop-remote-terminal-stream.ts'
import { handleDesktopRootJournalRequest } from './desktop-collaboration-source.ts'
/**
 * @deepseek-ai/dsh-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * bash-visible web runtime variable, the process-token URL line, and the
 * default-browser handoff, and provides the `webApp` service. An advertised
 * `publicUrl` replaces the published bind-address URL. Non-loopback
 * HTTP binds trigger an exposure warning. App command-line values arrive
 * through the `webStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { bindUrlHost, isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import { describeCollaborationReference } from '@deepseek-ai/dsh-api-session-controller'
import { nativeAgentResultChunkFields } from '@deepseek-ai/dsh-host-control-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { handleDesktopCollaborationSourceRequest, handleDesktopCollaborationSourceSnapshotRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationReferenceGrantRequest, handleDesktopCollaborationReferenceCaptureRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationReferenceContentRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationRootRequest } from './desktop-collaboration-source.ts'
import { handleDesktopCollaborationDeliveryRequest } from './desktop-collaboration-delivery.ts'
import { openCollaborationRootPlanningJournal } from '@deepseek-ai/dsh-api-session-controller'
import { DesktopCollaborationAnalysis, handleDesktopCollaborationAnalysisRequest } from './desktop-collaboration-analysis.ts'
import { openCollaborationAnalysisJournal } from '@deepseek-ai/dsh-api-session-controller'
import { handleDesktopWorkspaceModelSelectionRequest } from './desktop-workspace-model-selection.ts'
import { handleDesktopCollaborationArchiveStateRequest } from './desktop-collaboration-archive-state.ts'
import { handleDesktopCollaborationArchiveTransitionRequest } from './desktop-collaboration-archive-transition.ts'
import { handleDesktopGroupInputFenceRequest } from './desktop-group-input-fence.ts'
import { handleDesktopBotIdentityRequest } from './desktop-bot-identity.ts'
import { handleDesktopBotSessionIdentityRequest, type DesktopBotSessionIdentityProvider } from './desktop-bot-session-identity.ts'
import { handleDesktopBotRosterRequest } from './desktop-bot-roster.ts'
import { handleDesktopNativeRoomRequest } from './desktop-native-room.ts'
import { handleDesktopNativeRoomPreparationRequest, readDesktopNativeRoomPreparation } from './desktop-native-room-preparation.ts'
import { handleDesktopNativeRoomOperationRequest } from './desktop-native-room-operations.ts'
import { handleDesktopBotGroupRequest } from './desktop-bot-group.ts'
import { handleDesktopCollaborationArchiveIntentRequest } from './desktop-collaboration-archive-intent.ts'
import type {} from '@deepseek-ai/dsh-workspace'
import { generateDesktopModelText, handleDesktopModelRequest } from './desktop-model.ts'
import { DesktopRemoteSessionExecutor, handleDesktopRemoteSessionRequest } from './desktop-remote-session.ts'
import { DesktopSessionControl } from './desktop-session-control.ts'
import { DesktopRemoteUiExecutor, handleDesktopRemoteUiRequest } from './desktop-remote-ui.ts'
import type { HostBotRoomListRequest, HostBotRoomHistoryRequest, HostBotRoomDetailsRequest,
  HostBotSettingsRequest, HostBotMemoryRequest, HostBotRoomMemoryRequest, HostBotSchedulesRequest,
  HostBotScheduleHistoryRequest,
  HostBotFoldersRequest, HostBotAvatarRequest, HostBotDeleteRequest,
  HostBotDuplicateRequest, HostBotCreateRequest,
  HostBotScheduleMutationRequest } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopRemoteApprovalEvents, DesktopRemoteUiStreamExecutor,
  handleDesktopRemoteUiStreamRequest } from './desktop-remote-ui-stream.ts'
import { parsePublicUrl } from './public-url.ts'

/** The Web GUI this process serves, provided by the `web-runtime` row. */
export interface WebApp {
  /**
   * The URL this GUI advertises, also used for `DSH_WEB_URL` and the startup URL line.
   * @returns the configured `publicUrl`, otherwise the listener origin.
   */
  getAdvertisedUrl(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Web GUI this process serves; absent when no Web runtime is mounted. */
    webApp: WebApp
  }
}

/** Stable Cordis plugin name. */
export const name = 'web-app'

const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the `DSH_WEB_URL` bash variable naming this GUI. A one-shot
   * non-interactive layer can turn it off when its user is not in the GUI.
   */
  surfaceContext: boolean
  /**
   * Canonical HTTP(S) root to advertise in the printed and opened URL,
   * `DSH_WEB_URL`, and `webApp.getAdvertisedUrl()`, which supplies the Web GUI
   * URL in agent runtime context, e.g. `https://app.example/ui/`, normalized to end in `/`. Configures no routing
   * or authentication; see [public deployments](../README.md#public-deployments).
   * Absent or YAML `null` advertises the bind-address URL.
   */
  publicUrl?: string
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  publicUrl: z.transform(z.string(), value => parsePublicUrl(value).href),
})

/** Environment variable naming the advertised URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

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
 * Mount the Web runtime: dist serving, the bash runtime variable, the URL
 * line, and the default-browser handoff.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
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
  const taskCoordinationEnvironments = parseHostTaskCoordinationEnvironments(process.env.DSH_PROFILE_TASK_COORDINATION_ENVIRONMENTS)
  const operationMemoryEnvironments = parseHostProjectMemoryEnvironments(process.env.DSH_PROFILE_PROJECT_OPERATION_MEMORY_ENVIRONMENTS)
  const operationOriginKeyrings = parseOperationOriginKeyrings(process.env.DSH_PROFILE_OPERATION_ORIGIN_KEYRINGS)
  const nativeConfiguration = operationOriginKeyrings.length && process.env.DSH_PROFILE_RUNTIME_ENTRY_ORIGINS
    ? runtimeEntryConfiguration(process.env.DSH_PROFILE_RUNTIME_ENTRY_ORIGINS) : undefined
  const analysisToken = process.env.DSH_PROFILE_ANALYSIS_TOKEN
  if (analysisToken && /^[A-Za-z0-9_-]{43}$/u.test(analysisToken)) {
    ctx.inject(['sessionController', 'tools', 'sessions', ...(nativeConfiguration ? ['agentLoop', 'agents', 'sessionPersistence'] : [])], async (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-root-journal',
        handler: (req, res) => handleDesktopRootJournalRequest(req, res, analysisToken, (command, signal) =>
          command.action === 'read' ? sessionCtx.sessionController.readCollaborationRoot(command.target, signal)
            : sessionCtx.sessionController.acceptCollaborationRoot(command.target, command.receipt, signal)),
      }))
      const lifetime = new AbortController()
      let native: DesktopRuntimeEntryHost | undefined
      let coldLocator: ReturnType<typeof createDesktopRuntimeEntryLocator> | undefined
      if (nativeConfiguration) {
        try { coldLocator = createDesktopRuntimeEntryLocator(sessionCtx, nativeConfiguration,
          process.env.DSH_PROFILE_ID ?? '', lifetime.signal) }
        catch { /* A cold reader never repairs or claims an unsupported private source. */ }
        try { native = new DesktopRuntimeEntryHost(sessionCtx, nativeConfiguration, operationOriginKeyrings,
          process.env.DSH_PROFILE_ID ?? '', process.env.DSH_PROFILE_WORKER_ID ?? '', lifetime.signal) }
        catch { /* Preserve an unavailable private format and keep the original business owner available. */ }
      }
      if (native) sessionCtx.provide('runtimeEntryConsumerHost', native.service)
      const origins = new DesktopOperationOrigin(sessionCtx, sessionCtx.sessionController, operationOriginKeyrings,
        process.env.DSH_PROFILE_ID ?? '', lifetime.signal, native ? reader => native.readerWith(reader) : undefined)
      sessionCtx.provide('projectOperationOrigins', origins.reader)
      const operationMemory = new DesktopProjectOperationMemory(sessionCtx, operationMemoryEnvironments, process.env.DSH_PROFILE_ID ?? '', lifetime.signal,
        Date.now, native ? (reference, view, signal) => native.readEffect(reference, view, signal) : undefined)
      sessionCtx.provide('projectOperationMemoryAuthorizations', operationMemory.reader)
      const taskCoordination = taskCoordinationEnvironments.length ? new DesktopTaskCoordination(sessionCtx, sessionCtx.sessionController,
        await sessionCtx.sessionController.openCollaborationTaskCoordinationJournal(), taskCoordinationEnvironments,
        process.env.DSH_PROFILE_ID ?? '', process.env.DSH_PROFILE_WORKER_ID ?? '', lifetime.signal) : undefined
      const owner = new DesktopCollaborationAnalysis(
        (input, signal) => sessionCtx.sessionController.captureCollaborationSource(input, signal),
        async () => {
          const facility = sessionCtx.get('storageDomain')
          if (!facility) throw Error('collaboration_analysis_journal_unavailable')
          return openCollaborationAnalysisJournal(facility)
        }, lifetime.signal,
        (input, signal) => sessionCtx.sessionController.captureCollaborationRoot(input, signal),
        (target, signal) => sessionCtx.sessionController.readCollaborationRoot(target, signal),
        { prepare: (target, predecessor, signal) =>
          sessionCtx.sessionController.prepareCollaborationRootPlanning(target, predecessor, signal),
        open: async () => {
          const facility = sessionCtx.get('storageDomain')
          if (!facility) throw Error('collaboration_root_planning_journal_unavailable')
          return openCollaborationRootPlanningJournal(facility)
        } },
        (input, signal) => sessionCtx.sessionController.collaborationRootExecution(input, signal),
        (input, signal) => sessionCtx.sessionController.collaborationRootFeedback(input, signal),
        (input, signal, account) => sessionCtx.sessionController.collaborationRootConsumption(input, signal, account),
        (target, signal) => sessionCtx.sessionController.readCollaborationSourceSnapshot(target, signal),
        (input, signal) => sessionCtx.sessionController.captureCollaborationGroupRoot(input, signal),
        (input, signal) => origins.execute(input, signal),
        operationMemory,
        taskCoordination,
      )
      sessionCtx.effect(() => () => { lifetime.abort(); return owner.close() }, 'web-app: private analysis lifetime')
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-analysis',
        handler: (req, res) => handleDesktopCollaborationAnalysisRequest(req, res, analysisToken, owner, native, coldLocator),
      }))
    })
  }
  const sourceToken = process.env.DSH_PROFILE_SOURCE_TOKEN
  if (sourceToken && /^[A-Za-z0-9_-]{43}$/u.test(sourceToken)) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-native-room-preparation',
      handler: (req, res) => handleDesktopNativeRoomPreparationRequest(req, res, sourceToken,
        (target, signal) => readDesktopNativeRoomPreparation(ctx, target, signal)),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-bound-bot-rooms',
      handler: (req, res) => handleDesktopBoundBotRoomsRequest(req, res, sourceToken,
        async (query, signal) => {
          signal.throwIfAborted()
          const service = ctx.get('dsBotSlarkNativeRoom') as undefined | {
            roomsForBot?: (input: { botId: string; limit: number; cursor: string | null }) => Promise<unknown>
          }
          if (!service?.roomsForBot) return { state: 'upgrade_required' }
          const result = await service.roomsForBot({ botId: query.bot_id, limit: query.limit, cursor: query.cursor })
          signal.throwIfAborted()
          return result
        }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-native-room-retirement',
      handler: (req, res) => handleDesktopNativeRoomRetirementRequest(req, res, sourceToken,
        async (command, signal) => {
          signal.throwIfAborted()
          const service = ctx.get('dsBotSlarkNativeRoom') as undefined | {
            retireAgent?: (input: {
              roomId: string
              groupId: string
              memberId: string
              cycle: number
              projectId: string
              agentId: string
              name: string
            }) => Promise<unknown>
          }
          if (!service?.retireAgent) return { state: 'upgrade_required' }
          const result = await service.retireAgent({ roomId: command.room_id, groupId: command.group_id,
            memberId: command.member_id, cycle: command.cycle, projectId: command.project_id,
            agentId: command.agent_id, name: command.name })
          signal.throwIfAborted()
          return result
        }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-native-room',
      handler: (req, res) => handleDesktopNativeRoomRequest(req, res, sourceToken,
        async (roomId, signal) => {
          signal.throwIfAborted()
          const service = ctx.get('dsBotSlarkNativeRoom') as undefined | {
            prepare(input: { roomId: string }): Promise<unknown>
          }
          if (!service) throw Error('native_room_unavailable')
          const result = await service.prepare({ roomId })
          signal.throwIfAborted()
          return result
        }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-native-room-operations',
      handler: (req, res) => handleDesktopNativeRoomOperationRequest(req, res, sourceToken,
        async (command, signal) => {
          signal.throwIfAborted()
          const service = ctx.get('dsBotSlarkNativeRoom') as undefined | {
            joinAgent(input: Record<string, unknown>): Promise<unknown>
            roomMessages(input: Record<string, unknown>): Promise<unknown>
            roomTurns(input: Record<string, unknown>): Promise<unknown>
            acknowledgeTurns(input: Record<string, unknown>): Promise<unknown>
            acknowledgeMessages(input: Record<string, unknown>): Promise<unknown>
            appendAgentResultChunk(input: Record<string, unknown>): Promise<unknown>
            leaveAgent(input: Record<string, unknown>): Promise<unknown>
          }
          if (!service) throw Error('native_room_unavailable')
          const base = { roomId: command.room_id, memberId: command.member_id,
            cycle: command.cycle }
          const result = command.operation === 'join'
            ? await service.joinAgent({ ...base, groupId: command.group_id,
              projectId: command.project_id, agentId: command.agent_id, name: command.name })
            : command.operation === 'messages'
              ? await service.roomMessages({ ...base, afterSeq: command.after_seq,
                limit: command.limit })
              : command.operation === 'turns'
                ? await service.roomTurns({ ...base, afterSeq: command.after_seq,
                  limit: command.limit })
                : command.operation === 'turn-ack'
                  ? await service.acknowledgeTurns({ ...base, turnIds: command.turn_ids })
                  : command.operation === 'agent-result-chunk'
                    ? await service.appendAgentResultChunk({ ...base,
                      ...nativeAgentResultChunkFields(command) })
                    : command.operation === 'ack'
                      ? await service.acknowledgeMessages({ ...base, throughSeq: command.through_seq })
                      : await service.leaveAgent(base)
          signal.throwIfAborted()
          return result
        }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-bot-group',
      handler: (req, res) => handleDesktopBotGroupRequest(req, res, sourceToken, async (command, signal) => {
        signal.throwIfAborted()
        const service = ctx.get('dsBotSlarkExternalGroup') as undefined | {
          deliver(input: {
            schemaVersion: 1
            deliveryId: string
            groupId: string
            botId: string
            memberCycle: number
            messageSeq: number
            payloadDigest: string
            text: string
          }): Promise<unknown>
          receipt(input: {
            deliveryId: string
            groupId: string
            botId: string
            memberCycle: number
          }): Promise<unknown>
          resultPage(input: {
            groupId: string
            botId: string
            memberCycle: number
            after: number
            limit: 1
          }): Promise<unknown>
          acknowledgeResult(input: {
            groupId: string
            botId: string
            memberCycle: number
            deliveryId: string
            resultId: string
          }): Promise<unknown>
          revokeCycle(input: {
            groupId: string
            botId: string
            memberCycle: number
            version: number
            stopInFlight: boolean
          }): Promise<unknown>
          requestStopDelivery(input: {
            groupId: string
            botId: string
            memberCycle: number
            deliveryId: string
            requestId: string
          }): Promise<unknown>
        }
        if (!service) throw Error('bot_group_unavailable')
        const result = command.operation === 'deliver'
          ? await service.deliver({ schemaVersion: command.schemaVersion, deliveryId: command.deliveryId,
            groupId: command.groupId, botId: command.botId, memberCycle: command.memberCycle,
            messageSeq: command.messageSeq, payloadDigest: command.payloadDigest, text: command.text })
          : command.operation === 'receipt'
            ? await service.receipt({ deliveryId: command.deliveryId, groupId: command.groupId,
              botId: command.botId, memberCycle: command.memberCycle })
            : command.operation === 'result_page'
              ? await service.resultPage({ groupId: command.groupId, botId: command.botId,
                memberCycle: command.memberCycle, after: command.after, limit: command.limit })
              : command.operation === 'ack_result'
                ? await service.acknowledgeResult({ groupId: command.groupId, botId: command.botId,
                  memberCycle: command.memberCycle, deliveryId: command.deliveryId,
                  resultId: command.resultId })
                : command.operation === 'stop_delivery'
                  ? await service.requestStopDelivery({ groupId: command.groupId, botId: command.botId,
                    memberCycle: command.memberCycle, deliveryId: command.deliveryId,
                    requestId: command.requestId })
                  : await service.revokeCycle({ groupId: command.groupId, botId: command.botId,
                    memberCycle: command.memberCycle, version: command.version,
                    stopInFlight: command.stopInFlight })
        signal.throwIfAborted()
        return result
      }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-bot-session-identity',
      handler: (req, res) => handleDesktopBotSessionIdentityRequest(req, res, sourceToken,
        () => ctx.get('dsBotSlarkExternalGroup') as DesktopBotSessionIdentityProvider | undefined),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-bot-identity',
      handler: (req, res) => handleDesktopBotIdentityRequest(req, res, sourceToken, async (botId, signal) => {
        signal.throwIfAborted()
        const service = ctx.get('dsBotSlarkExternalGroup') as undefined | {
          resolveLocalBot(botId: string): Promise<{ botId: string; actorRef: string; displayName: string } | null>
        }
        if (!service) return null
        const identity = await service.resolveLocalBot(botId)
        signal.throwIfAborted()
        return identity === null ? null : {
          bot_id: identity.botId, actor_ref: identity.actorRef, display_name: identity.displayName,
        }
      }),
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/internal/desktop-bot-roster',
      handler: (req, res) => handleDesktopBotRosterRequest(req, res, sourceToken,
        async (afterBotId, limit, signal) => {
          signal.throwIfAborted()
          const service = ctx.get('dsBotSlarkExternalGroup') as undefined | {
            listLocalBots(input: { afterBotId: string; limit: number }): Promise<{
              bots: { botId: string; actorRef: string; displayName: string }[]
              nextCursor: string | null
            } | null>
          }
          if (!service) return null
          const page = await service.listLocalBots({ afterBotId, limit })
          signal.throwIfAborted()
          return page === null ? null : { bots: page.bots.map(bot => ({ bot_id: bot.botId,
            actor_ref: bot.actorRef, display_name: bot.displayName })), next_cursor: page.nextCursor }
        }),
    }))
    ctx.inject(['sessionController'], (sessionCtx) => {
      sessionCtx.effect(() => sessionCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-root',
        handler: (req, res) => handleDesktopCollaborationRootRequest(req, res, sourceToken,
          (target, signal) => sessionCtx.sessionController.inspectCollaborationRoot(target, signal)),
      }))
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
        kind: 'exact', path: '/internal/desktop-collaboration-reference-content',
        handler: (req, res) => handleDesktopCollaborationReferenceContentRequest(req, res, referenceToken,
          (query, signal) => {
            const { offset: _offset, reference_request_digest, ...target } = query
            return sessionCtx.sessionController.readCollaborationReferenceContent(target, reference_request_digest, signal)
          }),
      }))
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
  if (workspaceModelToken && /^[A-Za-z0-9_-]{43}$/u.test(workspaceModelToken)) {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
      workspaceCtx.effect(() => workspaceCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-archive-state',
        handler: (req, res) => handleDesktopCollaborationArchiveStateRequest(req, res, workspaceModelToken,
          async (target, signal) => {
            signal.throwIfAborted()
            const state = await workspaceCtx.workspaceRegistry.inspectCollaborationArchiveState({
              workspaceId: target.workspace_id, sessionId: target.session_id,
              token: target.archive_token, environmentId: target.environment_id,
              accountIssuer: target.account_issuer, accountSubject: target.account_subject,
            })
            signal.throwIfAborted()
            return { archive_phase: state.phase }
          }),
      }))
    })
  }
  const archiveTransitionToken = process.env.DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN
  if (archiveTransitionToken && /^[A-Za-z0-9_-]{43}$/u.test(archiveTransitionToken)) {
    ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
      workspaceCtx.effect(() => workspaceCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-group-input-fence',
        handler: (req, res) => handleDesktopGroupInputFenceRequest(req, res, archiveTransitionToken,
          async (challenge, signal) => {
            signal.throwIfAborted()
            const installed = await workspaceCtx.workspaceRegistry.installGroupInputFence({
              workspaceId: challenge.workspace_id, sessionId: challenge.session_id,
              groupId: challenge.group_id, groupVersion: challenge.group_version,
            })
            signal.throwIfAborted()
            return { workspace_id: installed.workspaceId, session_id: installed.sessionId,
              group_id: installed.groupId, group_version: installed.groupVersion }
          }),
      }))
      workspaceCtx.effect(() => workspaceCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-archive-intent',
        handler: (req, res) => handleDesktopCollaborationArchiveIntentRequest(req, res, archiveTransitionToken,
          async (target, signal) => {
            signal.throwIfAborted()
            const found = await workspaceCtx.workspaceRegistry.findCollaborationArchiveIntent({
              workspaceId: target.workspace_id, sessionId: target.session_id,
              environmentId: target.environment_id, accountIssuer: target.account_issuer,
              accountSubject: target.account_subject,
            })
            signal.throwIfAborted()
            return found === null ? { archive_phase: 'missing', archive_token: null }
              : { archive_phase: found.phase, archive_token: found.token }
          }),
      }))
      workspaceCtx.effect(() => workspaceCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-collaboration-archive-transition',
        handler: (req, res) => handleDesktopCollaborationArchiveTransitionRequest(req, res, archiveTransitionToken,
          async (target, signal) => {
            signal.throwIfAborted()
            const intent = {
              workspaceId: target.workspace_id as never, sessionId: target.session_id as never,
              token: target.archive_token, environmentId: target.environment_id,
              accountIssuer: target.account_issuer, accountSubject: target.account_subject,
            }
            const registry = workspaceCtx.workspaceRegistry
            if (target.action === 'stage') {
              const staged = await registry.stageCollaborationArchive(intent)
              signal.throwIfAborted()
              return { archive_phase: staged.phase ?? 'staged' }
            }
            else if (target.action === 'prepared') await registry.recordCollaborationArchivePrepared(intent)
            else if (target.action === 'archive') await registry.archivePreparedCollaborationSession(intent)
            else if (target.action === 'restore') await registry.restoreCollaborationSession(intent)
            else await registry.finishCollaborationArchiveRelease(intent)
            signal.throwIfAborted()
            return { archive_phase: ({ prepared: 'prepared', archive: 'archived',
              restore: 'restored', finish_release: 'released' } as const)[target.action] }
          }),
      }))
    })
  }
  const sessionControl = new DesktopSessionControl()
  const terminalStreams = new DesktopRemoteTerminalStreams(sessionControl)
  const desktopRemoteSessionToken = process.env.DSH_PROFILE_REMOTE_SESSION_TOKEN
  const remoteApprovalEvents = new DesktopRemoteApprovalEvents()
  const uiToken = process.env.DSH_PROFILE_REMOTE_UI_TOKEN
  const hasDesktopCarrier = [desktopRemoteSessionToken, uiToken].some(token => token !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(token))
  if (hasDesktopCarrier) ctx.inject(['connection', 'typertGateway'], (remoteCtx) => {
    const desktopPeer = remoteCtx.connection.createPeer({ principal: { kind: 'owner' } })
    if (desktopRemoteSessionToken && /^[A-Za-z0-9_-]{43}$/u.test(desktopRemoteSessionToken)) {
      const control = sessionControl
      remoteCtx.effect(() => remoteCtx.typertGateway.registerBrowserAdmission({
        invoke: (endpoint, args) => control.admitBrowserInvoke(endpoint, args),
        eventResult: sessionId => control.admitBrowserWrite(sessionId),
        localControlStatus: sessionId => control.browserStatus(sessionId),
        localControlTakeover: (sessionId, expectedEpoch) => control.takeoverBrowser(sessionId, expectedEpoch),
      }), 'web-app: Desktop browser Session admission')
      const isBotSessionOwner = (owner: unknown, botId: string, sessionId: string): boolean =>
        owner !== null && typeof owner === 'object' && !Array.isArray(owner) &&
        Object.keys(owner).sort().join(',') === 'botId,sessionId' &&
        Reflect.get(owner, 'botId') === botId && Reflect.get(owner, 'sessionId') === sessionId
      const executor = new DesktopRemoteSessionExecutor(
        bindDesktopRemoteGateway(remoteCtx.typertGateway, desktopPeer), remoteApprovalEvents, control, terminalStreams,
        async (operation, request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            sendLocalBotChat?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
            readLocalBotChatReceipt?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
          }
          const method = operation === 'bot.chat.send' ? service?.sendLocalBotChat : service?.readLocalBotChatReceipt
          if (!method) return null
          return method.call(service, request, signal)
        }, async (operation, request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            sendLocalBotRoom?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
            readLocalBotRoomReceipt?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
          }
          const method = operation === 'bot.room.send' ? service?.sendLocalBotRoom : service?.readLocalBotRoomReceipt
          if (!method) return null
          return method.call(service, request, signal)
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            updateLocalBotRoom?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.updateLocalBotRoom) return null
          return service.updateLocalBotRoom(request, signal)
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            createLocalBotRoom?: (input: Omit<typeof request, 'ownerBotId' | 'sessionId'>,
              signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.createLocalBotRoom) return null
          const owner = await service.resolveLocalBotSession({ botId: request.ownerBotId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.ownerBotId, request.sessionId)) return null
          return service.createLocalBotRoom({ expectedRevision: request.expectedRevision,
            members: [...request.members], name: request.name, notice: request.notice,
            replyMode: request.replyMode, adminBotId: request.adminBotId }, signal)
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            deleteLocalBotRoom?: (input: typeof request, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.deleteLocalBotRoom) return null
          return service.deleteLocalBotRoom(request, signal)
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            updateLocalBotSettings?: (input: Omit<typeof request, 'sessionId'>,
              signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.updateLocalBotSettings) return null
          const owner = await service.resolveLocalBotSession({ botId: request.botId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.botId, request.sessionId)) return null
          return service.updateLocalBotSettings({ botId: request.botId,
            expectedRevision: request.expectedRevision, change: request.change }, signal)
        }, async (request: HostBotDeleteRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            deleteLocalBot?: (input: Omit<HostBotDeleteRequest, 'sessionId'>,
              signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.deleteLocalBot) return null
          const owner = await service.resolveLocalBotSession({ botId: request.botId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.botId, request.sessionId)) return null
          return service.deleteLocalBot({ botId: request.botId,
            expectedRevision: request.expectedRevision }, signal)
        }, async (request: HostBotDuplicateRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            duplicateLocalBot?: (input: {
              sourceBotId: string
              copyRequestId: string
              expectedRevision: number
            }, signal: AbortSignal) => Promise<unknown>
            readLocalBotDuplicate?: (input: { sourceBotId: string; copyRequestId: string }, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.duplicateLocalBot || !service.readLocalBotDuplicate) return null
          const owner = await service.resolveLocalBotSession({ botId: request.sourceBotId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.sourceBotId, request.sessionId)) return null
          return request.mode === 'create'
            ? service.duplicateLocalBot({ sourceBotId: request.sourceBotId,
              copyRequestId: request.copyRequestId, expectedRevision: request.expectedRevision }, signal)
            : service.readLocalBotDuplicate({ sourceBotId: request.sourceBotId,
              copyRequestId: request.copyRequestId }, signal)
        }, async (request: HostBotCreateRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            createLocalBot?: (input: unknown, signal: AbortSignal) => Promise<unknown>
            readLocalBotCreate?: (input: unknown, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.createLocalBot || !service.readLocalBotCreate) return null
          const owner = await service.resolveLocalBotSession({ botId: request.ownerBotId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.ownerBotId, request.sessionId)) return null
          return request.mode === 'create'
            ? service.createLocalBot({ ownerBotId: request.ownerBotId,
              createRequestId: request.createRequestId, expectedRevision: request.expectedRevision,
              bot: request.bot }, signal)
            : service.readLocalBotCreate({ ownerBotId: request.ownerBotId,
              createRequestId: request.createRequestId }, signal)
        }, async (request: HostBotScheduleMutationRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            resolveLocalBotSession?: (input: { botId: string; sessionId: string }) => Promise<unknown>
            createLocalBotSchedule?: (input: unknown, signal: AbortSignal) => Promise<unknown>
            deleteLocalBotSchedule?: (input: unknown, signal: AbortSignal) => Promise<unknown>
            readLocalBotScheduleResult?: (input: unknown, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.resolveLocalBotSession || !service.createLocalBotSchedule ||
            !service.deleteLocalBotSchedule || !service.readLocalBotScheduleResult) return null
          const owner = await service.resolveLocalBotSession({ botId: request.ownerBotId,
            sessionId: request.sessionId })
          signal.throwIfAborted()
          if (!isBotSessionOwner(owner, request.ownerBotId, request.sessionId)) return null
          if (request.mode === 'status') return service.readLocalBotScheduleResult({
            ownerBotId: request.ownerBotId, requestId: request.requestId }, signal)
          if (request.mode === 'delete') return service.deleteLocalBotSchedule({
            ownerBotId: request.ownerBotId, requestId: request.requestId,
            sessionId: request.taskSessionId, id: request.taskId }, signal)
          return service.createLocalBotSchedule({ ownerBotId: request.ownerBotId,
            requestId: request.requestId, targetKind: request.targetKind, targetId: request.targetId,
            title: request.title, prompt: request.prompt, when: request.when }, signal)
        })
      remoteCtx.effect(() => remoteCtx.webServer.register({
        kind: 'exact', path: '/internal/desktop-remote-session',
        handler: (req, res) => handleDesktopRemoteSessionRequest(
          req, res, desktopRemoteSessionToken,
          (command, signal) => executor.execute(command, signal),
        ),
      }))
    }
    const desktopRemoteUiToken = uiToken
    if (desktopRemoteUiToken && /^[A-Za-z0-9_-]{43}$/u.test(desktopRemoteUiToken)) {
      const executor = new DesktopRemoteUiExecutor(bindDesktopRemoteGateway(remoteCtx.typertGateway, desktopPeer),
        () => remoteCtx.webServer.collectIndexInjections(desktopPeer),
        async (botId, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotChat?: (botId: string | null) => Promise<unknown>
          }
          if (!service?.readLocalBotChat) return null
          const value = await service.readLocalBotChat(botId)
          signal.throwIfAborted()
          return value
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            listLocalBotRooms?: (input: HostBotRoomListRequest) => Promise<unknown>
          }
          if (!service?.listLocalBotRooms) return null
          const value = await service.listLocalBotRooms(request)
          signal.throwIfAborted()
          return value
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotRoomHistory?: (input: HostBotRoomHistoryRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotRoomHistory) return null
          const value = await service.readLocalBotRoomHistory(request)
          signal.throwIfAborted()
          return value
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotRoomDetails?: (input: HostBotRoomDetailsRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotRoomDetails) return null
          const value = await service.readLocalBotRoomDetails(request)
          signal.throwIfAborted()
          return value
        }, async (request, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotSettings?: (input: HostBotSettingsRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotSettings) return null
          const value = await service.readLocalBotSettings(request)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotFoldersRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotFolders?: (input: HostBotFoldersRequest, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.readLocalBotFolders) return null
          const value = await service.readLocalBotFolders(request, signal)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotAvatarRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotAvatar?: (input: HostBotAvatarRequest, signal: AbortSignal) => Promise<unknown>
          }
          if (!service?.readLocalBotAvatar) return null
          const value = await service.readLocalBotAvatar(request, signal)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotMemoryRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotMemory?: (input: HostBotMemoryRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotMemory) return null
          const value = await service.readLocalBotMemory(request)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotRoomMemoryRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotRoomMemory?: (input: HostBotRoomMemoryRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotRoomMemory) return null
          const value = await service.readLocalBotRoomMemory(request)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotSchedulesRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotSchedules?: (input: HostBotSchedulesRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotSchedules) return null
          const value = await service.readLocalBotSchedules(request)
          signal.throwIfAborted()
          return value
        }, async (request: HostBotScheduleHistoryRequest, signal) => {
          signal.throwIfAborted()
          const service = remoteCtx.get('dsBotSlarkExternalGroup') as undefined | {
            readLocalBotScheduleHistory?: (input: HostBotScheduleHistoryRequest) => Promise<unknown>
          }
          if (!service?.readLocalBotScheduleHistory) return null
          const value = await service.readLocalBotScheduleHistory(request)
          signal.throwIfAborted()
          return value
        })
      const streamExecutor = new DesktopRemoteUiStreamExecutor(
        bindDesktopRemoteGateway(remoteCtx.typertGateway, desktopPeer), remoteApprovalEvents,
        request => remoteCtx.connection.createSharedFetchHandler('/api').fetch(request, desktopPeer), terminalStreams)
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
    }
  })
  // The loopback URL belongs to this host. Under SSH, the operator reaches it
  // The schema validates a present string; an explicit YAML `null` bypasses
  // the string transform and reaches here, meaning unset.
  const publicUrl = config.publicUrl ?? undefined
  const boundHost = ctx.webServer.host
  if (publicUrl === undefined && bindUrlHost(boundHost) === undefined) {
    throw new Error(
      `web-app: bind address ${JSON.stringify(boundHost)} carries an interface zone id, which no URL can express;`
      + ' pass --public-url with the root browsers actually reach it through',
    )
  }
  if (ctx.webServer.protocol === 'http:' && !isLoopbackHost(boundHost)) {
    console.warn(`dsh web: listening on ${boundHost} over plain HTTP; restrict this port to a trusted proxy or network`)
  }
  // The bind URL belongs to this host. Under SSH, the operator reaches it
  // through a local forwarding address that this process cannot derive.
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(launchEnvironmentOf(ctx))
  /** The advertised root: the canonical `publicUrl`, or the listener's own origin. */
  const appRootUrl = (): string => publicUrl ?? ctx.webServer.getOrigin()
  ctx.provide('webApp', { getAdvertisedUrl: appRootUrl } satisfies WebApp)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Advertised URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: appRootUrl() }),
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
        const webUrl = appRootUrl()
        const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl)
        ANNOUNCED_ROOTS.add(connectionCtx.root)
        if (config.printUrl) {
          console.log(`dsh web: ${authenticatedUrl}`)
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
