/** DSH `@` source for the live, employee-assigned Slark Agent directory. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { en, NS, zh } from './locales.ts'

/** Required client services. */
export const inject = ['inputTriggers', 'locale']

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
}

declare global {
  interface Window {
    __DSH_DESKTOP_HOST__?: DesktopAgentDirectory
  }
}

function parseReference(value: string): AgentItem | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const item = parsed as Record<string, unknown>
    if (!['assignment_id', 'project_id', 'agent_id', 'enterprise_id', 'name'].every(
      key => typeof item[key] === 'string' && (item[key] as string).length > 0,
    ) || !Number.isSafeInteger(item.publication_version)) return null
    return item as unknown as AgentItem
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
        source: 'slark-agent', ref: candidate.value, label: item.name,
        clipboardText: `@${item.name}`,
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
