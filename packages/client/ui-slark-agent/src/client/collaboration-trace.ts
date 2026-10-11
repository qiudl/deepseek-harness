/** Readonly original-root audit pages returned by Desktop Main. */
export interface CollaborationTracePage {
  readonly root: { readonly root_task_id: string; readonly root_trace_id: string; readonly task_revision: string; readonly state_version: string; readonly state: string; readonly intent_state: 'active' | 'revoked' }
  readonly events: readonly {
    readonly event_id: string
    readonly root_seq: number
    readonly task_revision: number
    readonly type: string
    readonly phase: string
    readonly occurred_at: string
    readonly recorded_at: string
    readonly trace_context: {
      readonly root_task_id: string
      readonly root_trace_id: string
      readonly task_revision: number
      readonly step_id?: string
      readonly attempt_id?: string
      readonly causation_id?: string
    }
  }[]
  readonly next_after_seq: number | null
  readonly coverage: 'partial'
}
/** A failed read retains no previously authorized cloud records. */
export interface CollaborationTraceView {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly page?: CollaborationTracePage
  readonly execution?: { readonly eventId: string; readonly phase: 'loading' | 'ready' | 'error'; readonly page?: CollaborationExecutionEvidence }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_trace')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw Error('invalid_trace')
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw Error('invalid_trace')
  return value
}
function version(value: unknown): string {
  const v = text(value, 19)
  if (!/^[1-9][0-9]*$/u.test(v) || BigInt(v) > 9223372036854775807n) throw Error('invalid_trace')
  return v
}
function time(value: unknown): string {
  const v = text(value, 24)
  if (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw Error('invalid_trace')
  return v
}
/** Validate order and root identity before publishing a page; pagination cannot roll root state backward.
 * @param value - Main's response envelope.
 * @param after - Last displayed immutable audit sequence.
 * @param prior - Earlier page for this original Source, if already read.
 * @returns A bounded, validated page with no opaque result bodies.
 */
export function readCollaborationTracePage(value: unknown, after: number, prior?: CollaborationTracePage): CollaborationTracePage {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 800 * 1024) throw Error('invalid_trace')
  const envelope = record(value), r = record(envelope.value), root = record(r.root)
  const rootId = text(root.root_task_id), traceId = text(root.root_trace_id, 32)
  const revision = version(root.task_revision), stateVersion = version(root.state_version)
  if (envelope.ok !== true || r.coverage !== 'partial' || !/^(?!0{32}$)[a-f0-9]{32}$/u.test(traceId)
    || !Array.isArray(r.events) || r.events.length > 20
    || (prior && (prior.root.root_task_id !== rootId || prior.root.root_trace_id !== traceId
      || BigInt(revision) < BigInt(prior.root.task_revision) || BigInt(stateVersion) < BigInt(prior.root.state_version)))) throw Error('invalid_trace')
  let sequence = after
  const ids = new Set<string>()
  const events = r.events.map((value: unknown) => {
    const e = record(value), context = record(e.trace_context), seq = count(e.root_seq), rev = count(e.task_revision), id = text(e.event_id)
    if (seq <= sequence || ids.has(id) || BigInt(rev) > BigInt(revision)
      || context.root_task_id !== rootId || context.root_trace_id !== traceId || context.task_revision !== rev) throw Error('invalid_trace')
    ids.add(id); sequence = seq
    return { event_id: id, root_seq: seq, task_revision: rev, type: text(e.type), phase: text(e.phase),
      occurred_at: time(e.occurred_at), recorded_at: time(e.recorded_at),
      trace_context: { root_task_id: rootId, root_trace_id: traceId, task_revision: rev,
        ...(context.step_id === undefined ? {} : { step_id: text(context.step_id) }),
        ...(context.attempt_id === undefined ? {} : { attempt_id: text(context.attempt_id) }),
        ...(context.causation_id === undefined ? {} : { causation_id: text(context.causation_id) }) } }
  })
  if (r.next_after_seq !== null && (count(r.next_after_seq) !== sequence || events.length !== 20)) throw Error('invalid_trace')
  const state = text(root.state), intent = root.intent_state
  if (intent !== 'active' && intent !== 'revoked') throw Error('invalid_trace')
  if (!['active', 'waiting_input', 'waiting_host', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(state)) throw Error('invalid_trace')
  return { root: { root_task_id: rootId, root_trace_id: traceId, task_revision: revision,
    state_version: stateVersion, state, intent_state: intent },
  events, next_after_seq: r.next_after_seq as number | null, coverage: 'partial' }
}

/** Runtime observations are separate from cloud audit sequences and opaque provider internals. */
export interface CollaborationExecutionEvidence {
  readonly event_id: string
  readonly attempt_id: string
  readonly state: string
  readonly digest: string | null
  readonly events: readonly {
    readonly sequence: number
    readonly observedAt: number
    readonly type: string
    readonly runtimeId?: string
    readonly success?: boolean
  }[]
  readonly next_after_sequence: number | null
  readonly provider_visibility: 'boundary_only'
}
/** Read one bounded execution page after its original root page has been validated.
 * @param value - Main's response envelope.
 * @param eventId - Selected immutable settlement event.
 * @param after - Last displayed runtime observation sequence.
 * @param prior - Previously loaded evidence for this settlement.
 * @returns Validated observations without provider bodies or model reasoning.
 */
export function readCollaborationExecutionEvidence(
  value: unknown, eventId: string, after: number, prior?: CollaborationExecutionEvidence,
): CollaborationExecutionEvidence {
  const e = record(record(record(value).value).execution)
  if (e.event_id !== eventId || e.provider_visibility !== 'boundary_only' || !Array.isArray(e.events) || e.events.length > 20
    || (e.digest !== null && (typeof e.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(e.digest)))) throw Error('invalid_evidence')
  const attempt = text(e.attempt_id), state = text(e.state)
  if (!['succeeded', 'failed', 'cancelled', 'revoked', 'indeterminate'].includes(state)
    || (prior && (prior.attempt_id !== attempt || prior.digest !== e.digest || prior.state !== state))) throw Error('invalid_evidence')
  let seq = after
  const events = e.events.map((value: unknown) => {
    const r = record(value), sequence = count(r.sequence), observedAt = r.observedAt, type = text(r.type)
    if (sequence !== seq + 1 || typeof observedAt !== 'number' || !Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > 8640000000000000
      || !['session.started', 'session.completed', 'tool.started', 'tool.completed', 'file.started', 'file.completed', 'error'].includes(type)
      || (r.success !== undefined && typeof r.success !== 'boolean')) throw Error('invalid_evidence')
    seq = sequence
    return { sequence, observedAt, type, ...(r.runtimeId === undefined ? {} : { runtimeId: text(r.runtimeId) }),
      ...(r.success === undefined ? {} : { success: r.success }) }
  })
  if ((e.next_after_sequence !== null && (count(e.next_after_sequence) !== seq || events.length !== 20))
    || (e.digest === null && (events.length || e.next_after_sequence !== null))) throw Error('invalid_evidence')
  return { event_id: eventId, attempt_id: attempt, state, digest: e.digest, events,
    next_after_sequence: e.next_after_sequence as number | null, provider_visibility: 'boundary_only' }
}
