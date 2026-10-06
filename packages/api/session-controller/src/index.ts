import type { CollaborationConsumptionResult } from './collaboration-consumption-journal.ts'
import { openCollaborationConsumptionJournal, collaborationConsumptionCommit } from './collaboration-consumption-journal.ts'
import { createCollaborationFeedbackMessage, observeCollaborationFeedback, installCollaborationFeedbackCheckpoint, parseCollaborationFeedbackOperation } from './collaboration-feedback.ts'
import type { CollaborationFeedbackObservation } from './collaboration-feedback.ts'
import { openCollaborationRootExecutionJournal, parseCollaborationExecutionOperation } from './collaboration-root-execution-journal.ts'
import type { CollaborationRootExecutionJournal, CollaborationExecutionRecord } from './collaboration-root-execution-journal.ts'
/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { isDeepStrictEqual } from 'node:util'
import type { CollaborationPlanningPredecessor, CollaborationRootPlanningManifest } from './collaboration-root-planning-journal.ts'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { PreparedLlmSnapshotCall } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { CollaborationAnalysisRunner } from './collaboration-analysis.ts'
import type { CollaborationAnalysisManifest, CollaborationAnalysisResult } from './collaboration-analysis.ts'
import { parseCollaborationClarificationInput } from './collaboration-clarification-input.ts'
import type { CollaborationClarificationInput } from './collaboration-clarification-input.ts'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, nativeFileApplications, openNativeFileApplication, openNativeAssociatedPath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import { foldRequestHeader, SessionId } from '@deepseek-ai/dsh-session'
import { realpathNormalize, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { openCollaborationRootJournal, parseCollaborationRootLookup, parseCollaborationRootCaptureInput, parseCollaborationRootTarget, parseCollaborationRootAdmission } from './collaboration-root-journal.ts'
import type { CollaborationRootJournal, CollaborationRootCaptureInput, CollaborationRootSubmission, CollaborationRootDescriptor, CollaborationRootAdmission } from './collaboration-root-journal.ts'
import { openCollaborationSourceJournal, parseCollaborationSourceInput, parseCollaborationSourceCoordinates, describeCollaborationSource } from './collaboration-source-journal.ts'
import type { CollaborationSourceJournal, CollaborationSourceInput, CollaborationSourceSnapshot, CollaborationSourceCoordinates } from './collaboration-source-journal.ts'
import { openCollaborationDeliveryJournal, parseCollaborationDeliveryInput } from './collaboration-delivery-journal.ts'
import type { CollaborationDeliveryJournal, CollaborationDeliveryRecord } from './collaboration-delivery-journal.ts'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ApiSessionAgentController,
  hasApiSessionSubagentOwner,
  inspectApiSession,
  type ApiSessionAgentResult,
} from './agent.ts'
import { SessionCommandController } from './commands.ts'
import { SessionControlController } from './control.ts'
import { SessionHistoryController } from './history.ts'
import { SessionFileReferences } from './file-references.ts'
import { ApiSessionList } from './list.ts'
import { buildModelCatalog, hasProviderApiKey } from './catalog.ts'
import { foldModelSelection, installModelSelectionProjection, resolveModelSelection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { installAttachmentExport } from './attachment-export.ts'
import { SessionMediaReferences } from './media-references.ts'
import { ArchivedSessionGate } from './archived-session-gate.ts'
import type {
  ModelCatalog,
  SessionWorkspacePathApplication,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionDeleteRequest,
  SessionDeleteValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionForkRequest,
  SessionForkValue,
  SessionListRequest,
  SessionListValue,
  SessionCollaborationSourcesRequest,
  SessionCollaborationSourcesValue,
  SessionCollaborationSourceItem,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionProjectionsRequest,
  SessionProjectionsValue,
  SessionProjectionValues,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
  WorkspaceModelSelection,
} from './types.ts'

export type * from './types.ts'
export { ApiSessionNotFound } from './agent.ts'
export { SessionFileReferences } from './file-references.ts'
export { SessionSkillCatalog } from './skill-catalog.ts'
export { openCollaborationRootJournal, parseCollaborationRootSubmission } from './collaboration-root-journal.ts'
export type { CollaborationRootTarget, CollaborationRootDescriptor, CollaborationRootCaptureInput, CollaborationRootInput, CollaborationRootSubmission, CollaborationRootAdmission, CollaborationRootJournal } from './collaboration-root-journal.ts'
export { openCollaborationSourceJournal, describeCollaborationSource, parseCollaborationSourceInput, parseCollaborationSourceSnapshot, collaborationJournalDigest } from './collaboration-source-journal.ts'
export type {
  CollaborationSourceBody, CollaborationSourceSnapshot, CollaborationSourceJournal, CollaborationSourceInput,
  CollaborationSourceCoordinates,
} from './collaboration-source-journal.ts'
export { openCollaborationAnalysisJournal, createCollaborationAnalysisWriter } from './collaboration-analysis-journal.ts'
export type { CollaborationAnalysisJournal, CollaborationAnalysisJournalRecord, CollaborationAnalysisDispatchGrant } from './collaboration-analysis-journal.ts'
export { parseCollaborationClarificationInput, clarificationAnalysisMessage } from './collaboration-clarification-input.ts'
export type { CollaborationClarificationInput } from './collaboration-clarification-input.ts'
/** Process-local new preparation; its caller must durably authorize each fresh attempt before model dispatch. */
export type CollaborationRootPlanningPreparation = Readonly<{
  root: CollaborationRootSubmission
  analyze: (persist: (manifest: CollaborationRootPlanningManifest, signal: AbortSignal) => Promise<void>,
    cancellation: AbortSignal) => Promise<CollaborationAnalysisResult>
}>
export { openCollaborationRootPlanningJournal, createCollaborationRootPlanningWriter } from './collaboration-root-planning-journal.ts'
export type { CollaborationRootPlanningJournal, CollaborationRootPlanningManifest, CollaborationRootPlanningRecord,
  CollaborationRootPlanningDescriptor,
  CollaborationRootPlanningGrant, CollaborationPlanningPredecessor, CollaborationPlanningRequestId } from './collaboration-root-planning-journal.ts'
export { openCollaborationRootExecutionJournal, parseCollaborationExecutionOperation, parseCollaborationExecutionSelection, parseCollaborationExecutionReceipt } from './collaboration-root-execution-journal.ts'
export type { CollaborationRootExecutionJournal, CollaborationExecutionRecord, CollaborationExecutionCommandId, CollaborationExecutionSelection, CollaborationExecutionReceipt, CollaborationExecutionOperation } from './collaboration-root-execution-journal.ts'
export { openCollaborationDeliveryJournal, parseCollaborationDeliveryInput, parseCollaborationDeliveryRecord } from './collaboration-delivery-journal.ts'
export type { CollaborationDeliveryJournal, CollaborationDeliveryInput, CollaborationDeliveryRecord } from './collaboration-delivery-journal.ts'

/** Durable root metadata with either the first process-local analysis call or non-executable recovery. */
export type CollaborationRootCapture = Awaited<ReturnType<SessionController['captureCollaborationSource']>>
  & { readonly submission: CollaborationRootSubmission }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Session business API and Remote namespace owner. */
    sessionController: SessionController
  }
}

/** Session Controller deployment policy. */
export interface Config {
  /** Override platform desktop-opener detection. */
  readonly nativeOpen?: boolean
}

/** Host integrations replaceable by direct unit tests. */
export interface SessionControllerInternals {
  /** Native default-application handoff. */
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  readonly fileApplications?: typeof nativeFileApplications
  readonly openFileApplication?: typeof openNativeFileApplication
  /** Native file-manager handoff. */
  readonly revealPath?: (path: string, signal: AbortSignal) => Promise<void>
  /** Native handoff availability probe. */
  readonly canOpenPath?: () => boolean
}

