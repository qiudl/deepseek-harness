/** Original-Source pending reads and passive chat replies through the account-bound Main bridge. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionCollaborationSourceItem } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CollaborationSubmissionResponse, DesktopCollaborationSourceInput } from './collaboration-source.ts'
import type { zh } from './locales.ts'

type Source = SessionCollaborationSourceItem['source']
/** Current retained questions; frozen task count is not an admission receipt. */
export interface CollaborationPendingPage {
  readonly source: Source
  readonly plan: { readonly plan_id: string
    readonly plan_revision: string
    readonly state_version: string
    readonly input_version: string
    readonly planning_state: string
    readonly route_decision: string } | null
  readonly pending_items: readonly { readonly pending_item_id: string
    readonly revision: string
    readonly reason: string
    readonly question: string
    readonly mentions: readonly { readonly mention_id: string
      readonly agent_name: string
      readonly project_name: string | null }[] }[]
  readonly frozen_task_count: number
}
/** Source-only history response from Main. */
export type CollaborationPendingResponse = { ok: true; value: CollaborationPendingPage } | { ok: false; errorCode: string }
/** A passive reply retains original target selection and supplies no new @ mentions. */
export interface DesktopClarificationReplyInput {
  readonly source: Source
  readonly plan_id: string
  readonly expected_plan_revision: string
  readonly pending_item_ids: readonly string[]
  readonly reply_input: Omit<DesktopCollaborationSourceInput, 'active_mentions'> & { readonly active_mentions: [] }
}
/** Main owns Source authorization, planning, CAS, task admission and account identity. */
export type CollaborationClarificationResponse = CollaborationSubmissionResponse | { ok: true
  value: {
    source: Source
    submission_state: 'clarification_recorded'
    reply_source: Source } }
/** Main owns the original and passive reply commit identities. */
export interface CollaborationDialogueBridge {
  collaborationPending?(input: { source: Source }): Promise<CollaborationPendingResponse>
  collaborationClarify?(input: DesktopClarificationReplyInput): Promise<CollaborationClarificationResponse>
}
const array = (value: unknown): boolean => Array.isArray(value)
const sameSource = (a: Source, b: Source) => a.workspace_id === b.workspace_id && a.session_id === b.session_id
  && a.source_message_id === b.source_message_id && a.source_revision === b.source_revision
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value)
  && BigInt(value) <= 9223372036854775807n
