/** Scoped Agent chips submit original Source text to Main; they never serialize into ordinary model chat. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createCollaborationReplyMatcher, readCollaborationPending, collaborationQuestionText } from './collaboration-dialogue.ts'
import type { zh } from './locales.ts'

interface Reference {
  kind: 'collaboration-v2'
  workspace_id: string
  session_id: string
  project_id: string
  project_name: string
  agent_id: string
  agent_name: string
  capability_snapshot: string
  source_id?: string
  original_source_id?: string
}
/** Page supplies only original text, editor occurrences and current directory metadata. */
export interface DesktopCollaborationSourceInput {
  workspace_id: string
  session_id: string
  source_message_id: string
  source_revision: '1'
  original_message: string
  active_mentions: Array<{
    mention_id: string
    source_span: { source_message_id: string; source_revision: '1'; start: number; end: number }
    display_snapshot: { agent_name: string; project_name: string }
    binding: { kind: 'resolved'; target: { project_id: string; agent_id: string }; capability_snapshot: string }
  }>
}
type SourceCoordinates = Pick<DesktopCollaborationSourceInput, 'workspace_id' | 'session_id' | 'source_message_id' | 'source_revision'>
/** Main's public projection contains no model, proof, token, grant or Task identity. */
export type CollaborationSubmissionResponse = {
  ok: true
  value: { source: SourceCoordinates
    submission_state: 'accepted'
    invocation_id?: string }
} | { ok: false; errorCode: string; reconciliationRequired: boolean }

function sameAcceptedSource(value: { submission_state: unknown; source: Record<keyof SourceCoordinates, unknown> },
  original: SourceCoordinates): boolean {
  const source = value.source
  return value.submission_state === 'accepted' && source.workspace_id === original.workspace_id &&
    source.session_id === original.session_id && source.source_message_id === original.source_message_id &&
    source.source_revision === original.source_revision
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const text = (v: unknown, maximum: number): v is string => typeof v === 'string' && v.length > 0 &&
  new TextEncoder().encode(v).byteLength <= maximum && !/[\x00-\x1f\x7f]/u.test(v)
function isReference(r: Record<string, unknown>): r is Record<string, unknown> & Reference {
  const keys = ['kind', 'workspace_id', 'session_id', 'project_id', 'project_name', 'agent_id', 'agent_name', 'capability_snapshot']
  if (Object.hasOwn(r, 'source_id')) keys.push('source_id')
  if (Object.hasOwn(r, 'original_source_id')) keys.push('original_source_id')
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) ||
    r.kind !== 'collaboration-v2' || !text(r.workspace_id, 36) || !uuid.test(r.workspace_id) ||
    !text(r.session_id, 256) || !text(r.project_id, 256) || !text(r.agent_id, 256) ||
    !text(r.project_name, 512) || !text(r.agent_name, 512) ||
    typeof r.capability_snapshot !== 'string' || !/^[a-f0-9]{64}$/u.test(r.capability_snapshot) ||
    (r.source_id !== undefined && (!text(r.source_id, 36) || !uuid.test(r.source_id))) ||
    (r.original_source_id !== undefined &&
    (!r.source_id || !text(r.original_source_id, 36) || !uuid.test(r.original_source_id)))) return false
  return true
}
function parse(value: string): Reference | undefined {
  try {
    if (new TextEncoder().encode(value).byteLength > 4096) return undefined
    const v: unknown = JSON.parse(value)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const r = v as Record<string, unknown>
    return isReference(r) ? r : undefined
  } catch { return undefined }
}
const label = (r: Reference) => `${r.agent_name} · ${r.project_name}`
/**
 * Preserve the full scoped display label during chip clipboard export.
 * @param ref - the original scoped chip metadata.
 * @returns its @ label, or undefined for a malformed or unpicked reference.
 */
export function scopedCollaborationClipboard(ref: string): string | undefined {
  const r = parse(ref)
  return r?.source_id ? `@${label(r)}` : undefined
}
function workspaceOf(ctx: Context, sessionId: SessionId): string | undefined {
  const workspaces = ctx.get('workspaces')
  const snapshot = workspaces?.list.getSnapshot()
  if (!snapshot || snapshot.phase !== 'ready' || snapshot.state === 'error' || snapshot.archivedSessionIds.includes(sessionId)) return undefined
  return snapshot.items.find(w => w.sessionIds.includes(sessionId))?.workspaceId
}

