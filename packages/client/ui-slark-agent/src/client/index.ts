/** DSH `@` source for the live, employee-assigned Slark Agent directory. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { en, NS, zh } from './locales.ts'
import { AgentTaskDock } from './AgentTaskDock.tsx'
import { ProjectScopeModel } from './project-scope.ts'
import type { WorkspaceBridge } from './project-scope.ts'
import { ProjectScopeDock } from './ProjectScopeDock.tsx'
import type { ProjectScopeInjected } from './ProjectScopeDock.tsx'

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

interface DesktopAgentDirectory extends WorkspaceBridge {
  collaborationScopeAvailable?: boolean
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

function parseReference(value: string): (AgentItem & { logical_key?: string; logical_key_version?: 2 }) | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const item = parsed as Record<string, unknown>
    if (!['assignment_id', 'project_id', 'agent_id', 'enterprise_id', 'name'].every(
      key => typeof item[key] === 'string' && item[key].length > 0,
    ) || !Number.isSafeInteger(item.publication_version) ||
      (item.logical_key_version !== undefined && item.logical_key_version !== 2)) return null
    return item as unknown as AgentItem & { logical_key?: string; logical_key_version?: 2 }
  } catch { return null }
}

/** Preserve legacy references whose project display name was not recorded. */
function agentLabel(item: AgentItem): string {
  return typeof item.project_name === 'string' && item.project_name.length > 0
    ? `${item.name} · ${item.project_name}` : item.name
}

/** Register a stable-reference source; ordinary model serialization refuses the Agent chip. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-slark-agent: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'slark-agent-tasks', order: 25, locale: NS,
    inject: sessionId => ({ sessionId }),
  }, AgentTaskDock))
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
            loadAgents: () => model.loadAgents() } }
          scopeModels.set(sessionId, entry)
        }
        return entry.bindings
      },
    }, ProjectScopeDock))
  })
  const t = ctx.locale.bind(NS)
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'slark-agent',
    order: 5,
    showGroupTitle: false,
    matchEnterPosition: 'anywhere',
    async candidates(_session, { query, signal }) {
      const host = typeof window === 'undefined' ? undefined : window.__DSH_DESKTOP_HOST__
      if (host?.collaborationScopeAvailable) {
        // The v2 directory is read-only until its own executor is connected. No legacy fallback.
        return []
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
    onPick({ candidate }) {
      if (typeof window !== 'undefined' && window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) return undefined
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
      if (matches.length === 0 || state.draft.trim() !== line) return undefined
      if (window.__DSH_DESKTOP_HOST__?.collaborationScopeAvailable) throw new Error(t('scope.executorPending'))
      if (matches.length !== 1 || state.occurrences.length !== 1 || envelope.attachments > 0) {
        throw new Error(t('submit.single'))
      }
      const mention = matches[0]
      if (!mention) return undefined
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
        const item = parseReference(ref)
        return item ? `@${agentLabel(item)}` : '@'
      },
      serialize() { return Promise.reject(new Error(t('submit.unavailable'))) },
    },
  }
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => triggers.registerSource(source), 'ui-slark-agent: @ source')
}