const id = (value: unknown): value is string => typeof value === 'string' && /^[!-~]{1,256}$/u.test(value)
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0
  && !/\p{Surrogate}/u.test(value) && new TextEncoder().encode(value).length <= limit
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new DOMException('Cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}
/**
 * Check a public Main response against its exact original coordinates without granting task authority.
 * @param host - Current account-bound Desktop bridge.
 * @param source - Original Source selected from a trusted local capture or Session feed.
 * @param signal - Caller cancellation; the read never submits work or prepares a model.
 * @returns a detached page or rejection for unavailable, substituted or malformed responses.
 */
export async function readCollaborationPending(host: CollaborationDialogueBridge, source: Source,
  signal: AbortSignal): Promise<CollaborationPendingPage> {
  if (!host.collaborationPending) throw Error('pending_unavailable')
  signal.throwIfAborted()
  const result = await wait(host.collaborationPending({ source }), signal)
  signal.throwIfAborted()
  if (!result.ok) throw Error('pending_unavailable')
  const page = result.value
  if (!sameSource(page.source, source) || !array(page.pending_items)
    || !Number.isSafeInteger(page.frozen_task_count) || page.frozen_task_count < 0
    || page.pending_items.length + page.frozen_task_count > 10 || bytes(page) > 512 * 1024) throw Error('pending_invalid')
  if (page.plan === null) {
    if (page.pending_items.length || page.frozen_task_count) throw Error('pending_invalid')
  } else {
    const plan = page.plan
    if (!['queued', 'planning', 'ready', 'partial_clarify', 'clarify', 'discuss', 'unsupported', 'failed', 'cancelled'].includes(plan.planning_state)
      || !['undecided', 'collaboration', 'local'].includes(plan.route_decision)
      || !id(plan.plan_id) || !positive(plan.plan_revision) || !positive(plan.state_version) || !positive(plan.input_version)
      || BigInt(plan.state_version) < BigInt(plan.plan_revision) ||
      (page.pending_items.length > 0 && (plan.route_decision !== 'collaboration'
        || !['clarify', 'partial_clarify'].includes(plan.planning_state)))) throw Error('pending_invalid')
  }
  const seen = new Set<string>()
  for (const pending of page.pending_items) {
    if (!id(pending.pending_item_id) || seen.has(pending.pending_item_id) || !positive(pending.revision)
      || !text(pending.question, 2048) || !array(pending.mentions) || pending.mentions.length === 0
      || pending.mentions.length > 10 || !['target_ambiguous', 'task_ambiguous', 'reference_ambiguous', 'dependency_unsupported'].includes(pending.reason)) throw Error('pending_invalid')
    seen.add(pending.pending_item_id)
    if (new Set(pending.mentions.map(mention => mention.mention_id)).size !== pending.mentions.length
      || pending.mentions.some(mention => !id(mention.mention_id) || !text(mention.agent_name, 512)
        || (mention.project_name !== null && !text(mention.project_name, 512)))) throw Error('pending_invalid')
  }
  return structuredClone(page)
}
/**
 * Format committed questions as plain text without claiming frozen work was accepted.
 * @param page - Checked current pending projection.
 * @returns complete questions with their original Agent and project display labels.
 */
export function collaborationQuestionText(page: CollaborationPendingPage): string {
  return page.pending_items.map(item => `${item.mentions.map(mention =>
    `${mention.agent_name}${mention.project_name === null ? '' : ` · ${mention.project_name}`}`).join(', ')}\n${item.question}`).join('\n\n')
}

/**
 * Recover unresolved originals from the Profile's complete Session feed; never choose the latest plan.
 * @param ctx - Client owner with optional Session Remote and workspace services.
 * @param t - Typed dictionary for user-facing refusal messages.
 * @param workspaceOf - Current Session membership reader.
 * @returns an Enter handler for plain replies; new chips are handled by the original Source owner.
 */
export function createCollaborationReplyMatcher(ctx: Context, t: (key: keyof typeof zh) => string,
  workspaceOf: (ctx: Context, sessionId: SessionId) => string | undefined): NonNullable<InputTriggerSource['matchEnter']> {
  const retries = new Map<SessionId, { host: NonNullable<Window['__DSH_DESKTOP_HOST__']>; draft: string; request: DesktopClarificationReplyInput }>()
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(); retries.clear() }, 'ui-slark-agent: passive reply retries')
  return async (session, line, signal, envelope) => {
    const scoped = ctx.sessions.scope(session.sessionId)
    if (!scoped) return undefined
    const snapshot = ctx.conversation.input.for(scoped).state.getSnapshot()
    const host = window.__DSH_DESKTOP_HOST__, workspace = workspaceOf(ctx, session.sessionId)
    if (snapshot.occurrences.length || snapshot.draft.trim() !== line || !host?.collaborationScopeAvailable
      || !host.collaborationExecutionAvailable || !host.collaborationPending || !host.collaborationClarify || !workspace) return undefined
    const ownedSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(30_000)])
    const current = () => {
      ownedSignal.throwIfAborted()
      if (window.__DSH_DESKTOP_HOST__ !== host || workspaceOf(ctx, session.sessionId) !== workspace
        || !host.collaborationScopeAvailable || !host.collaborationExecutionAvailable) throw Error(t('submit.changed'))
    }
    current()
    const retry = retries.get(session.sessionId)
    let request = retry?.host === host && retry.draft === snapshot.draft && retry.request.source.workspace_id === workspace
      ? retry.request : undefined
    if (!request) {
      const remote = ctx.get('remote.session') as typeof ctx.remote.session | undefined
      if (!remote) throw Error(t('submit.unavailableV2'))
      let cursor: string | undefined
      const originals: SessionCollaborationSourceItem[] = [], digests = new Set<string>(), coordinates = new Set<string>()
      do {
        let result: Awaited<ReturnType<typeof remote.collaborationSources>>
        try {
          result = await wait(remote.collaborationSources({ sessionId: session.sessionId, ...(cursor ? { cursor } : {}) },
            ownedSignal), ownedSignal)
        }
        catch (error) { if (ownedSignal.aborted) throw error; throw Error(t('submit.unavailableV2')) }
        current()
        if (!result.ok || !Array.isArray(result.value.items) || result.value.items.length > 8 || bytes(result.value) > 256 * 1024) throw Error(t('submit.unavailableV2'))
        const page = result.value
        for (const item of page.items) {
          const key = JSON.stringify(item.source)
          if (item.source.workspace_id !== workspace || item.source.session_id !== session.sessionId
            || !/^[a-f0-9]{64}$/u.test(item.snapshot_digest) || digests.has(item.snapshot_digest) || coordinates.has(key)
            || !text(item.original_message, 32 * 1024) || originals.length === 128) throw Error(t('submit.unavailableV2'))
          originals.push(item); digests.add(item.snapshot_digest); coordinates.add(key)
        }
        if (page.next_cursor !== undefined && (!page.items.length || page.next_cursor !== page.items.at(-1)?.snapshot_digest
          || page.next_cursor === cursor || originals.length === 128)) throw Error(t('submit.unavailableV2'))
        cursor = page.next_cursor
      } while (cursor !== undefined)
      const pending: CollaborationPendingPage[] = []
      for (let i = 0; i < originals.length; i += 4) {
        let pages: CollaborationPendingPage[]
        try { pages = await Promise.all(originals.slice(i, i + 4).map(item => readCollaborationPending(host, item.source, ownedSignal))) }
        catch (error) { if (ownedSignal.aborted) throw error; throw Error(t('submit.unavailableV2')) }
        current()
        for (const page of pages) {
          if (page.plan && ['queued', 'planning'].includes(page.plan.planning_state)) throw Error(t('submit.uncertainV2'))
          if (page.pending_items.length) pending.push(page)
        }
      }
      if (!pending.length) return undefined
      const page = pending[0]
      if (pending.length !== 1 || !page || page.pending_items.length !== 1) throw Error(t('submit.multiplePending'))
      const plan = page.plan as NonNullable<CollaborationPendingPage['plan']>
      if (envelope.attachments > 0) throw Error(t('submit.single'))
      if (!text(snapshot.draft, 32 * 1024)) throw Error(t('submit.unavailableV2'))
      const subtle = Reflect.get(globalThis.crypto, 'subtle') as SubtleCrypto | undefined
      if (!subtle) throw Error(t('submit.unavailableV2'))
      // Identity excludes the changing plan revision, so identical replies remain one Source after reload.
      const digest = await wait(subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
        [page.source.workspace_id, page.source.session_id, page.source.source_message_id, page.source.source_revision],
        plan.plan_id, page.pending_items.map(item => item.pending_item_id).sort(), snapshot.draft,
      ]))), ownedSignal)
      current()
      const replyId = 'clarify-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      request = { source: page.source, plan_id: plan.plan_id, expected_plan_revision: plan.plan_revision,
        pending_item_ids: page.pending_items.map(item => item.pending_item_id),
        reply_input: { workspace_id: workspace, session_id: session.sessionId, source_message_id: replyId,
          source_revision: '1', original_message: snapshot.draft, active_mentions: [] } }
    }
    const captured = request, clarify = (input: DesktopClarificationReplyInput) => host.collaborationClarify?.(input)
    return { claim: { name: 'slark-agent', token: line, retainOnFailure: false,
      async submit(args, actx) {
        current()
        const latest = ctx.conversation.input.for(actx).state.getSnapshot()
        if (ctx.sessions.scopeOf(actx) !== session.sessionId || latest.draft !== snapshot.draft
          || latest.occurrences.length || args.trim() !== '' || envelope.attachments > 0) return { kind: 'error', text: t('submit.changed') }
        retries.set(session.sessionId, { host, draft: snapshot.draft, request: captured })
        let result: CollaborationClarificationResponse
        try {
          const promise = clarify(captured)
          if (!promise) return { kind: 'error', text: t('submit.unavailableV2') }
          result = await wait(promise, ownedSignal)
        }
        catch { return { kind: 'error', text: t('submit.uncertainV2') } }
        current()
        if (result.ok && result.value.submission_state === 'accepted' && sameSource(result.value.source, captured.source)) {
          retries.delete(session.sessionId)
          window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: captured.source }))
          return { kind: 'success', text: t('submit.acceptedV2') }
        }
        if (result.ok && result.value.submission_state === 'clarification_recorded'
          && sameSource(result.value.source, captured.source) && sameSource(result.value.reply_source, captured.reply_input)) {
          retries.delete(session.sessionId)
          window.dispatchEvent(new CustomEvent('dsh-slark-collaboration-admitted', { detail: captured.source }))
          try {
            const page = await readCollaborationPending(host, captured.source, ownedSignal)
            current()
            return { kind: 'success', text: page.pending_items.length ? collaborationQuestionText(page) : t('submit.clarificationRecorded') }
          } catch (error) {
            if (ownedSignal.aborted) throw error
            current()
            return { kind: 'success', text: t('submit.clarificationRecorded') }
          }
        }
        return { kind: 'error', text: t('submit.uncertainV2') }
      },
    } }
  }
}
