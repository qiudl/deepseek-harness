/** View-only provisional text; no Session persistence, invocation creation or delivery acknowledgement. */
type Source = { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }
/** Opaque Main selection for a task whose original execution receipt is already recorded. */
export type ResponseAdmission = { source: Source; previewId: string; taskId: string }
/** Current view-only body; exact original delivery replaces it without persisting the prefix. */
export interface ProvisionalCollaborationResponse {
  readonly source: Source
  readonly sourceDigest: string
  readonly invocationId: string
  readonly taskId: string
  readonly seq: string
  readonly fence: string
  readonly text: string
  readonly textDigest: string
  readonly agentName: string
  readonly projectName: string | null
}
/** Subscribe to original task text; the returned disposer stops reads without changing execution. */
export type ResponseSubscribe = (request: { previewId: string; taskId: string }, receive: (value: unknown) => void) => () => void
const sameSource = (a: Source, b: Source) => a.workspace_id === b.workspace_id && a.session_id === b.session_id
  && a.source_message_id === b.source_message_id && a.source_revision === b.source_revision
const integer = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value)
  && BigInt(value) <= 9223372036854775807n
const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && !/\p{Surrogate}/u.test(value) && new TextEncoder().encode(value).length <= max
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_response')
  return value as Record<string, unknown>
}
function source(value: unknown): Source {
  const r = row(value)
  if (Object.keys(r).sort().join(',') !== 'session_id,source_message_id,source_revision,workspace_id'
    || !['workspace_id','session_id','source_message_id'].every(key => text(r[key], 256) && r[key] !== '')
    || !integer(r.source_revision)) throw Error('invalid_response')
  return { ...r } as Source
}
type Entry = {
  admission: ResponseAdmission
  stop?: () => void
  timer?: ReturnType<typeof setTimeout>
  startedAt: number
  generation: number
  body?: ProvisionalCollaborationResponse
  last?: ProvisionalCollaborationResponse
  invocationId?: string
}

/** Own subscriptions only while one authorized view generation remains observed. */
export class CollaborationResponseProjection {
  private readonly entries = new Map<string, Entry>()
  constructor(private subscribe: ResponseSubscribe, private current: () => boolean, private changed: (terminal?: boolean) => void) {}

