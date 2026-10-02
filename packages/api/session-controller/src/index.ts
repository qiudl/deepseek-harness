/** Session Remote owner: cold reads, explicit Agent commands, and live control state. */

import { hostname } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { PreparedLlmSnapshotCall } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { canOpenNativePath, nativeFileManager, openNativePath, revealNativePath } from '@deepseek-ai/dsh-native-command'
import { foldRequestHeader, SessionId } from '@deepseek-ai/dsh-session'
import { realpathNormalize, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { openCollaborationSourceJournal, parseCollaborationSourceInput, parseCollaborationSourceCoordinates, describeCollaborationSource } from './collaboration-source-journal.ts'
import type { CollaborationSourceJournal, CollaborationSourceInput, CollaborationSourceSnapshot, CollaborationSourceCoordinates } from './collaboration-source-journal.ts'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
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
import { buildModelCatalog } from './catalog.ts'
import { foldModelSelection, installModelSelectionProjection, resolveModelSelection } from './model-selection-projection.ts'
import { SessionSkillCatalog } from './skill-catalog.ts'
import { installAttachmentExport } from './attachment-export.ts'
import { SessionMediaReferences } from './media-references.ts'
import type {
  ModelCatalog,
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
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
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
export { openCollaborationSourceJournal } from './collaboration-source-journal.ts'
export type {
  CollaborationSourceBody, CollaborationSourceSnapshot, CollaborationSourceJournal, CollaborationSourceInput,
  CollaborationSourceCoordinates,
} from './collaboration-source-journal.ts'

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
  private readonly revealPath: (path: string, signal: AbortSignal) => Promise<void>
  private readonly canOpenPath: () => boolean
  private readonly promotions = new Set<Promise<void>>()
  private readonly collaborationLifetime = new AbortController()
  private collaborationCaptureTail: Promise<void> = Promise.resolve()
  private collaborationJournal?: Promise<CollaborationSourceJournal>

  /**
   * @param ctx - Host context containing the Session capability assembly.
   * @param config - native-opener deployment policy.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: Config, internals: SessionControllerInternals = {}) {
    super(ctx, 'sessionController', { namespace: 'session' })
    // Host identity reads use the owning Profile's registry, never a caller's Cordis scope.
    this.inspectWorkspaceModelSelection = this.inspectWorkspaceModelSelection.bind(this)
    this.prepareWorkspaceModelSnapshot = this.prepareWorkspaceModelSnapshot.bind(this)
    this.captureCollaborationSource = this.captureCollaborationSource.bind(this)
    this.inspectCollaborationSource = this.inspectCollaborationSource.bind(this)
    ctx.effect(() => async () => {
      this.collaborationLifetime.abort(new DOMException('Profile source capture disposed', 'AbortError'))
      await this.collaborationCaptureTail
      const journal = await this.collaborationJournal?.catch(() => undefined)
      await journal?.close()
    }, 'session-controller.collaboration-sources')
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
    this.openPath = internals.openPath ?? openNativePath
    this.revealPath = internals.revealPath ?? revealNativePath
    this.canOpenPath = internals.canOpenPath
      ?? (() => config.nativeOpen ?? (internals.openPath !== undefined || canOpenNativePath()))
    if (ctx.get('connection') !== undefined) installAttachmentExport(ctx)
    ctx.plugin(SessionFileReferences)
    ctx.plugin(SessionMediaReferences)
    ctx.plugin(SessionSkillCatalog)

    ctx.on('session/created', (session) => {
      ctx.emit('api-session/added', this.listState.summaryFor(session))
    })
    ctx.on('session/disposed', (session) => {
      ctx.emit('api-session/removed', session.id)
    })
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

  /**
   * Prepare the source Session's next model under this Profile's registry. Recheck
   * workspace/session ownership and selection after credential preparation. The
   * returned call is process-local and one-shot; this does not issue Source authority,
   * resume an Agent, append events, or send a model request. No Remote method is exposed.
   * @param sessionId - ordinary Session registered under this workspace.
   * @param workspaceId - WorkspaceRegistry UUID.
   * @param signal - owning Host operation's cancellation, retained through dispatch.
   * @returns workspace/session identities and the captured executable model call.
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
   * only its original snapshot, never a new executable handle or a model request.
   * This Host-only queued operation has no Remote endpoint and grants no cloud authority.
   * @param input - exact Source coordinates, raw text and trusted classified mentions; no model or commit fields.
   * @param signal - caller cancellation, combined with the owning Profile lifetime through dispatch.
   * @returns first durable capture with its one-shot call, or original non-executable recovery.
   * @throws on invalid input, unavailable journal, changed ownership/selection, conflict or cancellation.
   */
  async captureCollaborationSource(input: CollaborationSourceInput, signal: AbortSignal): Promise<
    | Readonly<{ kind: 'captured'; snapshot: CollaborationSourceSnapshot; prepared: PreparedLlmSnapshotCall }>
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
      return Object.freeze({ kind: 'captured' as const, snapshot, prepared: prepared.prepared })
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
    const captured = parseCollaborationSourceCoordinates(target)
    const ownedSignal = AbortSignal.any([signal, this.collaborationLifetime.signal])
    ownedSignal.throwIfAborted()
    const wait = <T>(read: Promise<T>) => waitForCollaborationSourceRead(read, ownedSignal)
    const operation = this.collaborationCaptureTail.then(async () => {
      ownedSignal.throwIfAborted()
      const workspaceId = WorkspaceId(captured.workspace_id), sessionId = SessionId(captured.session_id)
      const workspace = this.ctx.workspaceRegistry.get(workspaceId), session = this.ctx.sessions.get(sessionId)
      await wait(this.inspectWorkspaceModelSelection(sessionId, workspaceId, ownedSignal))
      if (this.collaborationJournal === undefined) {
        const facility = this.ctx.get('storageDomain')
        if (facility === undefined) throw new Error('collaboration_source_journal_unavailable')
        this.collaborationJournal = openCollaborationSourceJournal(facility)
      }
      const journal = await wait(this.collaborationJournal)
      ownedSignal.throwIfAborted()
      const snapshot = journal.read(captured)
      if (snapshot === undefined) throw new Error('collaboration_source_not_found')
      await wait(this.inspectWorkspaceModelSelection(sessionId, workspaceId, ownedSignal))
      if (this.ctx.workspaceRegistry.get(workspaceId) !== workspace || this.ctx.sessions.get(sessionId) !== session) {
        throw new Error('collaboration_session_workspace_mismatch')
      }
      ownedSignal.throwIfAborted()
      return describeCollaborationSource(snapshot)
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
   * Open one path prepared by a Session-aware caller on the Host desktop.
   * @param request - path after best-effort Session workspace resolution.
   * @param signal - caller lifetime; abort terminates the native command.
   * @returns confirmation after the native opener accepts the path.
   * @throws RemoteError when the request is invalid, cancelled, or the opener fails.
   */
  @Remote('openWorkspacePath')
  async openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal: AbortSignal,
  ): Promise<SessionOpenWorkspacePathValue> {
    if (request.path.length === 0) {
      throw new RemoteError(
        'gateway/bad-request',
        'session.openWorkspacePath requires a non-empty path',
        {},
      )
    }
    signal.throwIfAborted()
    try {
      if (request.action === 'reveal') await this.revealPath(request.path, signal)
      else await this.openPath(request.path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (signal.aborted) throw new RemoteError('gateway/cancelled', 'path open was aborted', {})
      throw new RemoteError(
        'gateway/internal',
        `path open failed: ${error instanceof Error ? error.message : String(error)}`,
        {},
      )
    }
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
   * Stream a complete live-control baseline followed by replacement frames.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns one complete baseline followed by live replacement frames.
   */
  @Remote({ mode: 'stream' })
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    return this.controlState.control(signal)
  }

}

export { buildModelCatalog }
export default SessionController
