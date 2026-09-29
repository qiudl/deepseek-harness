/** DSH `@` source for the live, employee-assigned Slark Agent directory. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { en, NS, zh } from './locales.ts'

/** Required client services. */
export const inject = ['inputTriggers', 'locale', 'sessions', 'conversation']

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

interface DesktopAgentDirectory {
  enterpriseAgents(): Promise<{ ok: true; items: AgentItem[] } | { ok: false; errorCode: string }>
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
}

declare global {
  interface Window {
    __DSH_DESKTOP_HOST__?: DesktopAgentDirectory
  }
}

function parseReference(value: string): (AgentItem & { logical_key?: string }) | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const item = parsed as Record<string, unknown>
    if (!['assignment_id', 'project_id', 'agent_id', 'enterprise_id', 'name'].every(
      key => typeof item[key] === 'string' && (item[key] as string).length > 0,
    ) || !Number.isSafeInteger(item.publication_version)) return null
    return item as unknown as AgentItem & { logical_key?: string }
  } catch { return null }
}

/** Register a stable-reference source; ordinary model serialization refuses the Agent chip. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-slark-agent: dictionaries')
  const t = ctx.locale.bind(NS)
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'slark-agent',
    order: 5,
    showGroupTitle: false,
    async candidates(_session, { query, signal }) {
      const host = typeof window === 'undefined' ? undefined : window.__DSH_DESKTOP_HOST__
      if (!host?.enterpriseAgents) return []
      const response = await host.enterpriseAgents()
      if (!response.ok || signal.aborted) return []
      const needle = query.trim().toLocaleLowerCase()
      return response.items.filter(item =>
        `${item.name} ${item.enterprise_name} ${item.project_name}`.toLocaleLowerCase().includes(needle),
      ).map(item => ({
        name: `${item.name} · ${item.enterprise_name}/${item.project_name} · ${item.agent_id}`,
        label: item.name,
        description: `${item.enterprise_name} / ${item.project_name}`,
        section: t('section.agents'),
        value: JSON.stringify(item),
      }))
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      const item = parseReference(candidate.value)
      if (!item) return undefined
      return { insert: {
        source: 'slark-agent', ref: JSON.stringify({ ...item, logical_key: randomUUID() }), label: item.name,
        clipboardText: `@${item.name}`,
      } }
    },
    async matchEnter(session, line, _signal, envelope) {
      const scoped = ctx.sessions.scope(session.sessionId)
      if (!scoped) return undefined
      const state = ctx.conversation.input.for(scoped).state.getSnapshot()
      const matches = state.occurrences.filter(occ => occ.source === 'slark-agent')
      if (matches.length !== 1 || matches[0]?.offset !== 0 || state.draft.trim() !== line) {
        return undefined
      }
      const mention = matches[0]
      const item = parseReference(mention.ref)
      const logicalKey = item?.logical_key
      if (!logicalKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(logicalKey)) {
        throw new Error(t('submit.unavailable'))
      }
      if (state.occurrences.length !== 1 || envelope.attachments > 0) {
        throw new Error(t('submit.single'))
      }
      const question = state.draft.slice(mention.length).trim()
      if (!question) throw new Error(t('submit.question'))
      const snapshot = state.draft
      return { claim: {
        name: 'slark-agent', token: `${mention.clipboardText} `,
        async submit(args, actx) {
          const latest = ctx.conversation.input.for(actx).state.getSnapshot()
          if (ctx.sessions.scopeOf(actx) !== session.sessionId ||
            latest.draft !== snapshot || latest.occurrences.length !== 1 ||
            latest.occurrences[0]?.ref !== mention.ref || args.trim() !== question) {
            return { kind: 'error', text: t('submit.changed') }
          }
          const host = window.__DSH_DESKTOP_HOST__
          if (!host?.invokeEnterpriseAgent) return { kind: 'error', text: t('submit.unavailable') }
          const result = await host.invokeEnterpriseAgent({
            session_id: session.sessionId, logical_key: logicalKey,
            assignment_id: item.assignment_id, project_id: item.project_id,
            agent_id: item.agent_id, publication_version: item.publication_version,
            question,
          })
          return result.ok ? { kind: 'success', text: t('submit.accepted') }
            : { kind: 'error', text: t('submit.unavailable') }
        },
      } }
    },
    codec: {
      clipboardText(ref) { return `@${parseReference(ref)?.name ?? ''}` },
      async serialize() { throw new Error(t('submit.unavailable')) },
    },
  }
  const triggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => triggers.registerSource(source), 'ui-slark-agent: @ source')
}