// Read cancellation releases the queue; accepted journal writes still drain before disposal.
async function waitForCollaborationSourceRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new DOMException('Source read cancelled', 'AbortError')) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([read, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/** Host service backing the generated `ctx.remote.session` namespace. */
export class SessionController extends TypertRemoteService {
  static inject = [
    'agentDefaultModel',
    'agents',
    'attachments',
    'connection',
    'fileUploads',
    'fs',
    'llm',
    'sessions',
    'sessionProjections',
    'sessionQuery',
    'typert',
    'workspaceRegistry',
  ]

  static Config: z<Config> = z.object({
    nativeOpen: z.boolean(),
  })

  private readonly agents: ApiSessionAgentController
  private readonly commands: SessionCommandController
  private readonly controlState: SessionControlController
  private readonly history: SessionHistoryController
  private readonly listState: ApiSessionList
  private readonly openPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly fileApplications: typeof nativeFileApplications
  private readonly openFileApplication: typeof openNativeFileApplication
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly promotions = new Set<Promise<void>>()
  private readonly collaborationLifetime = new AbortController()
  private readonly collaborationAnalysis = new CollaborationAnalysisRunner(this.collaborationLifetime.signal)
  private collaborationCaptureTail: Promise<void> = Promise.resolve()
  private collaborationRootExecutionJournal?: Promise<CollaborationRootExecutionJournal>
  private collaborationRootJournal?: Promise<CollaborationRootJournal>
  private collaborationJournal?: Promise<CollaborationSourceJournal>
  private readonly collaborationRootTransportTraces = new WeakMap<CollaborationSourceSnapshot, string>()
  private collaborationConsumptionJournal?: Promise<Awaited<ReturnType<typeof openCollaborationConsumptionJournal>>>
  private readonly collaborationConsumerLive = new Map<string, { sessionId: SessionId; expiresAt: number; signal: AbortSignal }>()
  private collaborationDeliveryJournal?: Promise<CollaborationDeliveryJournal>

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    // Host identity reads use the owning Profile's registry, never a caller's Cordis scope.
    this.inspectWorkspaceModelSelection = this.inspectWorkspaceModelSelection.bind(this)
    this.prepareCollaborationRootPlanning = this.prepareCollaborationRootPlanning.bind(this)
    this.prepareWorkspaceModelSnapshot = this.prepareWorkspaceModelSnapshot.bind(this)
    this.collaborationRootConsumption = this.collaborationRootConsumption.bind(this)
    this.collaborationRootFeedback = this.collaborationRootFeedback.bind(this)
    this.collaborationRootExecution = this.collaborationRootExecution.bind(this)
    this.readCollaborationRoot = this.readCollaborationRoot.bind(this)
    this.acceptCollaborationRoot = this.acceptCollaborationRoot.bind(this)
    this.inspectCollaborationRoot = this.inspectCollaborationRoot.bind(this)
    this.captureCollaborationRoot = this.captureCollaborationRoot.bind(this)
    this.captureCollaborationSource = this.captureCollaborationSource.bind(this)
    this.readCollaborationSourceSnapshot = this.readCollaborationSourceSnapshot.bind(this)
    this.inspectCollaborationSource = this.inspectCollaborationSource.bind(this)
    this.receiveCollaborationDelivery = this.receiveCollaborationDelivery.bind(this)
    ctx.effect(() => async () => {
      this.collaborationLifetime.abort(new DOMException('Profile source capture disposed', 'AbortError'))
      await this.collaborationCaptureTail
      const journal = await this.collaborationJournal?.catch(() => undefined)
      await journal?.close()
      const executions = await this.collaborationRootExecutionJournal?.catch(() => undefined)
      await executions?.close()
      const roots = await this.collaborationRootJournal?.catch(() => undefined)
      await roots?.close()
      const replies = await this.collaborationDeliveryJournal?.catch(() => undefined)
      await replies?.close()
      const consumptions = await this.collaborationConsumptionJournal?.catch(() => undefined)
      await consumptions?.close()
      this.collaborationConsumerLive.clear()
    }, 'session-controller.collaboration-sources')
    installCollaborationFeedbackCheckpoint(ctx, async (sessionId) => {
      this.collaborationLifetime.signal.throwIfAborted()
      if (this.collaborationRootJournal === undefined) {
        const facility = ctx.get('storageDomain')
        if (!facility) return false
        this.collaborationRootJournal = openCollaborationRootJournal(facility)
      }
      const roots = await this.collaborationRootJournal
      this.collaborationLifetime.signal.throwIfAborted()
      return roots.hasSession(sessionId)
    }, sessionId => this.checkpointCollaborationConsumption(sessionId))
    installModelSelectionProjection(ctx)
    this.agents = new ApiSessionAgentController(ctx)
    this.commands = new SessionCommandController(ctx, this.agents, process.cwd())
    ctx.effect(() => ctx.fileUploads.registerAgentResolver(async (sessionId) => {
      const result = await this.agents.resolveAgent(sessionId)
      if ('error' in result) throw result.error
      return result.agent
    }), 'session-controller: file-upload Agent resolver')
    this.controlState = new SessionControlController(ctx)
    // Registered before history so reverse-order teardown closes every
    // follower before waiting for already-admitted promotions.
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.promotions])
    }, 'session-controller.promotions')
    this.history = new SessionHistoryController(ctx, (observation) => { this.promote(observation) })
    this.listState = new ApiSessionList(ctx)
    this.fileApplications = internals.fileApplications ?? nativeFileApplications
    this.openFileApplication = internals.openFileApplication ?? openNativeFileApplication
    this.openPath = internals.openPath ?? openNativeAssociatedPath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    if (ctx.get('connection') !== undefined) installAttachmentExport(ctx)
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)
    ctx.plugin(ArchivedSessionGate)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
    const publishAgentAvailability = ({ agent }: { agent: Agent }): undefined => {
      if (ctx.sessions.get(agent.id) === agent.session) {
        ctx.emit('api-session/added', this.listState.summaryFor(agent.session))
      }
    }
    ctx.on('agent/created', publishAgentAvailability)
    ctx.on('agent/disposed', publishAgentAvailability)
    ctx.on('agent/status', ({ agent, status }) => {
      ctx.emit('api-session/status', agent.id, status === 'running')
    })
    ctx.on('agent/error', ({ agent, error }) => {
      ctx.emit('api-session/error', agent.id, errorChain(error))
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'request/header') {
        const agent = ctx.agents.get(session.id)
        if (agent?.session === session) this.agents.consumeSelection(
          agent,
          event.data.header.config.provider,
          event.data.header.config.model,
          event.data.header.config.reasoningEffort,
        )
      }
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
      ctx.emit('api-session/activity', session.id, event.time)
    })
  }

  private promote(observation: SessionObservation): void {
    const sessionId = observation.header.id
    const task = (async () => {
      using ownedObservation = observation
      const result = await this.agents.resolveObservedAgent(ownedObservation)
      if ('error' in result) this.ctx.emit('api-session/error', sessionId, result.error.message)
    })().catch((error: unknown) => {
      this.ctx.logger.error(`session-controller: background activation for "${sessionId}" failed: ${errorChain(error)}`)
    })
    this.promotions.add(task)
    void task.finally(() => { this.promotions.delete(task) })
  }

  /**
   * Resolve or resume one ordinary Session for another Host API domain.
   * @param sessionId - Session identity whose Agent owns the operation.
   * @returns the live Agent or the stable Session-domain failure.
   */
  resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.agents.resolveAgent(sessionId)
  }

  /**
   * Inspect one attached or persisted Session without activating its Agent.
   * @param sessionId - durable Session identity.
   * @param signal - optional caller cancellation for persistence reads.
   * @returns the current attached state or persisted header and event prefix.
   */
  inspect(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return Promise.resolve({
        meta: attached.header,
        inheritedEventCount: attached.inheritedEventCount,
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        events: attached.snapshotEvents(),
      })
    }
    return inspectApiSession(this.ctx, sessionId, signal)
  }

  /**
   * Capture workspace membership and the next model choice for a trusted Host caller.
   * Does not resume an Agent, append events, or invoke a provider. This Host-only
   * read supplies neither account authentication nor an executable adapter snapshot.
   * @param sessionId - ordinary Session identity registered under the workspace.
   * @param workspaceId - registry UUID; filesystem paths are not identities.
   * @param signal - optional cancellation, checked before and after asynchronous reads.
   * @returns an immutable minimal selection captured after membership revalidation.
   * @throws when the workspace is absent, ownership changes, or the caller cancels.
   */
  async inspectWorkspaceModelSelection(
    sessionId: SessionId,
    workspaceId: WorkspaceId,
    signal?: AbortSignal,
  ): Promise<WorkspaceModelSelection> {
    const { attached, inspection, agent } = await this.inspectCollaborationMembership(sessionId, workspaceId, signal)
    const state = attached === undefined
      ? foldModelSelection(inspection.events)
      : this.ctx.sessionProjections.stateOf(attached, 'modelSelection')
    if (state === undefined) throw new Error('api-session: required modelSelection projection is not registered')
    const choice = agent === undefined
      ? resolveModelSelection(
        state.pending,
        attached?.requestHeader() ?? foldRequestHeader(inspection.events),
        () => this.ctx.agentDefaultModel.currentSelection(),
      )
      : this.agents.inspectSelectionFor(agent)
    // Copy only public choice fields even if a Host integration supplies extra settings.
    const selection = Object.freeze({
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
    return Object.freeze({ workspaceId, sessionId, selection })
  }

  private async inspectCollaborationMembership(sessionId: SessionId, workspaceId: WorkspaceId, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error('collaboration_workspace_not_found')
    const mismatch = () => new Error('collaboration_session_workspace_mismatch')
    if (!workspace.sessionIds.includes(sessionId)
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) throw mismatch()
    const attached = this.ctx.sessions.get(sessionId)
    const inspection = attached === undefined
      ? await this.inspect(sessionId, signal)
      : { meta: attached.header, events: [] }
    signal?.throwIfAborted()
    if (inspection.meta.id !== sessionId || inspection.meta.cwd === undefined
      || inspection.meta.origin === 'subagent') throw mismatch()
    let cwd: string
    try {
      cwd = await realpathNormalize(inspection.meta.cwd)
    } catch {
      signal?.throwIfAborted()
      throw mismatch()
    }
    signal?.throwIfAborted()
    if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace
      || !workspace.sessionIds.includes(sessionId) || cwd !== workspace.path
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
      || this.ctx.sessions.get(sessionId) !== attached) throw mismatch()
    const agent = this.ctx.agents.get(sessionId)
    if (hasApiSessionSubagentOwner(this.ctx, { header: inspection.meta }, agent)
      || (agent !== undefined && (agent.session !== attached || agent.session.header !== inspection.meta))) throw mismatch()
    return { workspace, attached, inspection, agent }
  }

  /**
   * Prepare the source Session's next model under this Profile's registry. Recheck
   * workspace/session ownership and selection after credential preparation. The
   * returned call is process-local and one-shot; this does not issue Source authority,
   * resume an Agent, append events, or send a model request. No Remote method is exposed.
   * @param sessionId - ordinary Session registered under this workspace.
   * @param workspaceId - WorkspaceRegistry UUID.
   * @param signal - owning Host operation's cancellation, retained through dispatch.
   * @returns workspace/session identities and the captured executable model call with an 8192-token output cap.
   * @throws on ownership/selection change, unsupported capture, preparation failure or cancellation.
   */
  async prepareWorkspaceModelSnapshot(
    sessionId: SessionId, workspaceId: WorkspaceId, signal: AbortSignal,
  ): Promise<Readonly<{ workspaceId: WorkspaceId; sessionId: SessionId; prepared: PreparedLlmSnapshotCall }>> {
    signal.throwIfAborted()
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    const session = this.ctx.sessions.get(sessionId)
    const selected = await this.inspectWorkspaceModelSelection(sessionId, workspaceId, signal)
    const prepared = await this.ctx.llm.prepareSnapshot({
      provider: selected.selection.provider,
      model: selected.selection.model,
      maxTokens: 8192,
      ...selected.selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected.selection.reasoningEffort) },
    }, signal)
    const current = await this.inspectWorkspaceModelSelection(sessionId, workspaceId, signal)
    if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
      throw new Error('collaboration_session_workspace_mismatch')
    }
    if (current.selection.provider !== selected.selection.provider || current.selection.model !== selected.selection.model ||
      current.selection.reasoningEffort !== selected.selection.reasoningEffort) {
      throw new Error('collaboration_model_selection_changed')
    }
    signal.throwIfAborted()
    return Object.freeze({ workspaceId, sessionId, prepared })
  }

  /**
   * Capture user content under this Profile's registry and actual prepared model.
   * Persist before returning the process-local call. Duplicate/restarted input returns
   * only its original snapshot, never a new executable handle or a model request. First capture
   * exposes Host-only analyze and analyzeClarification sharing one one-shot call. The caller
   * durably commits the full manifest before dispatch; clarification rereads all original/reply Sources.
   * The Profile bounds calls and rechecks original membership before and after that commit.
   * This Host-only queued operation has no Remote endpoint and grants no cloud authority.
   * @param input - exact Source coordinates, raw text and trusted classified mentions; no model or commit fields.
   * @param signal - caller cancellation, combined with the owning Profile lifetime through dispatch.
   * @returns first durable capture with its one-shot call, or original non-executable recovery.
   * @throws on invalid input, unavailable journal, changed ownership/selection, conflict or cancellation.
   */
  async captureCollaborationSource(input: CollaborationSourceInput, signal: AbortSignal): Promise<
    | Readonly<{ kind: 'captured'
      snapshot: CollaborationSourceSnapshot
      prepared: PreparedLlmSnapshotCall
      analyze: (persist: (manifest: CollaborationAnalysisManifest, signal: AbortSignal) => Promise<void>,
        cancellation: AbortSignal) => Promise<CollaborationAnalysisResult>
      analyzeClarification: (input: CollaborationClarificationInput,
        persist: (manifest: CollaborationAnalysisManifest, signal: AbortSignal) => Promise<void>,
        cancellation: AbortSignal) => Promise<CollaborationAnalysisResult> }>
    | Readonly<{ kind: 'recovered'; snapshot: CollaborationSourceSnapshot }>
  > {
    const captured = parseCollaborationSourceInput(input)
    const ownedSignal = AbortSignal.any([signal, this.collaborationLifetime.signal])
    ownedSignal.throwIfAborted()
    const waitForRead = <T>(read: Promise<T>) => waitForCollaborationSourceRead(read, ownedSignal)
    const sessionId = SessionId(captured.session_id), workspaceId = WorkspaceId(captured.workspace_id)
    const operation = this.collaborationCaptureTail.then(async () => {
      ownedSignal.throwIfAborted()
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      const session = this.ctx.sessions.get(sessionId)
      const selected = await waitForRead(this.inspectWorkspaceModelSelection(sessionId, workspaceId, ownedSignal))
      const inspectCurrent = async () => {
        const current = await waitForRead(this.inspectWorkspaceModelSelection(sessionId, workspaceId, ownedSignal))
        if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
          throw new Error('collaboration_session_workspace_mismatch')
        }
        return current
      }
      if (this.collaborationJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw new Error('collaboration_source_journal_unavailable')
        this.collaborationJournal = openCollaborationSourceJournal(facility)
      }
      const journal = await waitForRead(this.collaborationJournal)
      ownedSignal.throwIfAborted()
      const previous = journal.read(captured)
      if (previous !== undefined) {
        const snapshot = await journal.capture({ ...captured, model_snapshot: previous.model_snapshot }, ownedSignal)
        await inspectCurrent()
        ownedSignal.throwIfAborted()
        return Object.freeze({ kind: 'recovered' as const, snapshot })
      }
      const prepared = await waitForRead(this.prepareWorkspaceModelSnapshot(sessionId, workspaceId, ownedSignal))
      const model = prepared.prepared.snapshot
      if (model.provider !== selected.selection.provider || model.model !== selected.selection.model
        || (selected.selection.reasoningEffort !== undefined && model.reasoning_effort !== selected.selection.reasoningEffort)) {
        throw new Error('collaboration_model_selection_changed')
      }
      const checkSelection = async () => {
        const current = await inspectCurrent()
        // Compare the Session intent, not adapter-materialized reasoning defaults.
        if (current.selection.provider !== selected.selection.provider || current.selection.model !== selected.selection.model
          || current.selection.reasoningEffort !== selected.selection.reasoningEffort) {
          throw new Error('collaboration_model_selection_changed')
        }
      }
      await checkSelection()
      const snapshot = await journal.capture({ ...captured, model_snapshot: prepared.prepared.snapshot }, ownedSignal)
      await checkSelection()
      ownedSignal.throwIfAborted()
      return Object.freeze({ kind: 'captured' as const, snapshot, prepared: prepared.prepared,
        analyze: (persist: (manifest: CollaborationAnalysisManifest, signal: AbortSignal) => Promise<void>, cancellation: AbortSignal) => {
          const analysisSignal = AbortSignal.any([ownedSignal, cancellation])
          return this.collaborationAnalysis.run(snapshot, prepared.prepared, async (manifest, signal) => {
            await inspectCurrent()
            signal.throwIfAborted()
            await persist(manifest, signal)
            signal.throwIfAborted()
            await inspectCurrent()
            signal.throwIfAborted()
          }, analysisSignal, this.collaborationRootTransportTraces.get(snapshot))
        },
        analyzeClarification: async (input: CollaborationClarificationInput,
          persist: (manifest: CollaborationAnalysisManifest, signal: AbortSignal) => Promise<void>, cancellation: AbortSignal) => {
          const clarification = parseCollaborationClarificationInput(input)
          const analysisSignal = AbortSignal.any([ownedSignal, cancellation])
          if (!deepEqualJson(clarification.reply_snapshot, snapshot)) throw Error('collaboration_clarification_source_mismatch')
          const verifySources = async () => {
            await checkSelection()
            for (const expected of [clarification.original_snapshot, clarification.reply_snapshot,
              ...clarification.prior_replies.map(reply => reply.snapshot)]) {
              const { workspace_id, session_id, source_message_id, source_revision } = expected
              const actual = await this.readCollaborationSourceSnapshot(
                { workspace_id, session_id, source_message_id, source_revision }, analysisSignal)
              if (!deepEqualJson(actual, expected)) throw Error('collaboration_clarification_source_mismatch')
            }
            analysisSignal.throwIfAborted()
            await checkSelection()
          }
          await verifySources()
          return this.collaborationAnalysis.runClarification(clarification, prepared.prepared, async (manifest, signal) => {
            await verifySources()
            signal.throwIfAborted()
            await persist(manifest, signal)
            signal.throwIfAborted()
            await verifySources()
            signal.throwIfAborted()
          }, analysisSignal)
        },
      })
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Persist a new logical root before exposing its prepared analysis call. This opt-in Host API
   * does not classify continuations, authenticate namespaces/grants or submit to the cloud.
   * The source journal may commit first; failure leaves an inert source, never a published partial root.
   * @param value - Original source and current Host-authorized namespace/policy; root IDs are generated locally.
   * @param signal - Cancellation combined with Profile disposal; accepted writes drain on disposal.
   * @returns Original source and atomic source/root/outbox aggregate; recovered input has no executable call.
   */
  async captureCollaborationRoot(value: CollaborationRootCaptureInput, signal: AbortSignal): Promise<CollaborationRootCapture> {
    const input = parseCollaborationRootCaptureInput(value)
    const owned = AbortSignal.any([signal, this.collaborationLifetime.signal])
    const captured = await this.captureCollaborationSource(input.source, owned)
    const operation = this.collaborationCaptureTail.then(async () => {
      owned.throwIfAborted()
      const sessionId = SessionId(input.source.session_id), workspaceId = WorkspaceId(input.source.workspace_id)
      const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
      const current = async () => {
        await waitForCollaborationSourceRead(this.inspectCollaborationMembership(sessionId, workspaceId, owned), owned)
        if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
          throw Error('collaboration_session_workspace_mismatch')
        }
        owned.throwIfAborted()
      }
      await current()
      if (this.collaborationRootJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw Error('collaboration_root_journal_unavailable')
        this.collaborationRootJournal = openCollaborationRootJournal(facility)
      }
      const journal = await waitForCollaborationSourceRead(this.collaborationRootJournal, owned)
      await current()
      const sourceDigest = describeCollaborationSource(captured.snapshot).snapshot_digest
      const submission = await journal.capture({ ...input, source: captured.snapshot,
        objective_ref: input.objective_ref ?? ('source-v1:' + sourceDigest),
        task_grant_ref: input.task_grant_ref ?? ('intent-v1:' + sourceDigest) }, owned)
      await current()
      this.collaborationRootTransportTraces.set(captured.snapshot, submission.root_trace_id)
      return Object.freeze({ ...captured, submission })
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return operation
  }

  /** Prepare a fresh one-shot analysis using an admitted root's original model and current credentials.
   * The original Source remains immutable. Membership is rechecked after preparation and around input/grant persistence.
   * This Host-only method has no Remote endpoint and grants no cloud authority.
   * @param value - Original namespace, command and Source lookup; no model overrides.
   * @param predecessor - Local journal reference selected by the private owner; cloud eligibility remains separate.
   * @param signal - Operation cancellation retained through the prepared call.
   * @returns original admitted root and private one-shot analysis closure, never a recovered executable handle.
   */
  async prepareCollaborationRootPlanning(value: unknown, predecessor: CollaborationPlanningPredecessor,
    signal: AbortSignal): Promise<CollaborationRootPlanningPreparation> {
    const target = parseCollaborationRootTarget(value), owned = AbortSignal.any([signal, this.collaborationLifetime.signal])
    const root = await this.readCollaborationRoot(target, owned)
    if (root.state !== 'admitted') throw Error('collaboration_root_not_admitted')
    const workspaceId = WorkspaceId(root.source.workspace_id), sessionId = SessionId(root.source.session_id)
    const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
    const current = async (active: AbortSignal) => {
      const latest = await this.readCollaborationRoot(target, active)
      active.throwIfAborted()
      if (!isDeepStrictEqual(latest, root) || this.ctx.workspaceRegistry.get(workspaceId) !== workspace
        || this.ctx.sessions.get(sessionId) !== session) throw Error('collaboration_session_workspace_mismatch')
    }
    const model = root.source.model_snapshot
    const prepared = await waitForCollaborationSourceRead(this.ctx.llm.prepareSnapshot({ provider: model.provider,
      model: model.model, maxTokens: 8192,
      ...(model.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning_effort) }),
    }, owned), owned)
    await current(owned)
    if (prepared.snapshot.provider !== model.provider || prepared.snapshot.model !== model.model
      || prepared.snapshot.reasoning_effort !== model.reasoning_effort) throw Error('collaboration_model_selection_changed')
    return Object.freeze({ root, analyze: (persist, cancellation) => {
      const active = AbortSignal.any([owned, cancellation])
      return this.collaborationAnalysis.runRootAttempt(root, predecessor, prepared, async (manifest, running) => {
        await current(running)
        await persist(manifest, running)
        await current(running)
      }, active)
    } })
  }

  /**
   * Read root signing metadata from the committed aggregate under current Profile membership.
   * @param value - Exact namespace, original command and Source coordinates; root overrides reject.
   * @param signal - Parent cancellation combined with Profile disposal.
   * @returns Frozen original binding without Source content, model preparation or signing authority.
   */
  async inspectCollaborationRoot(value: unknown, signal: AbortSignal): Promise<CollaborationRootDescriptor> {
    const entry = await this.readCollaborationRoot(parseCollaborationRootTarget(value), signal)
    return Object.freeze({ namespace_id: entry.namespace_id, command_id: entry.command_id,
      root_task_id: entry.root_task_id, root_trace_id: entry.root_trace_id, payload_digest: entry.payload_digest,
      source_descriptor: describeCollaborationSource(entry.source) })
  }

  /**
   * Read the committed root aggregate without model preparation or activation.
   * @param value - Namespace and original Source coordinates, optionally with the original command; supplied by the authenticated parent.
   * @param signal - Request cancellation combined with Profile disposal.
   * @returns Immutable pending or admitted record; changed membership and unknown roots reject.
   */
  async readCollaborationRoot(value: unknown, signal: AbortSignal): Promise<CollaborationRootSubmission> {
    return this.accessCollaborationRoot(value, signal)
  }

  /**
   * Durably retain the original cloud admission receipt after parent Host authentication.
   * @param value - Original namespace, command and Source coordinates.
   * @param receipt - Cloud receipt verified by the parent; this method validates identity, not cloud authority.
   * @param signal - Cancellation before write; accepted writes drain, but cancellation may hide the acknowledgment.
   * @returns Committed admitted record; uncertainty requires rereading the original root, never recapture.
   */
  async acceptCollaborationRoot(value: unknown, receipt: unknown, signal: AbortSignal): Promise<CollaborationRootSubmission> {
    return this.accessCollaborationRoot(parseCollaborationRootTarget(value), signal, parseCollaborationRootAdmission(receipt))
  }

  /**
   * Retain exact concrete execution confirmations in this Profile before Main sends them to the cloud.
   * This private operation has no Remote endpoint and supplies no cloud authorization or model activity.
   * @param value - Exact read/prepare/accept operation with original root lookup and frozen task references.
   * @param signal - Caller cancellation combined with Profile disposal; accepted writes drain.
   * @returns Durable command/receipt, or null for a missing read. Current membership is checked around storage.
   */
  async collaborationRootExecution(value: unknown, signal: AbortSignal): Promise<CollaborationExecutionRecord | null> {
    const command = parseCollaborationExecutionOperation(value)
    const owned = AbortSignal.any([signal, this.collaborationLifetime.signal])
    const workspaceId = WorkspaceId(command.target.workspace_id), sessionId = SessionId(command.target.session_id)
    const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
    const root = await this.readCollaborationRoot(command.target, owned)
    const current = this.collaborationMembershipCheck(sessionId, workspaceId, owned, session, workspace)
    const operation = this.collaborationCaptureTail.then(async () => {
      await current()
      if (this.collaborationRootExecutionJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (!facility) throw Error('collaboration_execution_journal_unavailable')
        this.collaborationRootExecutionJournal = openCollaborationRootExecutionJournal(facility)
      }
      const journal = await waitForCollaborationSourceRead(this.collaborationRootExecutionJournal, owned)
      await current()
      const result = command.action === 'read' ? journal.read(root, command.selection) ?? null
        : command.action === 'prepare' ? await journal.prepare(root, command.selection, owned)
          : await journal.accept(root, command.selection, command.receipt, owned)
      await current()
      return result
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Read durable original-Session consumption evidence or queue an explicitly authorized result once.
   * The parent authenticates current cloud result/continuation authority; root admission alone is insufficient.
   * Enqueue requires an attached idle Agent, an empty inbox and the exact observed Session prefix. It never wakes a model.
   * @param value - Private read/enqueue command with original root, frozen task and immutable delivery lookup.
   * @param signal - Parent lifetime combined with Profile disposal; accepted Session writes drain through flush.
   * @returns Persisted enqueue/consumption evidence. Removed or claimed messages are never automatically reinserted.
   */
  async collaborationRootFeedback(value: unknown, signal: AbortSignal): Promise<CollaborationFeedbackObservation> {
    const parsed = parseCollaborationFeedbackOperation(value)
    if (parsed.action !== 'read' && parsed.action !== 'enqueue') throw Error('collaboration_feedback_operation_invalid')
    const result = await this.accessCollaborationFeedback(parsed, signal)
    if (!('status' in result)) throw Error('collaboration_feedback_operation_invalid')
    return result
  }

  /** Execute a private durable consumer command under authenticated Main's current authority.
   * @param value - Consumer read/prepare/start, original root and exact delivery; start requires a fresh cloud grant.
   * @param signal - Current parent and Profile lifetime; recovery never restores live wake permission.
   * @returns Durable record and observation; only first start may wake the attached original Agent.
   */
  async collaborationRootConsumption(value: unknown, signal: AbortSignal): Promise<CollaborationConsumptionResult> {
    const parsed = parseCollaborationFeedbackOperation(value)
    if (parsed.action === 'read' || parsed.action === 'enqueue') throw Error('collaboration_consumption_operation_invalid')
    const result = await this.accessCollaborationFeedback(parsed, signal)
    if ('status' in result) throw Error('collaboration_consumption_operation_invalid')
    const commit = result.record ? collaborationConsumptionCommit(result.record) : undefined
    return { ...result, ...(commit ? { commit } : {}) }
  }

  private async openConsumptionJournal() {
    if (!this.collaborationConsumptionJournal) {
      const facility = this.ctx.get('storageDomain')
      if (!facility) throw Error('collaboration_consumption_journal_unavailable')
      this.collaborationConsumptionJournal = openCollaborationConsumptionJournal(facility)
    }
    return this.collaborationConsumptionJournal
  }

  private async checkpointCollaborationConsumption(sessionId: SessionId): Promise<string | undefined> {
    const journal = await this.openConsumptionJournal()
    const records = journal.records().filter(r => r.binding.source_locator.session_id === sessionId && r.state !== 'prepared')
    if (!records.length) return
    const persistence = this.ctx.get('sessionPersistence')
    if (!persistence) throw Error('collaboration_consumption_persistence_unavailable')
    const handle = await persistence.open(sessionId, 'read')
    try {
      const { events } = await handle.read()
      const currentStep = events.findLast(e => e.type === 'step/start')
      if (currentStep?.type !== 'step/start') throw Error('collaboration_consumption_step_missing')
      for (const record of records) {
        const admitted = events.find(e => e.type === 'user/message' && e.data.id === record.binding.message_id)
        if (admitted?.type !== 'user/message') continue
        const observation = observeCollaborationFeedback(events, admitted.data)
        if (observation.consuming_step?.turn !== currentStep.data.turn) continue
        const live = this.collaborationConsumerLive.get(record.binding.message_id)
        if (!live || live.sessionId !== sessionId || live.signal.aborted || Date.now() >= live.expiresAt)
          throw Error('collaboration_consumption_reconciliation_required')
        await journal.consume(record.binding, observation, this.collaborationLifetime.signal)
        live.signal.throwIfAborted()
        const request = await journal.request(record.binding, currentStep.data, live.signal)
        live.signal.throwIfAborted()
        return request.traceparent
      }
    } finally { await handle.close() }
  }

  private async accessCollaborationFeedback(value: unknown, signal: AbortSignal) {
    const command = parseCollaborationFeedbackOperation(value)
    const owned = AbortSignal.any([signal, this.collaborationLifetime.signal])
    const sessionId = SessionId(command.target.session_id), workspaceId = WorkspaceId(command.target.workspace_id)
    const session = this.ctx.sessions.get(sessionId), workspace = this.ctx.workspaceRegistry.get(workspaceId)
    const execution = await this.collaborationRootExecution({ action: 'read', target: command.target, selection: command.selection }, owned)
    if (!execution || execution.state !== 'admitted') throw Error('collaboration_feedback_execution_not_admitted')
    const root = await this.readCollaborationRoot(command.target, owned)
    const current = async (): Promise<void> => {
      await waitForCollaborationSourceRead(this.inspectCollaborationMembership(sessionId, workspaceId, owned), owned)
      if (this.ctx.sessions.get(sessionId) !== session || this.ctx.workspaceRegistry.get(workspaceId) !== workspace)
        throw Error('collaboration_session_workspace_mismatch')
      owned.throwIfAborted()
    }
    const operation = this.collaborationCaptureTail.then(async () => {
      await current()
      if (!this.collaborationDeliveryJournal) {
        const facility = this.ctx.get('storageDomain')
        if (!facility) throw Error('collaboration_delivery_journal_unavailable')
        this.collaborationDeliveryJournal = openCollaborationDeliveryJournal(facility)
      }
      const journal = await waitForCollaborationSourceRead(this.collaborationDeliveryJournal, owned)
      const delivery = [...journal.records(root.namespace_id, { workspace_id: root.source.workspace_id, session_id: root.source.session_id,
        source_message_id: root.source.source_message_id, source_revision: root.source.source_revision })]
        .find(entry => entry.delivery_id === command.delivery_id)
      if (!delivery) throw Error('collaboration_feedback_delivery_missing')
      const message = createCollaborationFeedbackMessage(execution, delivery, root.source)
      const persistence = this.ctx.get('sessionPersistence')
      if (!persistence) throw Error('collaboration_feedback_persistence_unavailable')
      const observe = async (): Promise<CollaborationFeedbackObservation> => {
        // Read through a fresh storage handle: a live query can include events that have not reached disk.
        const count = session?.seq
        if (count !== undefined) { await persistence.flush(); await current() }
        const handle = await persistence.open(sessionId, 'read', { signal: owned })
        try {
          // Cold reads capture their prefix before flushing; live reads cap at the pre-barrier Session sequence.
          const cold = count === undefined ? await handle.read(0, undefined, { signal: owned }) : undefined
          if (cold) { await persistence.flush(); await current() }
          const { events } = cold ?? await handle.read(0, count, { signal: owned })
          if (count !== undefined && events.length !== count) throw Error('collaboration_feedback_persistence_unconfirmed')
          await current()
          return observeCollaborationFeedback(events, message)
        } finally { await handle.close() }
      }
      const before = await observe()
      if (command.action === 'consumer_read' || command.action === 'consumer_prepare' || command.action === 'consumer_start') {
        const consumers = await this.openConsumptionJournal()
        const binding = { namespace_id: root.namespace_id, root_task_id: root.root_task_id, root_trace_id: root.root_trace_id,
          execution_command_id: execution.execution_command_id, invocation_id: delivery.invocation_id, delivery_id: delivery.delivery_id,
          result_digest: delivery.result_digest, message_id: message.id, source_snapshot_digest: delivery.source_snapshot_digest,
          source_locator: delivery.source_locator }
        let record = consumers.read(binding)
        if (command.action === 'consumer_read') {
          if (record && record.state !== 'prepared' && before.status === 'context_applied') record = await consumers.consume(binding, before, owned)
          return { kind: 'consumer' as const, record: record ?? null, observation: before }
        }
        if (root.continuation_policy !== 'follow_authorized_plan') throw Error('collaboration_feedback_display_only')
        if (command.action === 'consumer_prepare' && record) {
          record = await consumers.prepare(binding,
            { event_count: command.expected_event_count, log_digest: command.expected_log_digest }, owned)
          return { kind: 'consumer' as const, record, observation: before }
        }
        if (command.action === 'consumer_start' && record?.state !== 'prepared' && record) {
          const retained = await consumers.start(binding, command.grant, owned)
          return { kind: 'consumer' as const, record: retained.record, observation: before }
        }
        const agent = this.ctx.agents.get(sessionId)
        if (!session || !agent || agent.session !== session || agent.status !== 'idle'
          || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || before.status !== 'not_enqueued') throw Error('collaboration_feedback_session_busy')
        const expected = command.action === 'consumer_prepare' ? command : record?.command
        if (!expected || session.seq !== before.event_count || expected.expected_event_count !== before.event_count
          || expected.expected_log_digest !== before.log_digest) throw Error('collaboration_feedback_session_changed')
        if (command.action === 'consumer_prepare') {
          record = await consumers.prepare(binding, { event_count: before.event_count, log_digest: before.log_digest }, owned)
          await current()
          return { kind: 'consumer' as const, record, observation: before }
        }
        const started = await consumers.start(binding, command.grant, owned)
        await current()
        if (started.wake) {
          if (started.record.state === 'prepared' || session.seq !== before.event_count || agent.status !== 'idle'
            || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw Error('collaboration_consumption_reconciliation_required')
          const deadline = Date.parse(started.record.grant.expires_at)
          if (Date.now() >= deadline) throw Error('collaboration_consumption_grant_expired')
          const active = AbortSignal.any([owned, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
          const cancelled = () => agent.cancel({ kind: 'parent' }, { keepInbox: true })
          this.collaborationConsumerLive.set(message.id, { sessionId, expiresAt: deadline, signal: active })
          active.addEventListener('abort', cancelled, { once: true })
          try {
            active.throwIfAborted()
            agent.send(message, 'next-step', true)
            await agent.whenIdle()
          } finally {
            active.removeEventListener('abort', cancelled)
            this.collaborationConsumerLive.delete(message.id)
          }
          await current()
          return { kind: 'consumer' as const, record: consumers.read(binding) ?? started.record, observation: await observe() }
        }
        return { kind: 'consumer' as const, record: started.record, observation: before }
      }
      if (command.action === 'read' || before.status !== 'not_enqueued') return before
      if (root.continuation_policy !== 'follow_authorized_plan') throw Error('collaboration_feedback_display_only')
      const agent = this.ctx.agents.get(sessionId)
      if (!session || !agent || agent.session !== session) throw Error('collaboration_feedback_session_not_attached')
      if (agent.status !== 'idle' || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)) throw Error('collaboration_feedback_session_busy')
      if (session.seq !== before.event_count || before.event_count !== command.expected_event_count
        || before.log_digest !== command.expected_log_digest) throw Error('collaboration_feedback_session_changed')
      owned.throwIfAborted()
      // No await separates the exact-prefix check from the single synchronous inbox insertion.
      agent.inject(message)
      const after = await observe()
      if (after.status === 'not_enqueued') throw Error('collaboration_feedback_persistence_unconfirmed')
      return after
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return operation
  }

  private collaborationMembershipCheck(sessionId: SessionId, workspaceId: WorkspaceId, signal: AbortSignal,
    session: ReturnType<Context['sessions']['get']>, workspace: ReturnType<Context['workspaceRegistry']['get']>) {
    return async () => {
      await waitForCollaborationSourceRead(this.inspectCollaborationMembership(sessionId, workspaceId, signal), signal)
      if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session)
        throw Error('collaboration_session_workspace_mismatch')
      signal.throwIfAborted()
    }
  }

  private accessCollaborationRoot(value: unknown, signal: AbortSignal, receipt?: CollaborationRootAdmission)
    : Promise<CollaborationRootSubmission> {
    const command = value && typeof value === 'object' && Object.hasOwn(value,'command_id')
      ? parseCollaborationRootTarget(value) : undefined
    const target = command ?? parseCollaborationRootLookup(value)
    const owned = AbortSignal.any([signal, this.collaborationLifetime.signal])
    const operation = this.collaborationCaptureTail.then(async () => {
      owned.throwIfAborted()
      const sessionId = SessionId(target.session_id), workspaceId = WorkspaceId(target.workspace_id)
      const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
      const current = this.collaborationMembershipCheck(sessionId, workspaceId, owned, session, workspace)
      await current()
      if (this.collaborationRootJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (!facility) throw Error('collaboration_root_journal_unavailable')
        this.collaborationRootJournal = openCollaborationRootJournal(facility)
      }
      const journal = await waitForCollaborationSourceRead(this.collaborationRootJournal, owned)
      const entry = command ? journal.read(command.command_id) : journal.find(target)
      if (!entry || entry.namespace_id !== target.namespace_id || entry.source.workspace_id !== target.workspace_id
        || entry.source.session_id !== target.session_id || entry.source.source_message_id !== target.source_message_id
        || entry.source.source_revision !== target.source_revision) throw Error('collaboration_root_not_found')
      const result = receipt === undefined ? entry : await journal.accept(entry.command_id, receipt, owned)
      await current()
      return result
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return operation
  }

  /**
   * Read one durable Source from the owning Profile without model preparation or Agent activation.
   * @param target - Exact original Source identity; caller metadata is rejected.
   * @param signal - Caller cancellation combined with Profile disposal.
   * @returns Frozen identity and digest of the full original snapshot; missing records or changed membership reject.
   */
  async inspectCollaborationSource(target: CollaborationSourceCoordinates, signal: AbortSignal): Promise<
    CollaborationSourceCoordinates & { readonly snapshot_digest: string }
  > {
    return describeCollaborationSource(await this.readCollaborationSourceSnapshot(target, signal))
  }

  /**
   * Read the original committed content for the authenticated parent Host without model preparation.
   * @param target - Exact Source identity; content, model and commit overrides are rejected.
   * @param signal - Caller cancellation combined with Profile disposal.
   * @returns Original frozen journal snapshot after current Session and Workspace ownership checks; no executable handle.
   */
  async readCollaborationSourceSnapshot(target: CollaborationSourceCoordinates, signal: AbortSignal): Promise<CollaborationSourceSnapshot> {
    const captured = parseCollaborationSourceCoordinates(target)
    const ownedSignal = AbortSignal.any([signal, this.collaborationLifetime.signal])
    ownedSignal.throwIfAborted()
    const wait = <T>(read: Promise<T>) => waitForCollaborationSourceRead(read, ownedSignal)
    const operation = this.collaborationCaptureTail.then(async () => {
      ownedSignal.throwIfAborted()
      const workspaceId = WorkspaceId(captured.workspace_id), sessionId = SessionId(captured.session_id)
      const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
      await wait(this.inspectCollaborationMembership(sessionId, workspaceId, ownedSignal))
      if (this.collaborationJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw new Error('collaboration_source_journal_unavailable')
        this.collaborationJournal = openCollaborationSourceJournal(facility)
      }
      const journal = await wait(this.collaborationJournal)
      ownedSignal.throwIfAborted()
      const snapshot = journal.read(captured)
      if (snapshot === undefined) throw new Error('collaboration_source_not_found')
      await wait(this.inspectCollaborationMembership(sessionId, workspaceId, ownedSignal))
      if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
        throw new Error('collaboration_session_workspace_mismatch')
      }
      ownedSignal.throwIfAborted()
      return snapshot
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return wait(operation)
  }

  /**
   * Save a readable cloud reply in the owning Profile without appending model-visible Session events.
   * The authenticated parent must establish namespace/target cloud authority. This operation checks
   * current local ownership and the original Source; it grants no cloud delivery acknowledgment.
   * @param value - Exact private delivery input; caller-supplied local commits are rejected.
   * @param signal - Parent cancellation, combined with Profile disposal.
   * @returns Original immutable reply after durable save and ownership revalidation; duplicates share its commit.
   */
  async receiveCollaborationDelivery(value: unknown, signal: AbortSignal): Promise<CollaborationDeliveryRecord> {
    const input = parseCollaborationDeliveryInput(value)
    const ownedSignal = AbortSignal.any([signal, this.collaborationLifetime.signal])
    ownedSignal.throwIfAborted()
    const coordinates = input.projection.source_locator
    const workspaceId = WorkspaceId(coordinates.workspace_id), sessionId = SessionId(coordinates.session_id)
    const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
    const source = await this.readCollaborationSourceSnapshot(coordinates, ownedSignal)
    const wait = <T>(operation: Promise<T>) => waitForCollaborationSourceRead(operation, ownedSignal)
    const current = async () => {
      await wait(this.inspectCollaborationMembership(sessionId, workspaceId, ownedSignal))
      if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
        throw Error('collaboration_session_workspace_mismatch')
      }
      ownedSignal.throwIfAborted()
    }
    const operation = this.collaborationCaptureTail.then(async () => {
      await current()
      if (this.collaborationDeliveryJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw Error('collaboration_delivery_journal_unavailable')
        this.collaborationDeliveryJournal = openCollaborationDeliveryJournal(facility)
      }
      const journal = await wait(this.collaborationDeliveryJournal)
      await current()
      const result = await journal.persist(input, source, ownedSignal)
      await current()
      return result
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return wait(operation)
  }

  /**
   * Read original collaboration messages for the Client's Session result area without preparing a model.
   * @param request - Session identity and a prior page's immutable snapshot digest; authority fields reject.
   * @param signal - Caller cancellation, combined with Profile disposal and serialized Source writes.
   * @returns At most eight complete messages within 256 KiB; no executable calls or cloud authorization.
   * @throws On malformed input, unknown cursor, corrupt storage, cancellation or changed original membership.
   */
  @Remote('collaborationSources')
  async collaborationSources(request: SessionCollaborationSourcesRequest, signal: AbortSignal): Promise<SessionCollaborationSourcesValue> {
    if (!validCollaborationSourcesRequest(request)) throw Error('collaboration_source_query_invalid')
    const sessionId = SessionId(request.sessionId), cursor = request.cursor
    const ownedSignal = AbortSignal.any([signal, this.collaborationLifetime.signal])
    ownedSignal.throwIfAborted()
    const wait = <T>(read: Promise<T>) => waitForCollaborationSourceRead(read, ownedSignal)
    const operation = this.collaborationCaptureTail.then(async () => {
      ownedSignal.throwIfAborted()
      if (this.collaborationJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw Error('collaboration_source_journal_unavailable')
        this.collaborationJournal = openCollaborationSourceJournal(facility)
      }
      const journal = await wait(this.collaborationJournal)
      ownedSignal.throwIfAborted()
      const entries = [...journal.sources()].filter(source => source.session_id === sessionId)
        .map(snapshot => ({ snapshot, descriptor: describeCollaborationSource(snapshot) }))
        .reverse()
      if (cursor !== undefined && !entries.some(entry => entry.descriptor.snapshot_digest === cursor)) throw Error('collaboration_source_cursor_invalid')
      // Immutable cursor lookup keeps older pages stable when a new Source is appended.
      const remaining = cursor === undefined ? entries
        : entries.slice(entries.findIndex(entry => entry.descriptor.snapshot_digest === cursor) + 1)
      const items: SessionCollaborationSourceItem[] = []
      const checks: (() => Promise<void>)[] = []
      let bytes = 256
      for (const { snapshot, descriptor } of remaining) {
        const { snapshot_digest, ...source } = descriptor
        const item = Object.freeze({ source: Object.freeze(source), snapshot_digest, original_message: snapshot.original_message })
        const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1
        if (items.length === 8 || bytes + size > 256 * 1024) break
        const workspaceId = WorkspaceId(snapshot.workspace_id)
        const workspace = this.ctx.workspaceRegistry.get(workspaceId), attached = this.ctx.sessions.get(sessionId)
        const current = async () => {
          await wait(this.inspectCollaborationMembership(sessionId, workspaceId, ownedSignal))
          if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== attached) throw Error('collaboration_session_workspace_mismatch')
          ownedSignal.throwIfAborted()
        }
        await current(); checks.push(current)
        items.push(item); bytes += size
      }
      for (const current of checks) await current()
      ownedSignal.throwIfAborted()
      const last = items.at(-1)
      return Object.freeze({ items: Object.freeze(items), ...(last && remaining.length > items.length
        ? { next_cursor: last.snapshot_digest } : {}) })
    })
    this.collaborationCaptureTail = operation.then(() => {}, () => {})
    return wait(operation)
  }

  /**
   * Read all visible Session rows without resuming an Agent.
   * @param _request - reserved empty list request.
   * @param signal - cancellation for persistence reads.
   * @returns visible Session summaries ordered by activity.
   */
  @Remote('list')
  async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
    return { items: await this.listState.list(signal) }
  }

  /**
   * Search visible Session content without resuming an Agent.
   * @param request - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  @Remote('search')
  search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
    return this.listState.search(request.query, signal)
  }

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  @Remote('create')
  create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Select one Session-local model after explicitly resuming the Session.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  @Remote('selectModel')
  selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    return this.commands.selectModel(request)
  }

  /** Initialize the upstream Desktop account model when that product is composed. */
  @Remote
  async initializeDefaultModel(): Promise<void> {
    const provider = 'deepseek-account'
    if (await hasProviderApiKey(this.ctx)) return
    const catalog = await buildModelCatalog(this.ctx)
    const model = catalog.groups.find(group => group.id === provider)?.models[0]
    if (model === undefined) throw new RemoteError('session/provider-models-unavailable',
      `provider "${provider}" has no available models`, { provider })
    const selection = { provider, model: model.id,
      ...model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning.defaultEffort) },
    }
    await this.ctx.agentDefaultModel.saveSelection(selection)
  }

  /**
   * Describe every currently routable model for Host-generation selectors.
   * @returns provider-grouped models, the deployment default, and isolated provider failures.
   */
  @Remote('modelCatalog')
  modelCatalog(): Promise<ModelCatalog> {
    return buildModelCatalog(this.ctx)
  }

  /**
   * Report whether this deployment can hand a Session workspace path to a native desktop.
   * @returns true when the matching open operation is available.
   */
  @Remote
  canOpenWorkspacePath(): boolean {
    return this.canOpenPath()
  }

  /**
   * Describe the serving desktop for authenticated file-action routes.
   * @returns Host name, configured availability, and platform-specific file-manager behavior.
   */
  workspaceDesktop(): { name: string; available: boolean; fileManager: 'finder' | 'explorer' | 'directory' | null } {
    const fileManager = nativeFileManager()
    return { name: hostname(), available: fileManager !== null && this.canOpenPath(), fileManager }
  }

  /**
   * Open a verified Host path through its selected native application.
   * @param request - requested path and native action.
   * @param signal - cancellation for verification and opening.
   * @returns whether the native open operation succeeded.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      if (request.action === 'reveal') await this.revealPath(path, signal)
      else if (request.application !== undefined) await this.openFileApplication(path, request.application, signal)
      else await this.openPath(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'path open failed', {}, { cause: error })
    }
  }

  /**
   * Query applications for a verified Host path.
   * @param request - path to inspect.
   * @param signal - cancellation for path verification and application lookup.
   * @returns applications available to open the path.
   */
  @Remote('workspacePathApplications')
  async workspacePathApplications(
    request: { readonly path: string }, signal: AbortSignal,
  ): Promise<readonly SessionWorkspacePathApplication[]> {
    if (!this.canOpenPath()) return []
    try {
      const path = await this.verifyDesktopPath(request.path, signal)
      return await this.fileApplications(path, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'application query was aborted', {})
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'file application query failed', {}, { cause: error })
    }
  }

  private async verifyDesktopPath(path: string, signal: AbortSignal): Promise<string> {
    if (path.length === 0) throw new RemoteError('gateway/bad-request', 'A non-empty file path is required', {})
    signal.throwIfAborted()
    const hostPath = resolve(path)
    const { fs } = this.ctx
    const mapped = fs.processPathFromHostPath(hostPath)
    if (mapped === undefined || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) {
      throw new RemoteError('gateway/bad-request', 'Path has no verified Host path', {})
    }
    signal.throwIfAborted()
    return hostPath
  }

  /**
   * Rename one Session after explicitly resuming it.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  @Remote('rename')
  rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    return this.commands.rename(request)
  }

  /**
   * Delete one Session from user-visible listings without deleting its immutable log.
   * Active and queued Agent work is cancelled and drained before acknowledgement.
   * @param request - Session identity to hide durably.
   * @returns deletion confirmation after live work reaches idle.
   */
  @Remote('delete')
  delete(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Fork one cold-readable completed-turn prefix into a new Session.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  @Remote('fork')
  fork(request: SessionForkRequest): Promise<SessionForkValue> {
    return this.commands.fork(request)
  }

  /**
   * Admit one prompt after explicitly resuming its Session.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @param signal - caller cancellation before prompt admission begins.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  @Remote('prompt')
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue> {
    signal.throwIfAborted()
    return this.commands.prompt(request)
  }

  /**
   * Read one image proven reachable from the addressed Session log.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  @Remote('attachment')
  attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    return this.commands.attachment(request)
  }

  /**
   * Mutate one still-pending queue occurrence, resuming a cold Agent first.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  @Remote('updateQueue')
  updateQueue(request: SessionUpdateQueueRequest): Promise<SessionUpdateQueueValue> {
    return this.commands.updateQueue(request)
  }

  /**
   * Cancel one active Agent turn without dropping its pending inbox.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  @Remote('cancel')
  cancel(request: SessionCancelRequest): SessionCancelValue {
    return this.commands.cancel(request)
  }

  /**
   * Read one cold-safe, message-aligned Session history page.
   * @param request - durable address, backward cursor, and page budget.
   * @param signal - cancellation for persistence reads.
   * @returns one chronological page.
   */
  @Remote('page')
  page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    return this.history.page(request, signal)
  }

  /**
   * Follow one Session log from its opening or resume cursor.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns a complete opening snapshot followed by gap-free durable event
   *   frames and optional cursorless assistant-stream frames.
   */
  @Remote({ mode: 'stream' })
  follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    return this.history.follow(request, signal)
  }

  /**
   * Read the current projection baseline without starting an Agent.
   * @param request - Session whose projections are requested.
   * @param signal - cancellation for the observation.
   * @returns projection values and their sequence cursor.
   */
  @Remote('projections')
  async projections(request: SessionProjectionsRequest, signal: AbortSignal): Promise<SessionProjectionsValue> {
    const { sessionId } = request
    if (sessionId.length === 0) throw new RemoteError('gateway/bad-request', 'sessionId must not be empty', {})
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal })
      const projections = observation.projections
      if (projections === undefined) {
        throw new RemoteError('session/projections-unavailable', 'Session projections are unavailable', {})
      }
      return { asOfSeq: projections.asOfSeq, values: projections.values as SessionProjectionValues }
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      if (signal.aborted || (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED')) {
        throw new RemoteError('gateway/cancelled', 'Session projection read was cancelled', {}, { cause: error })
      }
      if (error instanceof RemoteError) throw error
      throw new RemoteError('gateway/internal', 'Session projection read failed', {}, { cause: error })
    }
  }

  /**
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }

}

function validCollaborationSourcesRequest(value: unknown): value is SessionCollaborationSourcesRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).every(key => key === 'sessionId' || key === 'cursor')
    && typeof row.sessionId === 'string' && /^[!-~]{1,256}$/u.test(row.sessionId)
    && !/[/\\]/u.test(row.sessionId) && row.sessionId !== '.' && row.sessionId !== '..'
    && (row.cursor === undefined || (typeof row.cursor === 'string' && /^[0-9a-f]{64}$/u.test(row.cursor)))
}

export { buildModelCatalog }
export default SessionController
