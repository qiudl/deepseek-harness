import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { CollaborationTrajectory } from './CollaborationTrajectory.tsx'
/** DSH `@` source for the live, employee-assigned Slark Agent directory. */
import type { ChatTimelineRecord } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationBinding } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconQueueOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { en, NS, zh } from './locales.ts'
import { AgentTaskDock } from './AgentTaskDock.tsx'
import { ProjectScopeModel } from './project-scope.ts'
import type { WorkspaceBridge } from './project-scope.ts'
import { ProjectScopeDock, ProjectScopePanel, CollaborationTabTitle } from './ProjectScopeDock.tsx'
import type { ProjectScopeInjected, ScopeLauncherInjected } from './ProjectScopeDock.tsx'
import { createScopedCollaborationSource, scopedCollaborationClipboard } from './collaboration-source.ts'
import type { DesktopCollaborationSourceInput, CollaborationSubmissionResponse } from './collaboration-source.ts'
import type { CollaborationDialogueBridge } from './collaboration-dialogue.ts'
import { CollaborationResultsModel } from './collaboration-results.ts'
import { shareCollaborationReads } from './collaboration-read-bridge.ts'
import type { CollaborationResultsBridge } from './collaboration-results.ts'
import { CollaborationResultsDock } from './CollaborationResultsDock.tsx'
import { CollaborationTimeline } from './CollaborationTimeline.tsx'
import type { CollaborationResultsInjected } from './CollaborationResultsDock.tsx'

/** Required client services. */
export const inject = ['inputTriggers', 'locale', 'sessions', 'conversation', 'slots']

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Temporary original-Session ownership while a readonly history locator prepares navigation. */
    collaborationLocator: unknown
  }
}

interface AgentItem {
  assignment_id: string
  project_id: string
  agent_id: string
  enterprise_id: string
  enterprise_name: string
  project_name: string
  name: string
  publication_version: number
}

interface DesktopAgentDirectory extends WorkspaceBridge, CollaborationResultsBridge, CollaborationDialogueBridge {
  collaborationScopeAvailable?: boolean
  collaborationExecutionAvailable?: boolean
  collaborationPlanningAvailable?: boolean
  collaborationRecover?(input: DesktopCollaborationSourceInput): Promise<CollaborationSubmissionResponse>
  collaborationSubmit?(input: DesktopCollaborationSourceInput): Promise<CollaborationSubmissionResponse>
  enterpriseAgents(): Promise<
    { ok: true; items: AgentItem[]; invocationAvailable: boolean } |
    { ok: false; errorCode: string }>
  invokeEnterpriseAgent?(input: {
    session_id: string
    logical_key: string
    assignment_id: string
    project_id: string
    agent_id: string
    publication_version: number
    question: string
  }): Promise<{ ok: true; value: { invocation_id: string; state: string } } |
    { ok: false; errorCode: string }>
  enterpriseAgentInvocations?(input: { session_id: string }): Promise<
    { ok: true; value: { items: DesktopAgentInvocation[]; total: number } } |
    { ok: false; errorCode: string }>
}

/** Account-bound task summary returned by the trusted Desktop Host bridge. */
export interface DesktopAgentInvocation {
  invocation_id: string
  project_id: string
  session_id: string
  agent_name: string
  project_name: string
  enterprise_name: string
  state: string
  question: string | null
  answer: string | null
  failure_code: string | null
  created_at: string
  terminal_at: string | null
}

declare global {
  interface Window {
    __DSH_DESKTOP_HOST__?: DesktopAgentDirectory
  }
}

type AgentReference = Pick<AgentItem, 'assignment_id' | 'project_id' | 'agent_id' | 'enterprise_id' | 'name' | 'publication_version'> & {
  project_name?: unknown
  enterprise_name?: unknown
  logical_key?: string
  logical_key_version?: 2
}

type ResultsEntry = {
  owner: ConversationBinding
  model: CollaborationResultsModel
  bindings: CollaborationResultsInjected
  timelineModel: CollaborationResultsModel
  timelineBindings: CollaborationResultsInjected
  release: () => void
}

function isAgentReference(item: Record<string, unknown>): item is Record<string, unknown> & AgentReference {
  return ['assignment_id', 'project_id', 'agent_id', 'enterprise_id', 'name'].every(
    key => typeof item[key] === 'string' && item[key].length > 0,
  ) && Number.isSafeInteger(item.publication_version) &&
    (item.logical_key === undefined || typeof item.logical_key === 'string') &&
    (item.logical_key_version === undefined || item.logical_key_version === 2)
}

