/** Per-Session target-neutral Conversation assembly. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ISessions, SessionBinding, SessionEventSource, SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  ConversationPublication, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore,
} from '../contract/conversation.ts'
import type { ConversationSnapshot } from '../contract/snapshot.ts'
import type {
  ConversationPromptSnapshot, RequestPromptInspection, SystemPromptNode,
} from '../contract/request-inspection.ts'
import { inspectRequestPrompt } from '../contract/request-inspection.ts'
import { inspectSystemPrompt, type SystemPromptState } from '../contract/system-prompt.ts'
import { ConversationNodeAssembler } from './assembler.ts'
import { ConversationEventRegistry } from './event-registry.ts'
import { HistoricalImageCache } from './historical-images.ts'
import { ConversationViewRegistry } from './view-registry.ts'
import { ConversationGroupRegistry } from './group-registry.ts'

/** Observable faces published for one Session's Conversation assembly. */
export interface ConversationBinding {
  readonly snapshot: ObservableSnapshot<ConversationSnapshot>
  /**
   * Identity-stable source of the latest turn number, undefined unless its start is loaded and it remains open.
   * Turn changes publish synchronously, including without an active View.
   */
  readonly openTurn: ObservableSnapshot<number | undefined>
  /**
   * Add one selected target to the Session's monotonic active set.
   * @param target - registered or subsequently registered Conversation target.
   */
  activate(target: string): void
  /** Keep the shell visible for externally persisted activity without appending Session events.
   * @param target - Conversation view showing the activity.
   * @returns An idempotent release; independent owners retain independent activity.
   */
  retainActivity(target: string): () => void
  /**
   * Contribute display activity from an independent authorized history source.
   * The source is observed only while the Conversation snapshot has subscribers.
   * This neither appends Session events nor activates an execution or target builder.
   * @param target - Display activity identity owned by the contributing plugin.
   * @param source - Current readonly presence of displayable records.
   * @returns Idempotent removal; the Session binding also removes it on disposal.
   */
  registerActivity(target: string, source: ObservableSnapshot<boolean>): () => void
  /**
   * Resolve one target-owned snapshot source.
   * The first subscriber activates the target unless shell selection already
   * activated it; activation lasts for the remaining Session lifetime.
   * @param target - registered Conversation target.
   * @returns identity-stable source following the target.
   */
  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>
}

class BoundConversation implements ConversationBinding {
  readonly snapshot: ObservableSnapshot<ConversationSnapshot>
  private readonly published: SnapshotStore<ConversationSnapshot>
  readonly openTurn: SnapshotStore<number | undefined>
  private readonly activities = new Map<symbol, {
    target: string
    source: ObservableSnapshot<boolean>
    active: boolean
    stop?: () => void
  }>()
  private subscribers = 0
  private disposed = false
  private readonly viewStore: ConversationViewSnapshotStore
  private readonly targetSources = new Map<string, ObservableSnapshot<unknown>>()
  private readonly retainedActivity = new Map<symbol, string>()
  private revision = -1
  private frame: number | undefined
  private disposeFeed: () => void = () => {}

  constructor(
    feed: SessionEventSource,
    private readonly assembler: ConversationNodeAssembler,
  ) {
    this.viewStore = assembler
    this.published = createSnapshotStore(this.currentSnapshot())
    this.snapshot = {
      getSnapshot: () => this.published.getSnapshot(),
      subscribe: (listener) => {
        if (this.disposed) return () => {}
        const stop = this.published.subscribe(listener)
        this.subscribers++
        if (this.subscribers === 1) {
          for (const token of this.activities.keys()) this.observeActivity(token)
        }
        let subscribed = true
        return () => {
          if (!subscribed) return
          subscribed = false; stop(); this.subscribers--
          if (this.subscribers === 0) this.stopActivities()
        }
      },
    }
    this.openTurn = createSnapshotStore(assembler.openTurn())
    this.replace(feed.getSnapshot())
    this.disposeFeed = feed.subscribe(() => {
      this.accept(feed.getSnapshot())
    })
  }

  target<Target extends Extract<keyof ConversationViewSnapshotMap, string>>(
    target: Target,
  ): ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined> {
    let source = this.targetSources.get(target)
    if (source === undefined) {
      const views = this.viewStore as { get(key: string): unknown }
      source = {
        getSnapshot: () => views.get(target),
        subscribe: (listener) => {
          const unsubscribe = this.snapshot.subscribe(listener)
          this.activate(target)
          return unsubscribe
        },
      }
      this.targetSources.set(target, source)
    }
    return source as ObservableSnapshot<ConversationViewSnapshotMap[Target] | undefined>
  }

