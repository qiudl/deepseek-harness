/** Profile cursors that outlive the control connection that opened them. */
import type { RemoteUiStreamCursor } from './remote-ui-stream-cursor.ts'
import { HostAuthorityError } from './types.ts'

/** View generation that opened one cursor and addresses it for every later request. */
export interface RemoteUiStreamCoordinates {
  readonly viewLeaseId: string
  readonly leaseGeneration: number
  readonly runtimeGeneration: number
}

/** One live worker stream with the coordinates its client keeps sending. */
export interface RemoteUiStreamCursorEntry {
  readonly cursor: RemoteUiStreamCursor
  readonly profileId: string
  readonly coordinates: RemoteUiStreamCoordinates
  /** Connection that opened the cursor, or the one that last resumed it. */
  ownerId: string
  /** Set when that connection closed and the cursor awaits a resuming connection. */
  orphanedAt?: number
}

/** Connection count and release delay for cursors awaiting a resuming connection. */
export interface RemoteUiStreamCursorStoreOptions {
  readonly now: () => number
  /** Time a cursor stays resumable after its owning connection closes. */
  readonly orphanGraceMs?: number
}

/** Concurrent Profile cursors bounded per Profile and across the Host. */
const MAXIMUM_CURSORS_PER_PROFILE = 8
const MAXIMUM_CURSORS = 32
/** Default resumability window; matches the desktop view lease lifetime. */
const DEFAULT_ORPHAN_GRACE_MS = 60_000

/**
 * Hold the live worker streams of every Profile view.
 * A control connection owns the cursors it opens, but a closed connection only orphans them: the
 * same client reconnects with a new connection, and a cursor whose recorded coordinates still match
 * the client's pinned ones is resumed there. Only replacement, lease reauthorization, and the grace
 * release the worker stream.
 */
export class RemoteUiStreamCursors {
  private readonly entries = new Map<string, RemoteUiStreamCursorEntry>()
  private readonly lifetime = new AbortController()

  /** Owner lifetime of every cursor: aborting it closes each opening and registered stream. */
  readonly signal: AbortSignal = this.lifetime.signal

  constructor(private readonly options: RemoteUiStreamCursorStoreOptions) {}

  /**
   * Read one registered cursor without changing it.
   * @param streamId - client-chosen cursor id.
   * @returns the live cursor, or `undefined` when no Profile holds that id.
   */
  get(streamId: string): RemoteUiStreamCursorEntry | undefined {
    return this.entries.get(streamId)
  }

  /**
   * Refuse one more cursor before its worker stream opens.
   * Expired orphans are released first so a reconnecting client never blocks on them.
   * @param streamId - client-chosen cursor id.
   * @param profileId - Profile the requesting connection is authorized for.
   */
  async assertAvailable(streamId: string, profileId: string): Promise<void> {
    await this.sweep()
    const sameProfile = [...this.entries.values()].filter(entry => entry.profileId === profileId)
    if (this.entries.has(streamId) || sameProfile.length >= MAXIMUM_CURSORS_PER_PROFILE
      || this.entries.size >= MAXIMUM_CURSORS) throw new HostAuthorityError('conflict')
  }

  /**
   * Register a cursor opened for one Profile view.
   * @param input - cursor, owning Profile, opening coordinates, and opening connection.
   */
  async register(input: {
    readonly streamId: string
    readonly cursor: RemoteUiStreamCursor
    readonly profileId: string
    readonly coordinates: RemoteUiStreamCoordinates
    readonly ownerId: string
  }): Promise<void> {
    await this.assertAvailable(input.streamId, input.profileId)
    this.entries.set(input.streamId, {
      cursor: input.cursor,
      profileId: input.profileId,
      coordinates: input.coordinates,
      ownerId: input.ownerId,
    })
  }

  /**
   * Remove one cursor so its caller can close it.
   * @param streamId - client-chosen cursor id.
   * @returns the removed cursor, or `undefined` when the id is unknown.
   */
  take(streamId: string): RemoteUiStreamCursorEntry | undefined {
    const entry = this.entries.get(streamId)
    if (entry) this.entries.delete(streamId)
    return entry
  }

  /**
   * Mark every cursor of a closing connection as resumable.
   * @param ownerId - authenticated connection that closed.
   */
  detachOwner(ownerId: string): void {
    const orphanedAt = this.options.now()
    for (const entry of this.entries.values()) {
      if (entry.ownerId === ownerId && entry.orphanedAt === undefined) entry.orphanedAt = orphanedAt
    }
  }

  /**
   * Record the connection that resumed a cursor and cancel its release.
   * @param entry - cursor returned by {@link get}.
   * @param ownerId - authenticated connection that presented the cursor's coordinates.
   */
  adopt(entry: RemoteUiStreamCursorEntry, ownerId: string): void {
    entry.ownerId = ownerId
    delete entry.orphanedAt
  }

  /**
   * Release cursors whose resumability window elapsed.
   * @returns nothing; release runs the worker stream's own close before dropping the entry.
   */
  async sweep(): Promise<void> {
    const expired = [...this.entries.entries()].filter(([, entry]) => entry.orphanedAt !== undefined
      && entry.orphanedAt + this.grace() <= this.options.now())
    await Promise.all(expired.map(async ([streamId, entry]) => {
      this.entries.delete(streamId)
      await entry.cursor.close()
    }))
  }

  /**
   * Release every cursor, for example when the Host stops.
   * @returns nothing; every worker stream is closed before the store empties.
   */
  async closeAll(): Promise<void> {
    this.lifetime.abort()
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(async entry => entry.cursor.close()))
  }

  private grace(): number {
    return this.options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS
  }
}
