/** Read-only local failure observations; neither absence nor presence authorizes replay. */
import { awaitCollaborationRead as wait } from './collaboration-read.ts'
import type { SessionCollaborationSourceItem } from '@deepseek-ai/dsh-api-session-controller/types'

type Original = SessionCollaborationSourceItem
type Source = Original['source']
const reasons = ['timeout', 'cancelled', 'invalid_json', 'invalid_stream', 'budget', 'model_failure', 'unclassified'] as const
/** A retained local observation, separate from the coordinator's current task state. */
export interface CollaborationPlanningFailure {
  readonly reason: typeof reasons[number]
  readonly observedAt: string
}
type Entry = { readonly original: Original; nextRead: number; failure?: CollaborationPlanningFailure }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_diagnostic')
  return value as Record<string, unknown>
}
/**
 * Read bounded finite observations for the exact original Source.
 * @param value - Current account-bound Main response.
 * @param original - Native original with independently read coordinates and digest.
 * @returns Historical observation, unsupported capability, or no local observation.
 */
export function readCollaborationPlanningFailure(value: unknown, original: Original): CollaborationPlanningFailure | 'unsupported' | undefined {
  const reply = record(value)
  if (reply.ok === false) {
    if (reply.errorCode === 'dsh_host_upgrade_required') return 'unsupported'
    throw Error('diagnostic_unavailable')
  }
  if (reply.ok !== true) throw Error('invalid_diagnostic')
  const evidence = record(reply.value), root = record(evidence.root), source = record(root.source_descriptor)
  if (typeof root.root_trace_id !== 'string' || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(root.root_trace_id) ||
    source.snapshot_digest !== original.snapshot_digest ||
    Object.entries(original.source).some(([key, value]) => source[key] !== value) ||
    !Array.isArray(evidence.failures) || evidence.failures.length > 8) throw Error('invalid_diagnostic')
  let latest: CollaborationPlanningFailure | undefined
  for (const value of evidence.failures) {
    const row = record(value), reason = reasons.find(reason => reason === row.reason)
    if (!reason || row.source_digest !== original.snapshot_digest || row.trace_id !== root.root_trace_id ||
      typeof row.observed_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.observed_at) ||
      !Number.isFinite(Date.parse(row.observed_at)) || new Date(row.observed_at).toISOString() !== row.observed_at)
      throw Error('invalid_diagnostic')
    if (!latest || row.observed_at > latest.observedAt) latest = { reason, observedAt: row.observed_at }
  }
  return latest
}
/** Existing result refreshes drive bounded background reads; successful delivery never waits on them. */
export class CollaborationDiagnosticProjection {
  private readonly entries = new Map<string, Entry>()
  private readonly active = new Map<string, AbortController>()
  private unsupported = false
  constructor(private read: (source: Source) => Promise<unknown>, private current: () => boolean,
    private changed: () => void, private clock = () => performance.now()) {}
  /** Keep metadata only for originals still present in the authorized result projection.
   * @param digests - Current bounded result-view membership.
   */
  retain(digests: ReadonlySet<string>): void {
    for (const [digest] of this.entries) if (!digests.has(digest)) {
      this.entries.delete(digest); this.active.get(digest)?.abort()
    }
  }
  /** Observe long-running planning without introducing another timer or changing task state.
   * @param original - Original Source already checked by the result reader.
   * @param eligible - Planning without output; false stops observations, undefined preserves them while planning metadata loads.
   * @returns A historical finite failure observation, never an execution or retry decision.
   */
  observe(original: Original, eligible: boolean | undefined): CollaborationPlanningFailure | undefined {
    const digest = original.snapshot_digest
    if (eligible === undefined) return this.entries.get(digest)?.failure
    if (!eligible) {
      this.entries.delete(digest); this.active.get(digest)?.abort()
      return undefined
    }
    let entry = this.entries.get(digest)
    if (!entry) {
      entry = { original, nextRead: this.clock() + 30_000 }
      this.entries.set(digest, entry)
    }
    if (!this.unsupported && this.clock() >= entry.nextRead && !this.active.has(digest) && this.active.size < 2) {
      const controller = new AbortController()
      this.active.set(digest, controller)
      void this.load(digest, entry, controller)
    }
    return entry.failure
  }
  private async load(digest: string, entry: Entry, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(75_000)])
    let changed = false, response: Promise<unknown> | undefined
    try {
      response = this.read(structuredClone(entry.original.source))
      const value = await wait(response, signal)
      if (signal.aborted || !this.current() || this.entries.get(digest) !== entry) return
      const result = readCollaborationPlanningFailure(value, entry.original)
      if (result === 'unsupported') { this.unsupported = true; return }
      if (result && (result.reason !== entry.failure?.reason || result.observedAt !== entry.failure.observedAt)) {
        entry.failure = result; changed = true
      }
    } catch { /* A diagnostic read failure supplies no task state or retry permission. */ }
    finally {
      const release = () => {
        this.active.delete(digest)
        entry.nextRead = this.clock() + 30_000
        if (changed && !signal.aborted && this.current() && this.entries.get(digest) === entry) this.changed()
      }
      // IPC has no per-call cancellation: keep its slot until the underlying bounded Main read settles.
      if (response && signal.aborted) void response.then(release, release)
      else release()
    }
  }
  /** Cancel view-owned reads and discard local observations; accepted tasks remain untouched. */
  stop(): void {
    this.active.forEach((controller) =>{  controller.abort() }); this.entries.clear(); this.unsupported = false
  }
}
