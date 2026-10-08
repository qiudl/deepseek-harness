/** Workspace-bound readonly collaboration messages/results; view lifetimes never cancel accepted work. */
import { readCollaborationPending } from './collaboration-dialogue.ts'
import type { CollaborationDialogueBridge, CollaborationPendingPage } from './collaboration-dialogue.ts'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionCollaborationSourceItem, SessionCollaborationSourcesValue } from '@deepseek-ai/dsh-api-session-controller/types'

type Source = SessionCollaborationSourceItem['source']
/** Main's readable result projection; transport delivery and execution have separate states. */
export interface ScopedCollaborationReply {
  readonly delivery_id: string
  readonly invocation_id: string
  readonly task_id?: string
  readonly delivery_state: string
  readonly delivery_state_version: string
  readonly source_locator: Source
  readonly source_snapshot_digest: string
  readonly execution_state?: string
  readonly invocation_state_version?: string
  readonly target_display_snapshot?: { readonly agent_name: string; readonly project_name: string | null }
  readonly answer?: string
}
/** Page methods cannot select Account, Host, Computer or authorization proof. */
export interface CollaborationResultsBridge extends CollaborationDialogueBridge {
  readonly collaborationScopeAvailable?: boolean
  readonly collaborationPlanningAvailable?: boolean
  collaborationRootExecution?(request: { action: 'preview'; source: Source } |
    { action: 'confirm' | 'reconcile'; previewId: string; taskId: string } |
    { action: 'consume' | 'consumption-status'; previewId: string; taskId: string; deliveryId: string }): Promise<unknown>
  collaborationDeliveries?(request: { source: Source; limit: number; after_delivery_id?: string }): Promise<
    { ok: true; value: { deliveries: readonly ScopedCollaborationReply[]; next_cursor?: string } } | { ok: false; errorCode: string }>
}
/** Main-owned preview and local command progress; these labels never assert task completion. */
export interface CollaborationExecutionView {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly previewId?: string
  readonly rootTraceId?: string
  readonly enabled?: boolean
  readonly tasks?: readonly { taskId: string; question: string; agentName: string; projectName: string }[]
  readonly outcomes?: Readonly<Record<string, 'sending' | 'recorded' | 'uncertain' | 'not_admitted'>>
  readonly consumptions?: Readonly<Record<string, 'sending' | 'context_applied' | 'continued' | 'uncertain'>>
}
/** One original message and the readable results obtained for that exact snapshot. */
export interface CollaborationResultGroup {
  readonly original: SessionCollaborationSourceItem
  readonly replies: readonly ScopedCollaborationReply[]
  readonly phase: 'ready' | 'loading' | 'error'
  readonly pending?: CollaborationPendingPage['pending_items']
  readonly pendingUnavailable?: boolean
  readonly planningState?: string
  readonly execution?: CollaborationExecutionView
  readonly nextCursor?: string
}
/** Stable observable value consumed by the injected framework hook. */
export interface CollaborationResultsSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly workspaceHistory?: true
  readonly locatorAvailable?: true
  readonly focus?: { readonly snapshotDigest: string; readonly sequence: number }
  readonly location?: { readonly snapshotDigest: string; readonly status: 'loading' | 'opened' | 'unavailable' }
  readonly executionAvailable?: boolean
  readonly groups: readonly CollaborationResultGroup[]
  readonly nextCursor?: string
}
type Generation = { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
type ReadableResultsBridge = CollaborationResultsBridge & Required<Pick<CollaborationResultsBridge, 'collaborationDeliveries'>>
type ReadSources = (cursor: string | undefined, signal: AbortSignal, sessionId: SessionId) => Promise<
  { ok: true; value: SessionCollaborationSourcesValue } | { ok: false }>
type ReadOriginal = (original: SessionCollaborationSourceItem, signal: AbortSignal) => ReturnType<ReadSources>
type SourceCursor = { sessionId: SessionId; nativeCursor?: string }
const empty = (): CollaborationResultsSnapshot => ({ phase: 'idle', groups: [] })
const sameSource = (a: Source, b: Source): boolean => a.workspace_id === b.workspace_id && a.session_id === b.session_id
  && a.source_message_id === b.source_message_id && a.source_revision === b.source_revision
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const array = (value: unknown): boolean => Array.isArray(value)
const safeText = (value: unknown, max: number): value is string => typeof value === 'string'
  && !/\p{Surrogate}/u.test(value) && new TextEncoder().encode(value).length <= max
function validPosition(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'after_sequence,local_order'
    && (row.after_sequence === null || typeof row.after_sequence === 'number'
      && Number.isSafeInteger(row.after_sequence) && row.after_sequence >= 0)
    && typeof row.local_order === 'string' && /^[1-9][0-9]{0,18}$/u.test(row.local_order)
    && BigInt(row.local_order) <= 9223372036854775807n
}
function samePosition(a: SessionCollaborationSourceItem, b: SessionCollaborationSourceItem): boolean {
  const first = a.timeline_position, second = b.timeline_position
  return first === second || first != null && second != null
    && first.after_sequence === second.after_sequence && first.local_order === second.local_order
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new DOMException('Cancelled', 'AbortError')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** Own readonly paging and refresh through the Session, workspace and Connection generation. */
export class CollaborationResultsModel {
  private state = empty()
  private executions = new Map<string, CollaborationExecutionView>()
  private observers = new Set<() => void>()
  private generation = 0
  private workspaceId: string | undefined
  private sessionIds: readonly SessionId[] = []
  private sourceCursors = new Map<string, SourceCursor>()
  private locatedOriginal: SessionCollaborationSourceItem | undefined
  private focusSequence = 0
  private location: CollaborationResultsSnapshot['location']
  private connectionGeneration: unknown
  private boundBridge: CollaborationResultsBridge | undefined
  private controller: AbortController | undefined
  private pending = false
  private sourcePages = 1
  private replyPages = new Map<string, number>()
  private again = false
  private closed = false
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void)[]
  private refreshEvent = (event: Event): void => {
    this.bind()
    const sessionId = (event as CustomEvent<Source | undefined>).detail?.session_id
    if (this.sessionIds.some(id => id === sessionId)) void this.refresh()
  }

  constructor(private sessionId: SessionId, private workspaces: WorkspaceSource, private connection: Generation,
    private readSources: ReadSources, private bridge: () => CollaborationResultsBridge | undefined,
    private history: 'session' | 'workspace' = 'session', private readOriginal?: ReadOriginal, private timeline = false) {
    const changed = () => { if (this.bind() && this.observers.size) void this.refresh() }
    this.unsubscribe = [workspaces.subscribe(changed), connection.subscribe(changed)]
    this.bind()
  }
  private bind(): boolean {
    const data = this.workspaces.getSnapshot(), host = this.bridge(), connection = this.connection.getSnapshot()
    const workspace = host?.collaborationScopeAvailable && host.collaborationDeliveries && connection !== undefined
      && data.phase === 'ready' && data.state !== 'error' && !data.archivedSessionIds.includes(this.sessionId)
      ? data.items.find(item => item.sessionIds.includes(this.sessionId)) : undefined
    const workspaceId = workspace?.workspaceId
    const members = workspace === undefined ? [] : this.history === 'workspace'
      ? workspace.sessionIds.filter(id => !data.archivedSessionIds.includes(id))
      : [this.sessionId]
    const sessionIds = [...new Set(members)].sort((a, b) => a === this.sessionId ? -1 : b === this.sessionId ? 1 : a.localeCompare(b))
    if (workspaceId === this.workspaceId && host === this.boundBridge && connection === this.connectionGeneration
      && sessionIds.length === this.sessionIds.length && sessionIds.every((id, i) => id === this.sessionIds[i])) return false
    this.sessionIds = sessionIds; this.sourceCursors.clear()
    this.locatedOriginal = undefined; this.location = undefined
    this.workspaceId = workspaceId; this.boundBridge = host; this.connectionGeneration = connection
    this.executions.clear()
    this.generation++; this.sourcePages = 1; this.replyPages.clear(); this.controller?.abort(); this.publish(empty())
    return true
  }
  private current(generation: number): boolean { this.bind(); return !this.closed && generation === this.generation }
  private readCurrent(generation: number, controller: AbortController): boolean {
    return this.current(generation) && this.controller === controller
  }
  private publish(state: CollaborationResultsSnapshot): void {
    const { executionAvailable: _available, focus: _focus, location: _location, ...base } = state
    this.state = { ...base,
      ...(this.history === 'workspace' ? { workspaceHistory: true as const } : {}),
      ...(this.readOriginal ? { locatorAvailable: true as const } : {}),
      ...(this.locatedOriginal ? { focus: { snapshotDigest: this.locatedOriginal.snapshot_digest, sequence: this.focusSequence } } : {}),
      ...(this.location ? { location: this.location } : {}),
      ...(this.boundBridge?.collaborationPlanningAvailable && this.boundBridge.collaborationRootExecution
        ? { executionAvailable: true } : {}),
      groups: state.groups.map((group) => {
        const execution = this.executions.get(group.original.snapshot_digest)
        if (group.execution === execution) return group
        const { execution: _old, ...original } = group
        return { ...original, ...(execution ? { execution } : {}) }
      }) }
    if (!this.closed) this.observers.forEach((fn) => { fn() })
  }
  /**
   * Read the current view without starting a transport request.
   * @returns the same view snapshot until new data is published.
   */
  getSnapshot = (): CollaborationResultsSnapshot => this.state
  /**
   * Observe this Session's results; the first view starts automatic readonly refresh.
   * @param fn - Framework observer.
   * @returns Removal that stops view timers and pending reads when no view remains.
   */
  subscribe = (fn: () => void): (() => void) => {
    if (this.closed) return () => {}
    this.observers.add(fn)
    if (this.observers.size === 1) {
      if (typeof window !== 'undefined') window.addEventListener('dsh-slark-collaboration-admitted', this.refreshEvent)
      this.timer = setInterval(() => { if (!this.pending) void this.refresh() }, 3_000)
      void this.refresh()
    }
    return () => {
      this.observers.delete(fn)
      if (!this.observers.size) this.stop()
    }
  }
  private stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (typeof window !== 'undefined') window.removeEventListener('dsh-slark-collaboration-admitted', this.refreshEvent)
    this.controller?.abort(); this.generation++; this.executions.clear()
    if (this.location?.status === 'loading') this.location = undefined
    this.publish(this.state)
  }
  private sourcePage(value: SessionCollaborationSourcesValue, cursor?: string,
    sessionId = this.sessionId): SessionCollaborationSourcesValue {
    if (!array(value.items) || value.items.length > 8 || bytes(value) > 256 * 1024
      || (value.next_cursor !== undefined && (value.items.length === 0 || value.next_cursor !== value.items.at(-1)?.snapshot_digest || value.next_cursor === cursor))) throw Error('invalid_source_page')
    const seen = new Set<string>()
    for (const item of value.items) {
      if (item.source.session_id !== sessionId || item.source.workspace_id !== this.workspaceId
        || !/^[a-f0-9]{64}$/u.test(item.snapshot_digest) || seen.has(item.snapshot_digest)
        || !safeText(item.original_message, 32 * 1024)
        || (Object.hasOwn(item, 'timeline_position') ? !validPosition(item.timeline_position) : this.timeline)) throw Error('invalid_source_page')
      seen.add(item.snapshot_digest)
    }
    return value
  }
  private async sourceRead(cursor: string | undefined, signal: AbortSignal, generation: number,
    cursors: Map<string, SourceCursor>): Promise<SessionCollaborationSourcesValue> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    signal.throwIfAborted()
    if (this.history === 'session') {
      const read = await wait(this.readSources(cursor, signal, this.sessionId), signal)
      if (!this.current(generation)) throw Error('obsolete')
      if (!read.ok) throw Error('source_unavailable')
      return this.sourcePage(read.value, cursor)
    }
    const start: SourceCursor = cursor === undefined ? { sessionId: this.sessionId } : cursors.get(cursor) as SourceCursor
    let nativeCursor = start.nativeCursor
    const remaining = this.sessionIds.slice(this.sessionIds.indexOf(start.sessionId))
    for (const [i, sessionId] of remaining.entries()) {
      signal.throwIfAborted()
      const read = await wait(this.readSources(nativeCursor, signal, sessionId), signal)
      if (!this.current(generation)) throw Error('obsolete')
      if (!read.ok) throw Error('source_unavailable')
      const page = this.sourcePage(read.value, nativeCursor, sessionId)
      const nextSessionId = remaining[i + 1]
      const following = page.next_cursor ? { sessionId, nativeCursor: page.next_cursor }
        : nextSessionId ? { sessionId: nextSessionId } : undefined
      if (page.items.length) {
        const last = (page.items.at(-1) as SessionCollaborationSourceItem).snapshot_digest
        if (following) cursors.set(last, following)
        return { items: page.items, ...(following ? { next_cursor: last } : {}) }
      }
      nativeCursor = undefined
    }
    return { items: [] }
  }
  private async lookupOriginal(original: SessionCollaborationSourceItem, signal: AbortSignal): Promise<SessionCollaborationSourceItem> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    signal.throwIfAborted()
    const read = await wait((this.readOriginal as ReadOriginal)(original, signal), signal)
    signal.throwIfAborted()
    if (!read.ok || read.value.items.length !== 1 || read.value.next_cursor !== undefined) throw Error('source_unavailable')
    const page = this.sourcePage(read.value, undefined, SessionId(original.source.session_id))
    const item = page.items[0] as SessionCollaborationSourceItem
    if (!sameSource(item.source, original.source) || item.snapshot_digest !== original.snapshot_digest
      || item.original_message !== original.original_message || !samePosition(item, original)) throw Error('source_substituted')
    return item
  }
  /**
   * Revalidate one displayed original before the owning plugin navigates to it.
   * @param digest - Existing displayed Source snapshot digest.
   * @param open - Synchronous navigation callback invoked only while the original ownership remains current.
   * @returns Completion of the readonly lookup; failure is displayed without opening a substituted Session.
   */
  async locateOriginal(digest: string, open: (original: SessionCollaborationSourceItem) => void): Promise<void> {
    this.bind()
    const original = this.state.groups.find(group => group.original.snapshot_digest === digest)?.original
    if (this.closed || this.pending || !this.workspaceId || !this.readOriginal || !original) return
    this.pending = true; this.again = false
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    this.location = { snapshotDigest: digest, status: 'loading' }
    this.publish({ ...this.state, phase: 'loading' })
    try {
      const item = await this.lookupOriginal(original, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      if (!this.readCurrent(generation, controller)) return
      open(item)
      if (!this.current(generation)) return
      this.location = { snapshotDigest: digest, status: 'opened' }
    } catch {
      if (!this.readCurrent(generation, controller)) return
      this.location = { snapshotDigest: digest, status: 'unavailable' }
    } finally {
      if (this.readCurrent(generation, controller)) this.publish({ ...this.state, phase: 'ready' })
      this.finishQuery()
    }
  }
  /**
   * Reveal a just-verified original in its owning Session, retaining it beyond the newest history page.
   * @param original - Immutable Source supplied by the current locator's synchronous navigation callback.
   * @returns false when the owning Session, workspace or reader is unavailable; accepted work is never cancelled.
   */
  revealOriginal(original: SessionCollaborationSourceItem): boolean {
    this.bind()
    if (this.closed || !this.readOriginal || !this.workspaceId || original.source.workspace_id !== this.workspaceId
      || original.source.session_id !== this.sessionId) return false
    this.controller?.abort(); this.controller = undefined
    this.locatedOriginal = original; this.focusSequence++
    this.location = { snapshotDigest: original.snapshot_digest, status: 'opened' }
    this.sourcePages = 1; this.replyPages.clear(); this.sourceCursors.clear()
    this.publish({ phase: 'ready', groups: [{ original, replies: [], phase: 'loading' }] })
    if (this.pending) this.again = true
    return true
  }
  /** The caller binds an available reader and verifies the owning generation before each page. */
  private async results(original: SessionCollaborationSourceItem, signal: AbortSignal, generation: number,
    cursor?: string, prior: readonly ScopedCollaborationReply[] = [],
    previous: readonly ScopedCollaborationReply[] = []): Promise<CollaborationResultGroup> {
    // Main gives delivery and planning their own thirty-second authenticated reads.
    signal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    try {
      signal.throwIfAborted()
      const host = this.boundBridge as ReadableResultsBridge
      const result = await wait(host.collaborationDeliveries({ source: original.source, limit: 50,
        ...(cursor ? { after_delivery_id: cursor } : {}) }), signal)
      if (!this.current(generation)) throw Error('obsolete')
      if (!result.ok || !Array.isArray(result.value.deliveries) || result.value.deliveries.length > 50 || bytes(result.value) > 800 * 1024) throw Error('unavailable')
      const page = result.value, seen = new Set(prior.map(item => item.delivery_id))
      for (const item of page.deliveries) {
        if (!sameSource(item.source_locator, original.source) || item.source_snapshot_digest !== original.snapshot_digest
          || typeof item.delivery_id !== 'string' || seen.has(item.delivery_id)
          || (item.answer !== undefined && !safeText(item.answer, 128 * 1024))
          || (item.delivery_state === 'restricted' && (item.answer !== undefined || item.target_display_snapshot !== undefined))) throw Error('invalid_result_page')
        seen.add(item.delivery_id)
      }
      if (page.next_cursor !== undefined && (page.deliveries.length === 0 || page.next_cursor !== page.deliveries.at(-1)?.delivery_id || page.next_cursor === cursor)) throw Error('invalid_result_cursor')
      const replies = [...prior, ...page.deliveries.map((item) => {
        const old = previous.find(value => value.delivery_id === item.delivery_id)
        // Current restricted projections always remove private fields, even at the same outbox version.
        if (!old || item.delivery_state === 'restricted') return item
        if (BigInt(item.delivery_state_version) < BigInt(old.delivery_state_version)) return { ...item,
          delivery_state: old.delivery_state, delivery_state_version: old.delivery_state_version }
        return item
      })]
      if (replies.length > 4096 || bytes(replies) > 16 * 1024 * 1024) throw Error('result_view_budget')
      let pending: CollaborationPendingPage['pending_items'] | undefined, pendingUnavailable = false
      let planningState: string | undefined
      if (host.collaborationPending) {
        try {
          const currentPlan = await readCollaborationPending(host, original.source, signal)
          pending = currentPlan.pending_items
          planningState = currentPlan.plan?.planning_state
        }
        catch { pendingUnavailable = true }
        if (!this.current(generation)) throw Error('obsolete')
      }
      return { original, replies, phase: 'ready', ...(pending === undefined ? {} : { pending }),
        ...(planningState === undefined ? {} : { planningState }),
        ...(pendingUnavailable ? { pendingUnavailable: true } : {}), ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}) }
    } catch { return { original, replies: [], phase: 'error' } }
  }
  private async query(more: boolean): Promise<void> {
    this.bind()
    if (this.closed || !this.workspaceId) return
    if (this.pending) { if (!more) this.again = true; return }
    const cursor = more ? this.state.nextCursor : undefined
    if (more && cursor === undefined) return
    this.pending = true; this.again = false
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    // Budget eight originals per Native page, two workers, retained reply pages and a located original.
    const extraReplyPages = [...this.replyPages.values()].reduce((sum, pages) => sum + pages - 1, 0)
    const queryBudget = 30_000 * (this.sourcePages + 1) + 60_000 * (4 * this.sourcePages + extraReplyPages + 1)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(queryBudget)])
    this.publish({ ...this.state, phase: 'loading' })
    try {
      const oldGroups = this.state.groups
      const prior = more ? this.state.groups : []
      const known = new Set(prior.map(item => item.original.snapshot_digest))
      const groups: CollaborationResultGroup[] = [...prior]
      const cursors = more ? new Map(this.sourceCursors) : new Map<string, SourceCursor>()
      let nextCursor = cursor, pages = 0
      do {
        const page = await this.sourceRead(nextCursor, signal, generation, cursors)
        if (!this.readCurrent(generation, controller)) return
        const items = page.items.filter((item) => {
          const located = this.locatedOriginal
          if (located?.snapshot_digest === item.snapshot_digest && (!sameSource(located.source, item.source)
            || located.original_message !== item.original_message || !samePosition(located, item))) throw Error('source_substituted')
          const previous = oldGroups.find(group => group.original.snapshot_digest === item.snapshot_digest)?.original
          if (previous && (!sameSource(previous.source, item.source) || previous.original_message !== item.original_message
            || !samePosition(previous, item))) throw Error('source_substituted')
          if (!known.has(item.snapshot_digest)) return true
          if (located?.snapshot_digest === item.snapshot_digest) return false
          throw Error('invalid_source_cursor')
        })
        if (groups.length + items.length > 128) throw Error('invalid_source_cursor')
        items.forEach((original) => { known.add(original.snapshot_digest) })
        const pageGroups: CollaborationResultGroup[] = Array(items.length)
        const originals = items.entries()
        const readGroups = async (): Promise<void> => {
          for (const [index, original] of originals) {
            signal.throwIfAborted()
            const previous = oldGroups.find(item => item.original.snapshot_digest === original.snapshot_digest)?.replies ?? []
            let group = await this.results(original, signal, generation, undefined, [], previous)
            for (let i = 1; i < (this.replyPages.get(original.snapshot_digest) ?? 1) && group.nextCursor; i++) {
              group = await this.results(original, signal, generation, group.nextCursor, group.replies, previous)
            }
            pageGroups[index] = group
            if (!this.readCurrent(generation, controller)) return
          }
        }
        await Promise.all(Array.from({ length: Math.min(2, items.length) }, readGroups))
        if (!this.readCurrent(generation, controller)) return
        groups.push(...pageGroups)
        nextCursor = page.next_cursor; pages++
      } while (!more && nextCursor !== undefined && pages < this.sourcePages)
      const located = this.locatedOriginal
      if (located && !known.has(located.snapshot_digest)) {
        let original: SessionCollaborationSourceItem | undefined
        try { original = await this.lookupOriginal(located, signal) }
        catch {
          if (!this.readCurrent(generation, controller)) return
          this.locatedOriginal = undefined; this.location = { snapshotDigest: located.snapshot_digest, status: 'unavailable' }
        }
        if (!this.readCurrent(generation, controller)) return
        if (original) {
          groups.unshift(await this.results(original, signal, generation))
          if (!this.readCurrent(generation, controller)) return
        }
      }
      if (groups.length > 128) throw Error('result_view_budget')
      const orders = groups.flatMap(group => group.original.timeline_position ? [group.original.timeline_position.local_order] : [])
      if (new Set(orders).size !== orders.length) throw Error('invalid_source_page')
      if (bytes(groups) > 16 * 1024 * 1024) throw Error('result_view_budget')
      if (more) this.sourcePages++
      this.sourceCursors = cursors
      this.publish({ phase: 'ready', groups, ...(nextCursor ? { nextCursor } : {}) })
    } catch {
      if (this.readCurrent(generation, controller)) this.publish({ phase: 'error', groups: [] })
    } finally {
      this.finishQuery()
    }
  }
  private finishQuery(): void {
    this.pending = false
    this.controller = undefined
    if (this.again && !this.closed) { this.again = false; void this.refresh() }
  }
  /**
   * Refresh the original messages and all user-loaded result pages.
   * @returns completion of the readonly query; no submission or acknowledgment.
   */
  async refresh(): Promise<void> { await this.query(false) }
  /**
   * Extend the view with the next older Source page.
   * @returns completion of the readonly page without submitting any work.
   */
  async loadSources(): Promise<void> { await this.query(true) }
  /**
   * Read the next complete result page for one original message.
   * @param snapshotDigest - Existing original group selected by the view.
   * @returns completion of its bounded readonly page, or no operation when unavailable; paging stays disabled while reading.
   */
  async loadReplies(snapshotDigest: string): Promise<void> {
    this.bind()
    const group = this.state.groups.find(item => item.original.snapshot_digest === snapshotDigest)
    if (this.closed || this.pending || !group?.nextCursor || !this.workspaceId) return
    this.pending = true
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    this.publish({ ...this.state, phase: 'loading' })
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
      let next = await this.results(group.original, signal, generation, group.nextCursor, group.replies)
      if (this.readCurrent(generation, controller)) {
        if (bytes(this.state.groups.map(item =>
          item.original.snapshot_digest === group.original.snapshot_digest ? next : item)) > 16 * 1024 * 1024) {
          next = { original: group.original, replies: [], phase: 'error' }
        }
        if (next.phase === 'ready') this.replyPages.set(snapshotDigest, (this.replyPages.get(snapshotDigest) ?? 1) + 1)
        this.publish({ ...this.state, phase: 'ready', groups: this.state.groups.map(item =>
          item.original.snapshot_digest === group.original.snapshot_digest ? next : item) })
      }
    } finally {
      this.finishQuery()
    }
  }
  /**
   * Preview work or explicitly confirm one Main-retained task; refresh and recovery never admit new work.
   * @param digest - Existing original Source group.
   * @param taskId - Concrete displayed task, omitted for a readonly preview.
   * @param reconcile - Read the durable confirmation without admitting work.
   * @returns Completion of the command; obsolete connection results are discarded.
   */
  async executionAction(digest: string, taskId?: string, reconcile = false): Promise<void> {
    this.bind()
    const original = this.state.groups.find(group => group.original.snapshot_digest === digest)?.original
    const bridge = this.boundBridge, previous = this.executions.get(digest)
    if (this.closed || !this.workspaceId || !original || !bridge?.collaborationPlanningAvailable || !bridge.collaborationRootExecution
      || previous?.phase === 'loading' || Object.values(previous?.outcomes ?? {}).includes('sending')) return
    let request: Parameters<NonNullable<CollaborationResultsBridge['collaborationRootExecution']>>[0]
    if (taskId === undefined) request = { action: 'preview', source: original.source }
    else {
      if (!previous?.previewId || !previous.tasks?.some(task => task.taskId === taskId) || (!reconcile && !previous.enabled)) return
      request = { action: reconcile ? 'reconcile' : 'confirm', previewId: previous.previewId, taskId }
    }
    const prior: CollaborationExecutionView = previous ?? { phase: 'ready' }
    const generation = this.generation
    this.executions.set(digest, taskId === undefined ? { phase: 'loading' }
      : { ...prior, outcomes: { ...prior.outcomes, [taskId]: 'sending' } })
    this.publish(this.state)
    try {
      const result = await wait(bridge.collaborationRootExecution(request), AbortSignal.timeout(35_000))
      if (!this.current(generation)) return
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw Error('unavailable')
      if (taskId === undefined) {
        if (!('rootTraceId' in result) || typeof result.rootTraceId !== 'string' || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(result.rootTraceId)
          || !('previewId' in result) || !safeText(result.previewId, 128) || !result.previewId
          || !('executionEnabled' in result) || typeof result.executionEnabled !== 'boolean'
          || !('tasks' in result) || !Array.isArray(result.tasks) || !result.tasks.length || result.tasks.length > 10
          || bytes(result) > 800 * 1024) throw Error('invalid_preview')
        const seen = new Set<string>()
        const tasks = result.tasks.map((value: unknown) => {
          if (!value || typeof value !== 'object') throw Error('invalid_task')
          const row = value as Record<string, unknown>
          if (!safeText(row.taskId, 256) || !row.taskId || seen.has(row.taskId) || !safeText(row.question, 32 * 1024)
            || !safeText(row.agentName, 512) || !safeText(row.projectName, 512)) throw Error('invalid_task')
          seen.add(row.taskId)
          return { taskId: row.taskId, question: row.question, agentName: row.agentName, projectName: row.projectName }
        })
        this.executions.set(digest, { phase: 'ready', previewId: result.previewId, rootTraceId: result.rootTraceId, enabled: result.executionEnabled, tasks })
      } else {
        if (!('status' in result) || (result.status !== 'recorded' && result.status !== 'not_admitted')) throw Error('invalid_outcome')
        this.executions.set(digest, { ...prior, outcomes: { ...prior.outcomes, [taskId]: result.status } })
      }
    } catch {
      if (!this.current(generation)) return
      this.executions.set(digest, taskId === undefined ? { phase: 'error' }
        : { ...prior, outcomes: { ...prior.outcomes, [taskId]: 'uncertain' } })
    }
    this.publish(this.state)
  }
  /** Consume one displayed reply under Main's retained original task; reconciliation never requests a fresh grant.
   * @param digest - Original message digest displayed in this Session.
   * @param deliveryId - Immutable result identity, resolved to its task from the current readable projection.
   * @param reconcile - Read historical evidence only after an uncertain outcome.
   */
  async consumptionAction(digest: string, deliveryId: string, reconcile = false): Promise<void> {
    this.bind()
    const group = this.state.groups.find(g => g.original.snapshot_digest === digest), prior = this.executions.get(digest)
    const reply = group?.replies.find(r => r.delivery_id === deliveryId), bridge = this.boundBridge
    if (this.closed || !this.workspaceId || !bridge?.collaborationRootExecution || !bridge.collaborationPlanningAvailable
      || !prior?.previewId || !reply?.task_id || reply.delivery_state === 'restricted'
      || !prior.tasks?.some(t => t.taskId === reply.task_id) || Object.values(prior.consumptions ?? {}).includes('sending')
      || (!reconcile && (!prior.enabled || prior.consumptions?.[deliveryId] !== undefined))) return
    const generation = this.generation
    this.executions.set(digest, { ...prior, consumptions: { ...prior.consumptions, [deliveryId]: 'sending' } })
    this.publish(this.state)
    try {
      const value = await wait(bridge.collaborationRootExecution({ action:reconcile?'consumption-status':'consume',
        previewId:prior.previewId,taskId:reply.task_id,deliveryId }),AbortSignal.timeout(35000))
      if (!this.current(generation)) return
      if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('rootTraceId' in value)
        || value.rootTraceId !== prior.rootTraceId || !('consumptionAcknowledged' in value) || value.consumptionAcknowledged !== true
        || !('status' in value) || value.status !== 'context_applied' || !('continuationObserved' in value) || typeof value.continuationObserved !== 'boolean') throw Error('unavailable')
      this.executions.set(digest, { ...prior, consumptions: { ...prior.consumptions, [deliveryId]: value.continuationObserved?'continued':'context_applied' } })
    } catch {
      if (!this.current(generation)) return
      this.executions.set(digest, { ...prior, consumptions: { ...prior.consumptions, [deliveryId]: 'uncertain' } })
    }
    this.publish(this.state)
  }
  /** Release observers and readonly requests; accepted tasks continue independently. */
  dispose(): void {
    this.stop(); this.closed = true; this.unsubscribe.forEach((fn) => { fn() }); this.observers.clear(); this.state = empty()
  }
}