  activate(target: string): void {
    if (this.assembler.activateTarget(target)) this.published.set(this.currentSnapshot())
    this.openTurn.set(this.assembler.openTurn())
  }

  retainActivity(target: string): () => void {
    const token = Symbol(target)
    this.retainedActivity.set(token, target)
    this.published.set(this.currentSnapshot())
    return () => {
      if (this.retainedActivity.delete(token)) this.published.set(this.currentSnapshot())
    }
  }

  rebuild(): void { this.publish(this.assembler.rebuildRegistry()) }

  registerActivity(target: string, source: ObservableSnapshot<boolean>): () => void {
    if (this.disposed) throw Error('conversation_activity_closed')
    const token = Symbol(target)
    const entry = { target, source, active: source.getSnapshot() }
    this.activities.set(token, entry)
    if (this.subscribers) this.observeActivity(token)
    if (entry.active) this.published.set(this.currentSnapshot())
    return () => {
      const current = this.activities.get(token)
      if (!current) return
      this.activities.delete(token)
      current.stop?.()
      if (!this.disposed && current.active) this.published.set(this.currentSnapshot())
    }
  }

  private observeActivity(token: symbol): void {
    const entry = this.activities.get(token)
    if (!entry || entry.stop !== undefined || this.disposed) return
    const update = () => {
      if (this.disposed || this.activities.get(token) !== entry) return
      const active = entry.source.getSnapshot()
      if (active === entry.active) return
      entry.active = active
      this.published.set(this.currentSnapshot())
    }
    entry.stop = entry.source.subscribe(update)
    update()
  }

  private stopActivities(): void {
    for (const entry of this.activities.values()) {
      const stop = entry.stop
      delete entry.stop
      stop?.()
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopActivities()
    this.activities.clear()
    this.cancelFrame()
    this.disposeFeed()
    this.retainedActivity.clear()
  }

  private replace(window: SessionEventWindow): void {
    this.revision = window.revision
    this.publish(this.assembler.replaceWindow(window.entries, window.hasMore))
  }

  private accept(window: SessionEventWindow): void {
    if (window.revision === this.revision) return
    if (window.revision !== this.revision + 1 || window.change.kind === 'replace') {
      this.replace(window)
      return
    }
    this.revision = window.revision
    switch (window.change.kind) {
      case 'prepend':
        this.publish(this.assembler.prepend(window.change.entries, window.hasMore))
        return
      case 'append': {
        let publication: ConversationPublication = 'none'
        for (const event of window.change.entries) {
          const next = this.assembler.append(event)
          if (next === 'immediate' || publication === 'none') publication = next
        }
        this.publish(publication)
        return
      }
      case 'settle-assistant':
        this.publish(this.assembler.settleAssistant(
          window.change.attemptId,
          window.change.entry,
        ))
        return
    }
  }

  private publish(publication: ConversationPublication): void {
    if (publication === 'none') return
    if (publication === 'animation-frame' && typeof requestAnimationFrame === 'function') {
      if (this.frame !== undefined) return
      // Cross three paint opportunities before publishing high-frequency stream updates.
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = requestAnimationFrame(() => {
            this.frame = undefined
            this.flush()
          })
        })
      })
      return
    }
    this.cancelFrame()
    this.flush()
  }

  private cancelFrame(): void {
    if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frame)
    }
    this.frame = undefined
  }

  private flush(): void {
    if (this.assembler.flush()) this.published.set(this.currentSnapshot())
    this.openTurn.set(this.assembler.openTurn())
  }

  private currentSnapshot(): ConversationSnapshot {
    const activeTargets = new Set([...this.assembler.activityTargets(), ...this.retainedActivity.values()])
    for (const activity of this.activities.values()) {
      if (activity.active) activeTargets.add(activity.target)
    }
    return {
      views: this.viewStore,
      activeTargets,
    }
  }
}

interface BindingRecord {
  readonly source: SessionBinding
  readonly binding: BoundConversation
  disposeScope: () => void
}

/** Root service owning Conversation registries and per-Session bindings. */
export class UiConversation extends Service {
  /** Registry of event matchers and target snapshot builders. */
  readonly events: ConversationEventRegistry
  /** Registry of target View definitions. */
  readonly views: ConversationViewRegistry
  /** Business grouping rules over already materialized target Nodes. */
  readonly groups: ConversationGroupRegistry
  private readonly bindings = new WeakMapWithValues<SessionBinding, BindingRecord>()
  private readonly images: HistoricalImageCache