/**
 * Candidates require current scope and execution availability; every send rechecks Session membership and the original chip.
 * @param ctx - the source entry's Client Context; optional workspace state is read on each operation.
 * @param t - the entry's typed locale dictionary.
 * @returns a source that submits original text through Main and retains failed drafts without fallback.
 */
export function createScopedCollaborationSource(ctx: Context, t: (key: keyof typeof zh) => string): InputTriggerSource {
  const reply = createCollaborationReplyMatcher(ctx, t, workspaceOf)
  return {
    trigger: '@', name: 'slark-agent', matchEnterPosition: 'anywhere',
    async candidates(session, { query, signal }) {
      const host = window.__DSH_DESKTOP_HOST__, workspace = workspaceOf(ctx, session.sessionId)
      const current = () => !signal.aborted && window.__DSH_DESKTOP_HOST__ === host &&
        workspaceOf(ctx, session.sessionId) === workspace &&
        host?.collaborationScopeAvailable === true && host.collaborationExecutionAvailable === true
      if (!workspace || !host?.collaborationScopeAvailable || !host.collaborationExecutionAvailable ||
        !host.collaborationWorkspace || !host.collaborationSubmit || signal.aborted) return []
      let response
      try {
        response = await host.collaborationWorkspace({ workspace_id: workspace, session_id: session.sessionId,
          operation: { kind: 'agents', query: { limit: 20, query: query.trim() } } })
      } catch { return [] }
      if (!current() || !response.ok || !('scope_version' in response.value)) return []
      return response.value.items.filter(item => item.available && item.reason_code === 'ready').map(item => ({
        name: `${item.agent_name} · ${item.project_name} · ${item.agent_id}`,
        label: `${item.agent_name} · ${item.project_name}`, description: item.project_name,
        section: t('section.scopedAgents'),
        value: JSON.stringify({ kind: 'collaboration-v2', workspace_id: workspace, session_id: session.sessionId,
          project_id: item.project_id, project_name: item.project_name, agent_id: item.agent_id,
          agent_name: item.agent_name, capability_snapshot: item.capability_snapshot }),
      }))
    },
    onPick({ candidate, session }) {
      const r = candidate.value === undefined ? undefined : parse(candidate.value)
      const host = window.__DSH_DESKTOP_HOST__
      if (!r || r.source_id || !host?.collaborationExecutionAvailable || !host.collaborationScopeAvailable ||
        r.session_id !== session.sessionId || workspaceOf(ctx, session.sessionId) !== r.workspace_id) return undefined
      const scoped = ctx.sessions.scope(session.sessionId)
      if (!scoped) return undefined
      const existing = ctx.conversation.input.for(scoped).state.getSnapshot().occurrences
        .filter(mention => mention.source === 'slark-agent').map(mention => parse(mention.ref))
      const originalId = existing[0]?.original_source_id ?? existing[0]?.source_id
      if (existing.some(old => !old?.source_id || old.session_id !== r.session_id || old.workspace_id !== r.workspace_id ||
        (old.original_source_id ?? old.source_id) !== originalId)) return undefined
      const sourceId = randomUUID()
      return { insert: { source: 'slark-agent', ref: JSON.stringify({ ...r, source_id: sourceId,
        original_source_id: originalId ?? sourceId }),
      label: label(r), clipboardText: `@${label(r)}` } }
    },
    async matchEnter(session, line, signal, envelope) {
      const scoped = ctx.sessions.scope(session.sessionId)
      if (!scoped) return undefined
      const snapshot = ctx.conversation.input.for(scoped).state.getSnapshot()
      const host = window.__DSH_DESKTOP_HOST__
      if (!snapshot.occurrences.length) return reply(session, line, signal, envelope)
      if (!snapshot.occurrences.some(mention => mention.source === 'slark-agent')) return undefined
      if (!host?.collaborationExecutionAvailable || !host.collaborationScopeAvailable || !host.collaborationSubmit) throw Error(t('scope.executorPending'))
      if (snapshot.draft.trim() !== line || snapshot.occurrences.length > 10 || envelope.attachments > 0) throw Error(t('submit.textOnlyV2'))
      const submit = host.collaborationSubmit.bind(host)
      const available = () => host.collaborationScopeAvailable && host.collaborationExecutionAvailable
      const workspace = workspaceOf(ctx, session.sessionId), mentionIds = new Set<string>()
      let sourceId: string | undefined
      let previousEnd = 0, question = ''
      const selected = [...snapshot.occurrences].sort((a, b) => a.offset - b.offset).map((mention) => {
        const r = parse(mention.ref), end = mention.offset + mention.length, mentionId = r?.source_id
        if (!r || !mentionId || mentionIds.has(mentionId) || r.session_id !== session.sessionId || workspace !== r.workspace_id ||
          mention.source !== 'slark-agent' || !Number.isSafeInteger(mention.offset) || !Number.isSafeInteger(mention.length) ||
          mention.offset < previousEnd || mention.length < 2 || end > snapshot.draft.length ||
          mention.clipboardText !== `@${label(r)}` || snapshot.draft.slice(mention.offset, end) !== mention.clipboardText) throw Error(t('submit.unavailable'))
        const originalId = r.original_source_id ?? mentionId
        if (sourceId === undefined) sourceId = originalId
        else if (sourceId !== originalId) throw Error(t('submit.unavailable'))
        mentionIds.add(mentionId)
        question += snapshot.draft.slice(previousEnd, mention.offset)
        previousEnd = end
        return { r, mention, mentionId, end }
      })
      if (!(question + snapshot.draft.slice(previousEnd)).trim()) throw Error(t('submit.question'))
      const first = selected[0] as (typeof selected)[number]
      const originalId = first.r.original_source_id ?? first.mentionId
      signal.throwIfAborted()
      const original: DesktopCollaborationSourceInput = { workspace_id: first.r.workspace_id, session_id: session.sessionId,
        source_message_id: originalId, source_revision: '1', original_message: snapshot.draft,
        active_mentions: selected.map(({ r, mention, mentionId, end }) => ({ mention_id: mentionId,
          source_span: { source_message_id: originalId, source_revision: '1', start: mention.offset, end },
          display_snapshot: { agent_name: r.agent_name, project_name: r.project_name },
          binding: { kind: 'resolved', target: { project_id: r.project_id, agent_id: r.agent_id }, capability_snapshot: r.capability_snapshot } })) }
      return { claim: { name: 'slark-agent', token: line, retainOnFailure: false,
        async submit(args, actx) {
          signal.throwIfAborted()
          const latest = ctx.conversation.input.for(actx).state.getSnapshot()
          if (ctx.sessions.scopeOf(actx) !== session.sessionId || latest.draft !== snapshot.draft ||
            latest.occurrences.length !== snapshot.occurrences.length || latest.occurrences.some((current, index) => {
            const captured = snapshot.occurrences[index]
            return !captured || current.source !== captured.source || current.ref !== captured.ref || current.offset !== captured.offset ||
                current.length !== captured.length || current.clipboardText !== captured.clipboardText
          }) || args.trim() !== '' ||
            workspaceOf(ctx, session.sessionId) !== first.r.workspace_id || window.__DSH_DESKTOP_HOST__ !== host ||
            !available()) return { kind: 'error', text: t('submit.changed') }
          let result: CollaborationSubmissionResponse
          try { result = await submit(original) }
          catch { result = { ok: false, errorCode: 'transport_unavailable', reconciliationRequired: true } }
          signal.throwIfAborted()
          if (window.__DSH_DESKTOP_HOST__ !== host || workspaceOf(ctx, session.sessionId) !== first.r.workspace_id || !available()) return { kind: 'error', text: t('submit.uncertainV2') }
          if (!result.ok) {
            if (host.collaborationPending) {
              try {
                const page = await readCollaborationPending(host, original, signal)
                if (window.__DSH_DESKTOP_HOST__ !== host || workspaceOf(ctx, session.sessionId) !== first.r.workspace_id || !available()) return { kind: 'error', text: t('submit.uncertainV2') }
                if (page.pending_items.length) {
                  window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: original }))
                  return { kind: 'success', text: collaborationQuestionText(page) }
                }
              } catch (error) { if (signal.aborted) throw error }
            }
            return { kind: 'error', text: t(result.reconciliationRequired ? 'submit.uncertainV2' : 'submit.unavailableV2') }
          }
          if (!sameAcceptedSource(result.value, original)) return { kind: 'error', text: t('submit.uncertainV2') }
          window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: original }))
          return { kind: 'success', text: t('submit.acceptedV2') }
        },
      } }
    },
  }
}
