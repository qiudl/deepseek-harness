/** DSH `@` source for the live, employee-assigned Slark Agent directory. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { en, NS, zh } from './locales.ts'
import { AgentTaskDock } from './AgentTaskDock.tsx'
import { ProjectScopeModel } from './project-scope.ts'
import type { WorkspaceBridge } from './project-scope.ts'
import { ProjectScopeDock } from './ProjectScopeDock.tsx'
import type { ProjectScopeInjected } from './ProjectScopeDock.tsx'
import { createScopedCollaborationSource, scopedCollaborationClipboard } from './collaboration-source.ts'
import type { DesktopCollaborationSourceInput, CollaborationSubmissionResponse } from './collaboration-source.ts'
import type { CollaborationDialogueBridge } from './collaboration-dialogue.ts'
import { CollaborationResultsModel } from './collaboration-results.ts'
import type { CollaborationResultsBridge } from './collaboration-results.ts'
import { CollaborationResultsDock } from './CollaborationResultsDock.tsx'
import type { CollaborationResultsInjected } from './CollaborationResultsDock.tsx'

/** Required client services. */
export const inject = ['inputTriggers', 'locale', 'sessions', 'conversation', 'slots']

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
  ctx.inject(['remote.session', 'connection', 'workspaces'], (resultsCtx) => {
    if (typeof window === 'undefined' || !window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable ||
      !window.__DSH_DESKTOP_HOST__.collaborationExecutionAvailable) return
    const connection = resultsCtx.get('connection') as ConnectionHandle
    const models = new Map<string, { model: CollaborationResultsModel; bindings: CollaborationResultsInjected }>()
    resultsCtx.effect(() => () => { models.forEach(({ model }) => { model.dispose() }); models.clear() },
      'ui-slark-agent: original Session results')
    resultsCtx.slots.inject('conversation.input.dock', () => resultsCtx.slots.register({
      name: 'conversation.input.dock', id: 'slark-collaboration-results', order: 25, locale: NS,
      inject: (sessionId) => {
        let entry = models.get(sessionId)
        if (!entry) {
          const model = new CollaborationResultsModel(sessionId, resultsCtx.workspaces.list, connection.generation,
            (cursor, signal) => resultsCtx.remote.session.collaborationSources({ sessionId, ...(cursor ? { cursor } : {}) }, signal),
            () => window.__DSH_DESKTOP_HOST__)
          entry = { model, bindings: { hooks: { slarkResults: model }, loadSources: () => model.loadSources(),
            consumptionAction: (digest, deliveryId, reconcile) => model.consumptionAction(digest, deliveryId, reconcile),
            executionAction: (digest, taskId, reconcile) => model.executionAction(digest, taskId, reconcile),
            loadReplies: digest => model.loadReplies(digest) } }
          models.set(sessionId, entry)
        }
        return entry.bindings
      },
    }, CollaborationResultsDock))
  })
  const t = ctx.locale.bind(NS)
  const scopedSource = createScopedCollaborationSource(ctx, t)
  const scopeModels = new Map<string, { model: ProjectScopeModel; bindings: ProjectScopeInjected }>()
  ctx.inject(['workspaces'], (scopeCtx) => {
    if (typeof window === 'undefined' || !window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) return
    scopeCtx.effect(() => () => { scopeModels.forEach(({ model }) => { model.dispose() }); scopeModels.clear() },
      'ui-slark-agent: scope projections')
    scopeCtx.slots.inject('conversation.input.dock', () => scopeCtx.slots.register({
      name: 'conversation.input.dock', id: 'slark-project-scope', order: 20, locale: NS,
      inject: (sessionId) => {
        let entry = scopeModels.get(sessionId)
        if (!entry) {
          const model = new ProjectScopeModel(sessionId, scopeCtx.workspaces.list, () => window.__DSH_DESKTOP_HOST__)
          entry = { model, bindings: { hooks: { slarkScope: model }, refreshScope: () => model.refresh(),
            applyScope: selected => model.apply(selected), loadProjects: () => model.loadProjects(),
            loadAgents: () => model.loadAgents(),
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
      },
    }, ProjectScopeDock))
  })
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'slark-agent',
    order: 5,
    showGroupTitle: false,
    matchEnterPosition: 'anywhere',
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