  /**
   * @param ctx - owning Client context.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx: Context, private readonly sessions: ISessions) {
    super(ctx, 'uiConversation')
    this.events = new ConversationEventRegistry(ctx)
    this.views = new ConversationViewRegistry(ctx)
    this.groups = new ConversationGroupRegistry(ctx, this.views)
    this.images = new HistoricalImageCache(ctx, sessions)
    const rebuild = (): void => {
      for (const record of this.bindings.values) record.binding.rebuild()
    }
    let rebuildQueued = false
    const scheduleRebuild = (): void => {
      if (rebuildQueued) return
      rebuildQueued = true
      queueMicrotask(() => {
        rebuildQueued = false
        rebuild()
      })
    }
    ctx.effect(() => {
      const disposeEvents = this.events.subscribe(scheduleRebuild)
      const disposeViews = this.views.subscribe(scheduleRebuild)
      const disposeGroups = this.groups.subscribe(scheduleRebuild)
      return () => {
        disposeGroups()
        disposeViews()
        disposeEvents()
        for (const record of [...this.bindings.values]) this.drop(record, true)
      }
    }, 'ui-conversation assembly')
  }

  /**
   * Resolve the Conversation binding for one Controller binding or Session id.
   * @param source - Session binding or identity.
   * @returns stable Conversation binding.
   * @throws if the Session is unknown or its binding is no longer current.
   */
  binding(source: SessionBinding | SessionId): ConversationBinding {
    const sessionId = typeof source === 'string' ? source : source.sessionId
    const owner = typeof source === 'string' ? this.sessions.binding(source) : source
    if (owner === undefined) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`)
    if (this.sessions.binding(sessionId) !== owner) {
      throw new Error(`uiConversation.binding: inactive session "${sessionId}"`)
    }
    const current = this.bindings.get(owner)
    if (current !== undefined) return current.binding
    const binding = new BoundConversation(
      owner.eventSource,
      new ConversationNodeAssembler(this.events, this.views, this.groups),
    )
    const record: BindingRecord = { source: owner, binding, disposeScope: () => {} }
    this.bindings.set(owner, record)
    const disposeScope = owner.ctx.effect(
      () => () => { this.drop(record, false) },
      'ui-conversation binding',
    )
    record.disposeScope = () => { void disposeScope() }
    return binding
  }

  /**
   * Resolve one session-authorized durable image URL, cached per Session so
   * every Conversation target shares one read and one browser URL.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference from a session event.
   * @returns browser URL valid until the Session binding is released.
   */
  imageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> {
    return this.images.resolve(sessionId, attachment)
  }

  /**
   * Read a cached durable image URL synchronously when one is available.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference from a session event.
   * @returns current preview or canonical URL, if cached.
   */
  peekImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef): string | undefined {
    return this.images.peek(sessionId, attachment)
  }

  /**
   * Adopt an already-displayable URL for one durable reference (see
   * HistoricalImageCache.seed): the transcript node then renders it without a
   * byte round-trip.
   * @param sessionId - Session authorization and lifetime scope.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took URL ownership.
   */
  seedImageUrl(sessionId: SessionId, attachment: ImageAttachmentRef, url: string): boolean {
    return this.images.seed(sessionId, attachment, url)
  }

  /**
   * Interpret a system message or surface replacement for target-owned prompt Definitions.
   * @param previous - System facts at the preceding relevant loaded event.
   * @param event - Durable system message or positional replacement.
   * @returns Immutable prompt interpretation at this event.
   */
  inspectSystemPrompt(previous: SystemPromptState | undefined, event: SessionEvent): SystemPromptState {
    return inspectSystemPrompt(previous, event)
  }

  /**
   * Canonicalize one `request/header` event against the previous prompt state
   * and the `system/message` node in force.
   *
   * A pure interpretation shared by the Chat and Trajectory Definitions, exposed
   * as a service method because cross-plugin value imports are forbidden in
   * client bundles.
   * @param previous - prompt recorded by the preceding loaded header, if any.
   * @param event - the `request/header` session event to interpret.
   * @param system - effective prompt after loaded surface replacements, if any.
   * @returns the canonical prompt snapshot and any model-visible change.
   */
  inspectRequestPrompt(
    previous: ConversationPromptSnapshot | undefined,
    event: SessionEvent<'request/header'>,
    system: SystemPromptNode | undefined,
  ): RequestPromptInspection {
    return inspectRequestPrompt(previous, event, system)
  }

  private drop(record: BindingRecord, releaseScope: boolean): void {
    if (this.bindings.get(record.source) !== record) return
    this.bindings.delete(record.source)
    record.binding.dispose()
    if (releaseScope) record.disposeScope()
  }
}