function parseReference(value: string): AgentReference | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const item = parsed as Record<string, unknown>
    return isAgentReference(item) ? item : null
  } catch { return null }
}

/** Preserve legacy references whose project display name was not recorded. */
function agentLabel(item: Pick<AgentItem, 'name'> & { project_name?: unknown }): string {
  return typeof item.project_name === 'string' && item.project_name.length > 0
    ? `${item.name} · ${item.project_name}` : item.name
}

/** Register a stable-reference source; ordinary model serialization refuses the Agent chip. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-slark-agent: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => {
    if (typeof window !== 'undefined' && window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) return () => {}
    return ctx.slots.register({ name: 'conversation.input.dock', id: 'slark-agent-tasks', order: 25, locale: NS,
      inject: sessionId => ({ sessionId }),
    }, AgentTaskDock)
  })
  ctx.inject(['remote', 'remote.session', 'connection', 'workspaces', 'uiConversation', 'chatTimeline'], (resultsCtx) => {
    if (typeof window === 'undefined' || !window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable ||
      !(window.__DSH_DESKTOP_HOST__.collaborationExecutionAvailable || window.__DSH_DESKTOP_HOST__.collaborationPlanningAvailable)) return
    const connection = resultsCtx.get('connection') as ConnectionHandle
    const readBridge = shareCollaborationReads(() => window.__DSH_DESKTOP_HOST__, connection.generation)
    const models = new Map<string, ResultsEntry>()
    resultsCtx.effect(() => () => {
      models.forEach(({ release }) => { release() })
      models.clear()
    },
    'ui-slark-agent: workspace results')
    const entryFor = (sessionId: SessionId): ResultsEntry => {
      if (resultsCtx.fiber.uid === null) throw Error('collaboration_view_closed')
      const source = resultsCtx.sessions.binding(sessionId)
      if (!source || source.ctx.fiber.uid === null) throw Error('collaboration_view_closed')
      const owner = resultsCtx.uiConversation.binding(source)
      let entry = models.get(sessionId)
      if (entry && entry.owner !== owner) {
        entry.release()
        entry = undefined
      }
      if (!entry) {
        const createModel = (history: 'session' | 'workspace') => new CollaborationResultsModel(
          sessionId, resultsCtx.workspaces.list, connection.generation,
          (cursor, signal, sourceSessionId) => resultsCtx.remote.session.collaborationSources({
            sessionId: sourceSessionId, includeTimeline: true, ...(cursor ? { cursor } : {}),
          }, signal), readBridge, history,
          (original, signal) => resultsCtx.remote.session.collaborationSources({
            sessionId: SessionId(original.source.session_id), snapshotDigest: original.snapshot_digest, includeTimeline: true,
          }, signal), true)
        const model = createModel('workspace'), timelineModel = createModel('session')
        const stopActivity = owner.registerActivity('slark-collaboration', {
          getSnapshot: () => {
            const snapshot = timelineModel.getSnapshot()
            return snapshot.groups.length > 0 || snapshot.phase === 'error'
          },
          subscribe: listener => timelineModel.subscribe(listener),
        })
        const stopTraceActivity = owner.registerActivity('trajectory', {
          getSnapshot: () => timelineModel.getSnapshot().groups.length > 0,
          subscribe: listener => timelineModel.subscribe(listener),
        })
        let previous: ReturnType<typeof timelineModel.getSnapshot> | undefined
        let records: readonly ChatTimelineRecord[] = []
        const stopTimeline = resultsCtx.chatTimeline.register(sessionId, {
          getSnapshot: () => {
            const snapshot = timelineModel.getSnapshot()
            if (snapshot !== previous) {
              previous = snapshot
              const next = snapshot.groups.flatMap((group) => {
                const position = group.original.timeline_position
                return position ? [{
                  recordId: group.original.snapshot_digest, afterSequence: position.after_sequence,
                  localOrder: position.local_order,
                }] : []
              })
              if (JSON.stringify(next) !== JSON.stringify(records)) records = next
            }
            return records
          },
          subscribe: listener => timelineModel.subscribe(listener),
        })
        const releaseEffect = source.ctx.effect(() => () => {
          models.delete(sessionId)
          stopTimeline(); stopActivity(); stopTraceActivity(); timelineModel.dispose(); model.dispose()
        }, 'ui-slark-agent: Session result projections')
        entry = { owner, model, timelineModel, release: () => { void releaseEffect() },
          timelineBindings: { hooks: { slarkResults: timelineModel }, loadSources: () => timelineModel.loadSources(),
            traceEvidenceAction: (digest, eventId, more) => timelineModel.traceEvidenceAction(digest, eventId, more),
            traceAction: (digest, more) => timelineModel.traceAction(digest, more),
            loadReplies: digest => timelineModel.loadReplies(digest),
            executionAction: (digest, taskId, reconcile) => timelineModel.executionAction(digest, taskId, reconcile) },
          bindings: { hooks: { slarkResults: model }, loadSources: () => model.loadSources(),
            traceEvidenceAction: (digest, eventId, more) => model.traceEvidenceAction(digest, eventId, more),
            traceAction: (digest, more) => model.traceAction(digest, more),
            locateOriginal: digest => model.locateOriginal(digest, (original) => {
              const navigation = resultsCtx.get('uiWorkspace')
              if (!navigation) throw Error('source_navigation_unavailable')
              const reference = ctx.sessions.retain(SessionId(original.source.session_id), { source: 'collaborationLocator' })
              try {
                const target = entryFor(reference.sessionId)
                if (!target.timelineModel.revealOriginal(original) || !target.model.revealOriginal(original)) {
                  throw Error('source_navigation_unavailable')
                }
                navigation.openSession(reference.sessionId)
                void target.model.refresh()
                void target.timelineModel.refresh()
              } finally {
                reference.release()
              }
            }),
            consumptionAction: (digest, deliveryId, reconcile) => model.consumptionAction(digest, deliveryId, reconcile),
            executionAction: (digest, taskId, reconcile) => model.executionAction(digest, taskId, reconcile),
            loadReplies: digest => model.loadReplies(digest) } }
        models.set(sessionId, entry)
      }
      return entry
    }
    resultsCtx.slots.inject('conversation.input.dock', () => resultsCtx.slots.register({
      name: 'conversation.input.dock', id: 'slark-collaboration-activity',
      inject: (sessionId) => {
        // Blank Conversations mount the composer before Chat; its activity must discover independent history first.
        entryFor(sessionId)
        return {}
      },
    }, () => null))
    resultsCtx.slots.inject('slark.collaboration.history', () => resultsCtx.slots.register({
      name: 'slark.collaboration.history', locale: NS,
      inject: sessionId => entryFor(sessionId).bindings,
    }, CollaborationResultsDock))
    resultsCtx.slots.inject('conversation.trajectory.external', () => resultsCtx.slots.register({
      name: 'conversation.trajectory.external', id: 'slark-collaboration-trace', order: 10, locale: NS,
      inject: sessionId => entryFor(sessionId).timelineBindings,
    }, CollaborationTrajectory))
    resultsCtx.slots.inject('conversation.chat.timeline', () => resultsCtx.slots.register({
      name: 'conversation.chat.timeline', locale: NS,
      inject: sessionId => entryFor(sessionId).timelineBindings,
    }, CollaborationTimeline))
  })
  const t = ctx.locale.bind(NS)
  const scopedSource = createScopedCollaborationSource(ctx, t)
  const scopeModels = new Map<string, {
    owner: NonNullable<ReturnType<ClientContext['sessions']['binding']>>
    model: ProjectScopeModel
    release: () => void
    bindings: ProjectScopeInjected & ScopeLauncherInjected
  }>()
  ctx.inject(['workspaces', 'sidebarRight', 'sidebarRightTabs'], (scopeCtx) => {
    if (typeof window === 'undefined' || !window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) return
    scopeCtx.effect(() => () => { scopeModels.forEach(({ release }) => { release() }); scopeModels.clear() },
      'ui-slark-agent: scope projections')
    const bindingsFor = (sessionId: SessionId): ProjectScopeInjected & ScopeLauncherInjected => {
      if (scopeCtx.fiber.uid === null) throw Error('collaboration_view_closed')
      const owner = scopeCtx.sessions.binding(sessionId)
      if (!owner || owner.ctx.fiber.uid === null) throw Error('collaboration_view_closed')
      let entry = scopeModels.get(sessionId)
      if (entry && entry.owner !== owner) {
        entry.release()
        entry = undefined
      }
      if (!entry) {
        const model = new ProjectScopeModel(sessionId, scopeCtx.workspaces.list, () => window.__DSH_DESKTOP_HOST__)
        const releaseEffect = owner.ctx.effect(() => () => {
          model.dispose()
          scopeModels.delete(sessionId)
        }, 'ui-slark-agent: Session scope projection')
        entry = { owner, model, release: () => { void releaseEffect() },
          bindings: { hooks: { slarkScope: model }, refreshScope: () => model.refresh(),
            applyScope: selected => model.apply(selected), loadProjects: () => model.loadProjects(),
            loadAgents: () => model.loadAgents(),
            openCollaboration: () => {
              if (scopeCtx.fiber.uid !== null && scopeCtx.sessions.binding(sessionId) === owner &&
                owner.ctx.fiber.uid !== null && scopeCtx.sidebarRight.mounted.getSnapshot() === sessionId) {
                scopeCtx.sidebarRight.openTab('slark-collaboration')
              }
            },
            insertAgent: (projectId, agentId, span) => {
              const selected = model.agentForMention(projectId, agentId)
              if (!selected) return false
              const scoped = scopeCtx.sessions.scope(sessionId)
              if (!scoped) return false
              const input = scopeCtx.conversation.input.for(scoped), state = input.state.getSnapshot()
              if (state.phase !== 'plain' || state.draftRev !== span.draftRev) return false
              const item = selected.agent, label = `${item.agent_name} · ${item.project_name}`
              const outcome = scopedSource.onPick({ session: { sessionId }, position: 'inline', via: 'menu', action: 'pick', span,
                candidate: { name: label, label, value: JSON.stringify({ kind: 'collaboration-v2', workspace_id: selected.workspaceId,
                  session_id: sessionId, project_id: item.project_id, project_name: item.project_name, agent_id: item.agent_id,
                  agent_name: item.agent_name, capability_snapshot: item.capability_snapshot }) } })
              if (!outcome || typeof outcome !== 'object' || !('insert' in outcome)) return false
              const inserted = input.insertReference(outcome.insert, span)
              if (inserted) input.focus()
              return inserted
            } } }
        scopeModels.set(sessionId, entry)
      }
      return entry.bindings
    }
    const tabId = '@deepseek-ai/dsh-client-ui-slark-agent/collaboration'
    scopeCtx.effect(() => scopeCtx.sidebarRightTabs.register({
      id: tabId, kind: 'slark-collaboration', priority: 'builtin', title: () => t('scope.title'),
      guide: [{ id: 'slark-collaboration', order: 60, title: () => t('scope.title'),
        description: () => t('scope.description'), icon: IconQueueOutlineRegular }],
    }), 'ui-slark-agent: collaboration sidebar type')
    scopeCtx.slots.inject('sidebar.right.pane.tab', () => scopeCtx.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId, locale: NS,
      children: { 'slark.collaboration.history': { kind: 'single', scope: 'session' } },
      inject: bindingsFor,
    }, ProjectScopePanel))
    scopeCtx.slots.inject('sidebar.right.pane.tab.title', () => scopeCtx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: tabId, locale: NS,
    }, CollaborationTabTitle))
    scopeCtx.slots.inject('conversation.input.dock', () => scopeCtx.slots.register({
      name: 'conversation.input.dock', id: 'slark-project-scope', order: 20, locale: NS,
      inject: bindingsFor,
    }, ProjectScopeDock))
  })
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'slark-agent',
    order: 5,
    showGroupTitle: false,
    matchEnterPosition: 'anywhere',
    subscribeCandidates: (session, listener) => scopedSource.subscribeCandidates?.(session, listener) ?? (() => {}),
    matchEnterPlainText: () => {
      const host = typeof window === 'undefined' ? undefined : window.__DSH_DESKTOP_HOST__
      return Boolean(host?.collaborationScopeAvailable && host.collaborationExecutionAvailable
        && typeof host.collaborationPending === 'function' && typeof host.collaborationClarify === 'function')
    },
    async candidates(_session, { query, signal, ...options }) {
      const host = typeof window === 'undefined' ? undefined : window.__DSH_DESKTOP_HOST__
      if (host?.collaborationScopeAvailable) {
        return scopedSource.candidates(_session, { query, signal, ...options })
      }
      if (!host?.enterpriseAgents) return []
      const response = await host.enterpriseAgents()
      if (!response.ok || !response.invocationAvailable || signal.aborted) return []
      const needle = query.trim().toLocaleLowerCase()
      return response.items.filter(item =>
        `${item.name} ${item.enterprise_name} ${item.project_name}`.toLocaleLowerCase().includes(needle),
      ).map(item => ({
        name: `${item.name} · ${item.enterprise_name}/${item.project_name} · ${item.agent_id}`,
        label: agentLabel(item),
        description: `${item.enterprise_name} / ${item.project_name}`,
        section: t('section.agents'),
        value: JSON.stringify(item),
      }))
    },
    onPick(args) {
      if (typeof window !== 'undefined' && window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) return scopedSource.onPick(args)
      const { candidate } = args
      if (candidate.value === undefined) return undefined
      const item = parseReference(candidate.value)
      if (!item) return undefined
      return { insert: {
        source: 'slark-agent', ref: JSON.stringify({ ...item, logical_key: randomUUID(), logical_key_version: 2 }),
        label: agentLabel(item),
        clipboardText: `@${agentLabel(item)}`,
      } }
    },
    async matchEnter(session, line, signal, envelope) {
      const scoped = ctx.sessions.scope(session.sessionId)
      if (!scoped) return undefined
      const state = ctx.conversation.input.for(scoped).state.getSnapshot()
      const matches = state.occurrences.filter(occ => occ.source === 'slark-agent')
      if (state.draft.trim() !== line) return undefined
      if (window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable
        || matches.some(occ => scopedCollaborationClipboard(occ.ref) !== undefined))
        return scopedSource.matchEnter?.(session, line, signal, envelope)
      if (matches.length === 0) return undefined
      if (matches.length !== 1 || state.occurrences.length !== 1 || envelope.attachments > 0) {
        throw new Error(t('submit.single'))
      }
      const mention = matches[0] as (typeof matches)[number]
      const end = mention.offset + mention.length
      if (!Number.isSafeInteger(mention.offset) || !Number.isSafeInteger(mention.length) ||
        mention.offset < 0 || mention.length < 2 || end > state.draft.length ||
        !mention.clipboardText.startsWith('@') || state.draft.slice(mention.offset, end) !== mention.clipboardText) {
        return undefined
      }
      const item = parseReference(mention.ref)
      const logicalKey = item?.logical_key
      if (!logicalKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(logicalKey)) {
        throw new Error(t('submit.unavailable'))
      }
      const question = (state.draft.slice(0, mention.offset) + state.draft.slice(end)).trim()
      if (!question) throw new Error(t('submit.question'))
      const snapshot = state.draft
      // New references bind retry identity to the question. Legacy references keep their original admission key.
      let invocationKey = logicalKey
      if (item.logical_key_version === 2) {
        const subtle = Reflect.get(globalThis.crypto, 'subtle') as SubtleCrypto | undefined
        if (!subtle) throw new Error(t('submit.unavailable'))
        signal.throwIfAborted()
        const digest = await subtle.digest('SHA-256',
          new TextEncoder().encode(JSON.stringify([2, logicalKey, question])))
        signal.throwIfAborted()
        invocationKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      }
      return { claim: {
        name: 'slark-agent', token: line, retainOnFailure: false,
        async submit(args, actx) {
          const latest = ctx.conversation.input.for(actx).state.getSnapshot()
          if (ctx.sessions.scopeOf(actx) !== session.sessionId ||
            latest.draft !== snapshot || latest.occurrences.length !== 1 ||
            latest.occurrences[0]?.ref !== mention.ref || latest.occurrences[0].offset !== mention.offset ||
            latest.occurrences[0].length !== mention.length ||
            latest.occurrences[0].clipboardText !== mention.clipboardText || args.trim() !== '') {
            return { kind: 'error', text: t('submit.changed') }
          }
          const host = window.__DSH_DESKTOP_HOST__
          if (host?.collaborationScopeAvailable) return { kind: 'error', text: t('scope.executorPending') }
          if (!host?.invokeEnterpriseAgent) return { kind: 'error', text: t('submit.unavailable') }
          const result = await host.invokeEnterpriseAgent({
            session_id: session.sessionId, logical_key: invocationKey,
            assignment_id: item.assignment_id, project_id: item.project_id,
            agent_id: item.agent_id, publication_version: item.publication_version,
            question,
          })
          if (!result.ok) return { kind: 'error', text: t('submit.unavailable') }
          window.dispatchEvent(new CustomEvent('dsh-slark-agent-admitted', { detail: session.sessionId }))
          return { kind: 'success', text: t('submit.accepted') }
        },
      } }
    },
    codec: {
      clipboardText(ref) {
        const scoped = scopedCollaborationClipboard(ref)
        if (scoped) return scoped
        const item = parseReference(ref)
        return item ? `@${agentLabel(item)}` : '@'
      },
      serialize() { return Promise.reject(new Error(t('submit.unavailable'))) },
    },
  }
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => triggers.registerSource(source), 'ui-slark-agent: @ source')
}
