/** Independent display positions; ordinary Session data remains owned by Chat. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One independently persisted record and its immutable ordinary-history position. */
export interface ChatTimelineRecord {
  readonly recordId: string
  readonly afterSequence: number | null
  readonly localOrder: string
}

/** Display-only registration seam; sources do not submit prompts or execute tasks. */
export interface ChatTimeline {
  /**
   * Register the independent record source for a Session.
   * @param sessionId - Original Session that owns these display records.
   * @param source - Validated, stable snapshot of positioned records.
   * @returns Idempotent removal; a viewed Session observes the empty replacement.
   */
  register(sessionId: SessionId, source: ObservableSnapshot<readonly ChatTimelineRecord[]>): () => void
}

const EMPTY: readonly ChatTimelineRecord[] = Object.freeze([])

interface TimelineEntry {
  store: ReturnType<typeof createSnapshotStore<readonly ChatTimelineRecord[]>>
  source?: ObservableSnapshot<readonly ChatTimelineRecord[]>
  stop?: () => void
  listeners: number
  observable: ObservableSnapshot<readonly ChatTimelineRecord[]>
}

/** Private Chat owner of visible-lifetime subscriptions and late registrations. */
export class ChatTimelineRegistry implements ChatTimeline {
  private readonly entries = new Map<SessionId, TimelineEntry>()
  private closed = false

  /**
   * Resolve the stable Chat view source for one Session.
   * @param sessionId - Viewed Session identity.
   * @returns Observable positions whose provider subscription follows visible readers.
   */
  source(sessionId: SessionId): ObservableSnapshot<readonly ChatTimelineRecord[]> {
    return this.entry(sessionId).observable
  }

  private entry(sessionId: SessionId): TimelineEntry {
    if (this.closed) throw Error('chat_timeline_closed')
    const entry = this.entries.get(sessionId)
    if (entry) return entry
    const store = createSnapshotStore(EMPTY)
    const current: TimelineEntry = { store, listeners: 0, observable: {
      getSnapshot: () => store.getSnapshot(),
      subscribe: (listener) => {
        if (this.closed) return () => {}
        const stop = store.subscribe(listener)
        if (++current.listeners === 1) this.observe(current)
        let active = true
        return () => {
          if (!active) return
          active = false
          stop()
          if (--current.listeners === 0) { current.stop?.(); delete current.stop }
        }
      },
    } }
    this.entries.set(sessionId, current)
    return current
  }

  register(sessionId: SessionId, source: ObservableSnapshot<readonly ChatTimelineRecord[]>): () => void {
    const entry = this.entry(sessionId)
    if (entry.source) throw Error('chat_timeline_already_registered')
    entry.source = source
    entry.store.set(source.getSnapshot())
    this.observe(entry)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (entry.source !== source) return
      delete entry.source
      entry.stop?.(); delete entry.stop
      entry.store.set(EMPTY)
    }
  }

  /** Stop all provider observations and publish empty history when the Chat owner unloads. */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) {
      delete entry.source
      entry.stop?.(); delete entry.stop
      entry.store.set(EMPTY)
    }
  }

  private observe(entry: TimelineEntry): void {
    const source = entry.source
    if (!source || entry.listeners === 0 || entry.stop) return
    entry.stop = source.subscribe(() => {
      if (!this.closed && entry.source === source) entry.store.set(source.getSnapshot())
    })
    entry.store.set(source.getSnapshot())
  }
}
