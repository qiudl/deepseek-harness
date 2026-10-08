import { readCollaborationExecutionEvidence, readCollaborationTracePage, type CollaborationTraceView, type CollaborationTracePage } from './collaboration-trace.ts'
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
  collaborationRootExecution?(request: { action: 'trace'; source: Source; cursor: { after_seq: number; limit: number; evidence?: { event_id: string; after_sequence: number } } } | { action: 'preview'; source: Source } |
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
  readonly trace?: CollaborationTraceView
  readonly execution?: CollaborationExecutionView
  readonly nextCursor?: string
}
/** Stable observable value consumed by the injected framework hook. */
export interface CollaborationResultsSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly executionAvailable?: boolean
  readonly groups: readonly CollaborationResultGroup[]
  readonly nextCursor?: string
}
type Generation = { getSnapshot(): unknown; subscribe(fn: () => void): () => void }
type ReadableResultsBridge = CollaborationResultsBridge & Required<Pick<CollaborationResultsBridge, 'collaborationDeliveries'>>
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
  private traces = new Map<string, CollaborationTraceView>()
  private tracePages = new Map<string, number>()
  private executions = new Map<string, CollaborationExecutionView>()
  private observers = new Set<() => void>()
  private generation = 0
  private workspaceId: string | undefined
  private connectionGeneration: unknown
  private boundBridge: CollaborationResultsBridge | undefined
  private controller: AbortController | undefined
  private pending = false
  private readonly traceQueries = new Set<string>()
  private readonly readWaiters: (() => boolean)[] = []
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
    private readSources: ReadSources, private bridge: () => CollaborationResultsBridge | undefined,
    private readonly activity: (active: boolean) => void = () => {}) {
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
    this.executions.clear(); this.traces.clear(); this.tracePages.clear()
    this.generation++; this.sourcePages = 1; this.replyPages.clear(); this.controller?.abort(); this.publish(empty())
    return true
  }
  private current(generation: number): boolean { this.bind(); return !this.closed && generation === this.generation }
  private publish(state: CollaborationResultsSnapshot): void {
    const { executionAvailable: _available, ...base } = state
    this.state = { ...base,
      ...(this.boundBridge?.collaborationPlanningAvailable && this.boundBridge.collaborationRootExecution
        ? { executionAvailable: true } : {}),
      groups: state.groups.map((group) => {
        const execution = this.executions.get(group.original.snapshot_digest)
        const trace = this.traces.get(group.original.snapshot_digest)
        if (group.execution === execution && group.trace === trace) return group
        const { execution: _old, trace: _trace, ...original } = group
        return { ...original, ...(execution ? { execution } : {}), ...(trace ? { trace } : {}) }
      }) }
    this.activity(!this.closed && this.state.groups.length > 0)
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
    this.traces.clear(); this.tracePages.clear(); this.publish(this.state)
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
  /** The caller binds an available reader and verifies the owning generation before each page. */
  private async results(original: SessionCollaborationSourceItem, signal: AbortSignal, generation: number,
    cursor?: string, prior: readonly ScopedCollaborationReply[] = [],
    previous: readonly ScopedCollaborationReply[] = []): Promise<CollaborationResultGroup> {
    try {
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
          const tracePages = this.tracePages.get(original.snapshot_digest)
          if (tracePages !== undefined) await this.traceRead(original, signal, generation, tracePages)
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
      this.finishQuery()
    }
  }
  private finishQuery(): void {
    this.pending = false
    this.controller = undefined
    while (this.readWaiters.length) { if (this.readWaiters.shift()?.()) return }
    if (this.again && !this.closed) { this.again = false; void this.refresh() }
  }
  private acquireTraceQuery(generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      const acquire = () => {
        if (!this.current(generation)) { resolve(false); return false }
        this.pending = true
        resolve(true)
        return true
      }
      if (this.pending) this.readWaiters.push(acquire)
      else acquire()
    })
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
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
      let next = await this.results(group.original, signal, generation, group.nextCursor, group.replies)
      if (this.current(generation)) {
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
  private retainTrace(digest: string, trace: CollaborationTraceView): void {
    let size = bytes(trace)
    for (const [key, value] of this.traces) {
      if (key !== digest) size += bytes(value)
    }
    if (size > 16 * 1024 * 1024) throw Error('trace_budget')
    this.traces.set(digest, trace)
  }
  private async traceRead(
    original: SessionCollaborationSourceItem, signal: AbortSignal, generation: number, loadedPages: number, append?: CollaborationTracePage,
  ): Promise<void> {
    const digest = original.snapshot_digest, old = this.traces.get(digest)?.page
    const bridge = this.boundBridge
    try {
      if (!bridge?.collaborationRootExecution || !bridge.collaborationPlanningAvailable) throw Error('unavailable')
      let after = append?.next_after_seq ?? 0
      let page = append
      const pages = append ? 1 : loadedPages
      let n = 0
      do {
        const response = await wait(bridge.collaborationRootExecution({ action: 'trace', source: original.source,
          cursor: { after_seq: after, limit: 20 } }), signal)
        if (!this.current(generation)) return
        const next = readCollaborationTracePage(response, after, page ?? old)
        const events = [...(page?.events ?? []), ...next.events]
        if (events.length > 4096 || new Set(events.map(e => e.event_id)).size !== events.length
          || bytes(events) > 4 * 1024 * 1024) throw Error('trace_budget')
        page = { ...next, events }
        if (next.next_after_seq === null) break
        after = next.next_after_seq
        n++
      } while (n < pages)
      this.retainTrace(digest, { ...this.traces.get(digest), phase: 'ready', page })
      if (append) this.tracePages.set(digest, loadedPages + 1)
    } catch {
      if (this.current(generation)) this.traces.set(digest, { phase: 'error' })
    }
  }
  /** Read or page cloud audits for one original Source; queued reads precede automatic refresh.
   * No preview, admission or consumption; obsolete queued reads are discarded.
   * @param digest - Original message selected in this Session.
   * @param more - Append the next immutable audit page instead of refreshing loaded pages.
   * @returns Completion of the bounded read, discarding obsolete generations.
   */
  async traceAction(digest: string, more = false): Promise<void> {
    this.bind()
    const original = this.state.groups.find(group => group.original.snapshot_digest === digest)?.original
    if (this.closed || this.traceQueries.has(digest) || !this.workspaceId || !original) return
    const old = this.traces.get(digest)
    if (more && old?.page?.next_after_seq == null) return
    const generation = this.generation
    this.traceQueries.add(digest)
    this.traces.set(digest, { ...old, phase: 'loading' }); this.publish(this.state)
    const acquired = await this.acquireTraceQuery(generation)
    try {
      if (!acquired || !this.current(generation)) return
      const controller = new AbortController()
      this.controller = controller
      const pages = this.tracePages.get(digest) ?? 1
      this.tracePages.set(digest, pages)
      await this.traceRead(original, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        generation, pages, more ? old?.page : undefined)
      if (this.current(generation)) this.publish(this.state)
    } finally { this.traceQueries.delete(digest); if (acquired) this.finishQuery() }
  }
  /** Read immutable runtime observations for a displayed settlement; browsing cannot launch tools.
   * @param digest - Original Source message digest.
   * @param eventId - Settlement event already present in this root's audit history.
   * @param more - Append the next runtime observation page.
   * @returns Completion of the current authorized read.
   */
  async traceEvidenceAction(digest: string, eventId: string, more = false): Promise<void> {
    this.bind()
    const group = this.state.groups.find(g => g.original.snapshot_digest === digest), prior = this.traces.get(digest)
    const bridge = this.boundBridge
    if (this.closed || this.traceQueries.has(digest) || !this.workspaceId
      || !bridge?.collaborationRootExecution || !bridge.collaborationPlanningAvailable
      || !group || !prior?.page?.events.some(e => e.event_id === eventId)) return
    const previous = prior.execution?.eventId === eventId ? prior.execution.page : undefined
    const after = more ? previous?.next_after_sequence : 0
    if (after === undefined || after === null) return
    const generation = this.generation
    this.traceQueries.add(digest)
    this.traces.set(digest, { ...prior, execution: { eventId, phase: 'loading', ...(previous ? { page: previous } : {}) } })
    this.publish(this.state)
    const acquired = await this.acquireTraceQuery(generation)
    try {
      if (!acquired || !this.current(generation)) return
      const controller = new AbortController()
      this.controller = controller
      const value = await wait(bridge.collaborationRootExecution({ action: 'trace', source: group.original.source,
        cursor: { after_seq: 0, limit: 20, evidence: { event_id: eventId, after_sequence: after } } }),
      AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]))
      if (!this.current(generation)) return
      readCollaborationTracePage(value, 0, prior.page)
      const next = readCollaborationExecutionEvidence(value, eventId, after, previous)
      const events = [...(more && previous ? previous.events : []), ...next.events]
      if (events.length > 2048) throw Error('evidence_budget')
      this.retainTrace(digest, { ...prior, execution: { eventId, phase: 'ready', page: { ...next, events } } })
    } catch {
      if (!this.current(generation)) return
      // An unavailable read may mean authority was revoked; drop all cloud data for this Source.
      this.traces.set(digest, { phase: 'error' })
    } finally {
      if (this.current(generation)) this.publish(this.state)
      this.traceQueries.delete(digest)
      if (acquired) this.finishQuery()
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
    this.stop(); this.closed = true; this.unsubscribe.forEach((fn) => { fn() }); this.observers.clear()
    this.state = empty(); this.activity(false)
  }
}
