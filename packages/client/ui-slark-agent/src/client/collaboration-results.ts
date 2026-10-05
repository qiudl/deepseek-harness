/** Session-owned readonly collaboration messages/results; view lifetimes never cancel accepted work. */
import { readCollaborationPending } from './collaboration-dialogue.ts'
import type { CollaborationDialogueBridge, CollaborationPendingPage } from './collaboration-dialogue.ts'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionCollaborationSourceItem, SessionCollaborationSourcesValue } from '@deepseek-ai/dsh-api-session-controller/types'

type Source = SessionCollaborationSourceItem['source']
/** Main's readable result projection; transport delivery and execution have separate states. */
export interface ScopedCollaborationReply {
  readonly delivery_id: string
  readonly invocation_id: string
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
  collaborationDeliveries?(request: { source: Source; limit: number; after_delivery_id?: string }): Promise<
    { ok: true; value: { deliveries: readonly ScopedCollaborationReply[]; next_cursor?: string } } | { ok: false; errorCode: string }>
}
/** One original message and the readable results obtained for that exact snapshot. */
export interface CollaborationResultGroup {
  readonly original: SessionCollaborationSourceItem
  readonly replies: readonly ScopedCollaborationReply[]
  readonly phase: 'ready' | 'loading' | 'error'
  readonly pending?: CollaborationPendingPage['pending_items']
  readonly pendingUnavailable?: boolean
  readonly nextCursor?: string
}
/** Stable observable value consumed by the injected framework hook. */
export interface CollaborationResultsSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly groups: readonly CollaborationResultGroup[]
  readonly nextCursor?: string
}
type Generation = { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
type ReadSources = (cursor: string | undefined, signal: AbortSignal) => Promise<
  { ok: true; value: SessionCollaborationSourcesValue } | { ok: false }>
const empty = (): CollaborationResultsSnapshot => ({ phase: 'idle', groups: [] })
const sameSource = (a: Source, b: Source): boolean => a.workspace_id === b.workspace_id && a.session_id === b.session_id
  && a.source_message_id === b.source_message_id && a.source_revision === b.source_revision
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
const array = (value: unknown): boolean => Array.isArray(value)
const safeText = (value: unknown, max: number): value is string => typeof value === 'string'
  && !/\p{Surrogate}/u.test(value) && new TextEncoder().encode(value).length <= max
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
  private observers = new Set<() => void>()
  private generation = 0
  private workspaceId: string | undefined
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
    if ((event as CustomEvent<Source | undefined>).detail?.session_id === this.sessionId) void this.refresh()
  }

  constructor(private sessionId: SessionId, private workspaces: WorkspaceSource, private connection: Generation,
    private readSources: ReadSources, private bridge: () => CollaborationResultsBridge | undefined) {
    const changed = () => { if (this.bind() && this.observers.size) void this.refresh() }
    this.unsubscribe = [workspaces.subscribe(changed), connection.subscribe(changed)]
    this.bind()
  }
  private bind(): boolean {
    const data = this.workspaces.getSnapshot(), host = this.bridge(), connection = this.connection.getSnapshot()
    const workspaceId = host?.collaborationScopeAvailable && host.collaborationDeliveries && connection !== undefined
      && data.phase === 'ready' && data.state !== 'error' && !data.archivedSessionIds.includes(this.sessionId)
      ? data.items.find(item => item.sessionIds.includes(this.sessionId))?.workspaceId : undefined
    if (workspaceId === this.workspaceId && host === this.boundBridge && connection === this.connectionGeneration) return false
    this.workspaceId = workspaceId; this.boundBridge = host; this.connectionGeneration = connection
    this.generation++; this.sourcePages = 1; this.replyPages.clear(); this.controller?.abort(); this.publish(empty())
    return true
  }
  private current(generation: number): boolean { this.bind(); return !this.closed && generation === this.generation }
  private publish(state: CollaborationResultsSnapshot): void {
    this.state = state
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
    this.controller?.abort(); this.generation++
  }
  private sourcePage(value: SessionCollaborationSourcesValue, cursor?: string): SessionCollaborationSourcesValue {
    if (!array(value.items) || value.items.length > 8 || bytes(value) > 256 * 1024
      || (value.next_cursor !== undefined && (value.items.length === 0 || value.next_cursor !== value.items.at(-1)?.snapshot_digest || value.next_cursor === cursor))) throw Error('invalid_source_page')
    const seen = new Set<string>()
    for (const item of value.items) {
      if (item.source.session_id !== this.sessionId || item.source.workspace_id !== this.workspaceId
        || !/^[a-f0-9]{64}$/u.test(item.snapshot_digest) || seen.has(item.snapshot_digest)
        || !safeText(item.original_message, 32 * 1024)) throw Error('invalid_source_page')
      seen.add(item.snapshot_digest)
    }
    return value
  }
  private async results(original: SessionCollaborationSourceItem, signal: AbortSignal, generation: number,
    cursor?: string, prior: readonly ScopedCollaborationReply[] = [],
    previous: readonly ScopedCollaborationReply[] = []): Promise<CollaborationResultGroup> {
    try {
      const host = this.boundBridge
      if (!host?.collaborationDeliveries) throw Error('unavailable')
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
      if (host.collaborationPending) {
        try { pending = (await readCollaborationPending(host, original.source, signal)).pending_items }
        catch { pendingUnavailable = true }
        if (!this.current(generation)) throw Error('obsolete')
      }
      return { original, replies, phase: 'ready', ...(pending === undefined ? {} : { pending }),
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    this.publish({ ...this.state, phase: 'loading' })
    try {
      const oldGroups = this.state.groups
      const prior = more ? this.state.groups : []
      const known = new Set(prior.map(item => item.original.snapshot_digest))
      const groups: CollaborationResultGroup[] = [...prior]
      let nextCursor = cursor, pages = 0
      do {
        const read = await wait(this.readSources(nextCursor, signal), signal)
        if (!this.current(generation)) return
        if (!read.ok) throw Error('source_unavailable')
        const page = this.sourcePage(read.value, nextCursor)
        if (page.items.some(item => known.has(item.snapshot_digest)) || groups.length + page.items.length > 128) throw Error('invalid_source_cursor')
        for (const original of page.items) {
          known.add(original.snapshot_digest)
          const previous = oldGroups.find(item => item.original.snapshot_digest === original.snapshot_digest)?.replies ?? []
          let group = await this.results(original, signal, generation, undefined, [], previous)
          for (let i = 1; i < (this.replyPages.get(original.snapshot_digest) ?? 1) && group.nextCursor; i++) {
            group = await this.results(original, signal, generation, group.nextCursor, group.replies, previous)
          }
          groups.push(group)
          if (!this.current(generation)) return
        }
        nextCursor = page.next_cursor; pages++
      } while (!more && nextCursor !== undefined && pages < this.sourcePages)
      if (bytes(groups) > 16 * 1024 * 1024) throw Error('result_view_budget')
      if (more) this.sourcePages++
      this.publish({ phase: 'ready', groups, ...(nextCursor ? { nextCursor } : {}) })
    } catch {
      if (this.current(generation)) this.publish({ phase: 'error', groups: [] })
    } finally {
      this.finishQuery(controller)
    }
  }
  private finishQuery(controller: AbortController): void {
    this.pending = false
    if (this.controller === controller) this.controller = undefined
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
   * @returns completion of its bounded readonly page, or no operation when unavailable.
   */
  async loadReplies(snapshotDigest: string): Promise<void> {
    this.bind()
    const group = this.state.groups.find(item => item.original.snapshot_digest === snapshotDigest)
    if (this.closed || this.pending || !group?.nextCursor || !this.workspaceId) return
    this.pending = true
    const generation = this.generation, controller = new AbortController()
    this.controller = controller
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      let next = await this.results(group.original, signal, generation, group.nextCursor, group.replies)
      if (this.current(generation)) {
        if (bytes(this.state.groups.map(item => item === group ? next : item)) > 16 * 1024 * 1024) {
          next = { original: group.original, replies: [], phase: 'error' }
        }
        if (next.phase === 'ready') this.replyPages.set(snapshotDigest, (this.replyPages.get(snapshotDigest) ?? 1) + 1)
        this.publish({ ...this.state, groups: this.state.groups.map(item => item === group ? next : item) })
      }
    } finally {
      this.finishQuery(controller)
    }
  }
  /** Release observers and readonly requests; accepted tasks continue independently. */
  dispose(): void {
    this.stop(); this.closed = true; this.unsubscribe.forEach((fn) => { fn() }); this.observers.clear(); this.state = empty()
  }
}