  /**
   * Follow a task already admitted by Main; arbitrary coordinates never authorize a cloud read.
   * @param value - Original Source and opaque Main preview/task selection from the admission event.
   */
  admit(value: unknown): void {
    try {
      if (!this.current()) return
      const r = row(value)
      if (Object.keys(r).sort().join(',') !== 'previewId,source,taskId' || !text(r.previewId, 256) || !r.previewId
        || !text(r.taskId, 256) || !r.taskId) return
      const admission = { source: source(r.source), previewId: r.previewId, taskId: r.taskId }
      const key = JSON.stringify([admission.previewId, admission.taskId])
      if (this.entries.has(key) || this.entries.size >= 8) return
      const entry: Entry = { admission, startedAt: Date.now(), generation: 0 }
      this.entries.set(key, entry)
      this.connect(key, entry)
    } catch { /* malformed page events grant no authority */ }
  }
  private connect(key: string, entry: Entry): void {
    if (!this.current() || this.entries.get(key) !== entry) return
    const generation = ++entry.generation
    let stop: (() => void) | undefined
    const connection = { received: false, stopped: false }
    const close = () => { connection.stopped = true; stop?.(); delete entry.stop }
    entry.stop = close
    try {
      stop = this.subscribe({ previewId: entry.admission.previewId, taskId: entry.admission.taskId }, (value) => {
        if (connection.stopped || !this.current() || entry.generation !== generation || this.entries.get(key) !== entry) return
        try {
          const r = row(value)
          if (r.kind === 'closed' && Object.keys(r).length === 1) {
            close()
            delete entry.body; this.changed()
            if (this.entries.get(key) === entry && Date.now() - entry.startedAt < 120_000)
              entry.timer = setTimeout(() => { delete entry.timer; this.connect(key, entry) }, 1000)
            else this.entries.delete(key)
            return
          }
          const locator = source(r.source_locator)
          if (!sameSource(locator, entry.admission.source) || r.task_id !== entry.admission.taskId) throw Error('invalid_response')
          const expected = ['kind','source_locator','task_id','target_display_snapshot', ...(r.kind === 'terminal_available' ? ['invocation_id']
            : r.kind === 'response_snapshot' ? ['schema_version','invocation_id','attempt_fence','seq','source_digest','provisional','text','text_digest','emitted_at'] : [])].sort().join(',')
          if (Object.keys(r).sort().join(',') !== expected) throw Error('invalid_response')
          if (r.kind === 'unavailable') { close(); this.entries.delete(key); this.changed(); return }
          if (r.kind === 'terminal_available') {
            if (!text(r.invocation_id, 256) || !r.invocation_id || (entry.last && r.invocation_id !== entry.last.invocationId)) throw Error('invalid_response')
            entry.invocationId = r.invocation_id
            close(); this.changed(true); return
          }
          if (r.kind !== 'response_snapshot' || r.schema_version !== 1 || r.provisional !== true
            || !text(r.invocation_id, 256) || !r.invocation_id || !digest(r.source_digest) || !digest(r.text_digest)
            || !integer(r.seq) || !integer(r.attempt_fence) || !text(r.text, 128 * 1024) || !r.text) throw Error('invalid_response')
          const display = row(r.target_display_snapshot)
          if (!text(display.agent_name, 512) || !display.agent_name ||
            !(display.project_name === null || text(display.project_name, 512))) throw Error('invalid_response')
          if (entry.last && (r.invocation_id !== entry.last.invocationId || r.source_digest !== entry.last.sourceDigest
            || r.attempt_fence !== entry.last.fence || BigInt(r.seq) < BigInt(entry.last.seq)
            || (BigInt(r.seq) === BigInt(entry.last.seq) && (connection.received || r.text_digest !== entry.last.textDigest)))) throw Error('invalid_response')
          entry.body = { source: locator, sourceDigest: r.source_digest, invocationId: r.invocation_id, taskId: r.task_id,
            seq: r.seq, fence: r.attempt_fence, text: r.text, textDigest: r.text_digest,
            agentName: display.agent_name, projectName: display.project_name }
          entry.last = entry.body; entry.invocationId = entry.body.invocationId; connection.received = true
          this.changed()
        } catch { close(); this.entries.delete(key); this.changed() }
      })
      if (connection.stopped) stop()
    } catch { close(); this.entries.delete(key); this.changed() }
  }
  /**
   * Read current authorized bodies and retire those replaced by original final delivery.
   * @param original - Native-persisted Source coordinates and exact snapshot digest.
   * @param delivered - Original verified final invocation identities.
   * @returns Only provisional bodies belonging to that exact original message.
   */
  read(original: { source: Source; snapshot_digest: string }, delivered: readonly string[]): readonly ProvisionalCollaborationResponse[] {
    if (!this.current()) { this.stop(); return [] }
    const values: ProvisionalCollaborationResponse[] = []
    for (const [key, entry] of this.entries) {
      if (sameSource(original.source, entry.admission.source) && entry.invocationId && delivered.includes(entry.invocationId)) {
        entry.stop?.(); if (entry.timer) clearTimeout(entry.timer); this.entries.delete(key); continue
      }
      const body = entry.body
      if (!body || !sameSource(original.source, body.source) || original.snapshot_digest !== body.sourceDigest) continue
      values.push(body)
    }
    return values
  }
  /** Stop timers and discard every provisional body when its view or authority generation ends. */
  stop(): void {
    for (const entry of this.entries.values()) { entry.stop?.(); if (entry.timer) clearTimeout(entry.timer) }
    this.entries.clear()
  }
}
