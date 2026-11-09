/** Frozen-v3 owner-private read and delivery results; decoding never advances progress or grants access. */
import { createHash } from 'node:crypto'
import { text, time } from './twin-binding-validation.ts'
import {
  object,
  discriminant,
  choice,
  nullable,
  list,
  reference,
  identifier,
  revision,
  sequence,
  sha,
  hash,
  integer,
  boolean,
  base64,
  cursor,
  requestId,
  utf8,
  checkpoint,
  checkpointFields,
  eventFields,
  budget,
  invalid,
} from './project-operation-memory-values.ts'
import { parseHostProjectOperationEvent } from './project-operation-event.ts'
import {
  parseHostProjectMemorySourceProof,
  parseHostProjectMemoryProjectionProof,
  parseHostProjectMemoryHostAck,
  parseHostProjectMemoryReceipt,
  parseHostProjectMemoryMaterialVersions,
  hostProjectMemoryDirectiveDigest,
  type HostProjectMemoryCheckpoint,
  type HostProjectMemoryReadOperation,
} from './project-operation-memory.ts'
import {
  parseHostProjectMemoryRequest,
  hostProjectMemoryRecipientDigest,
  type HostProjectMemoryCommands,
} from './project-operation-memory-command.ts'

function gap(value: unknown) {
  const g = object(value, {
    fromSequence: sequence,
    toSequence: sequence,
    reason: (v: unknown) =>
      choice(v, ['history_not_selected', 'source_unavailable', 'provider_unsupported', 'version_gap']),
  })
  if (BigInt(g.fromSequence) > BigInt(g.toSequence)) return invalid()
  return g
}
function coverage(value: unknown) {
  const c = object(value, {
    state: (v: unknown) => choice(v, ['complete', 'partial', 'unsupported']),
    fromSequence: sequence,
    scannedThroughSequence: sequence,
    throughSequence: sequence,
    gaps: (v: unknown) => list(v, 20, gap),
  })
  if (
    BigInt(c.fromSequence) > BigInt(c.scannedThroughSequence) ||
    BigInt(c.scannedThroughSequence) > BigInt(c.throughSequence) ||
    c.gaps.some(
      g => BigInt(g.fromSequence) < BigInt(c.fromSequence) || BigInt(g.toSequence) > BigInt(c.throughSequence),
    )
  )
    return invalid()
  return c
}
/** Explicit scan coverage, including filtered or unsupported intervals. */
export type HostProjectMemoryCoverage = ReturnType<typeof coverage>
function coverageFields(c: HostProjectMemoryCoverage): readonly unknown[] {
  return [
    c.state,
    c.fromSequence,
    c.scannedThroughSequence,
    c.throughSequence,
    c.gaps.map(g => [g.fromSequence, g.toSequence, g.reason]),
  ]
}
function terminal(r: Readonly<{ eof: boolean; nextCursor: string | null }>): void {
  if (r.eof !== (r.nextCursor === null)) invalid()
}
function cut(value: unknown) {
  const c = object(value, {
    from: (v: unknown) => nullable(v, time),
    to: (v: unknown) => nullable(v, time),
    timeZone: (v: unknown) => text(v, /^[A-Za-z0-9_+/-]{1,64}$/u),
  })
  new Intl.DateTimeFormat('en', { timeZone: c.timeZone })
  if (c.from !== null && c.to !== null && c.from > c.to) return invalid()
  return c
}
function prepare(value: unknown) {
  const r = object(value, {
    journalEpoch: reference,
    snapshotId: (v: unknown) => nullable(v, reference),
    historyCut: cut,
    syncStartSequence: sequence,
    activationSequence: sequence,
    throughSequence: sequence,
    checkpoint,
    coverage,
    resumeCursor: cursor,
  })
  if (
    r.journalEpoch !== r.checkpoint.journalEpoch ||
    r.coverage.throughSequence !== r.throughSequence ||
    BigInt(r.checkpoint.sequence) > BigInt(r.throughSequence) ||
    BigInt(r.syncStartSequence) > BigInt(r.throughSequence) ||
    BigInt(r.activationSequence) > BigInt(r.throughSequence)
  )
    return invalid()
  return r
}
function page(value: unknown) {
  const r = object(value, {
    events: (v: unknown) => list(v, 50, parseHostProjectOperationEvent),
    scannedThroughSequence: sequence,
    throughSequence: sequence,
    checkpoint,
    nextCursor: cursor,
    eof: boolean,
    coverage,
  })
  terminal(r)
  if (
    r.checkpoint.sequence !== r.scannedThroughSequence ||
    r.coverage.scannedThroughSequence !== r.scannedThroughSequence ||
    r.coverage.throughSequence !== r.throughSequence ||
    BigInt(r.scannedThroughSequence) > BigInt(r.throughSequence) ||
    (r.eof
      ? r.scannedThroughSequence !== r.throughSequence
      : BigInt(r.scannedThroughSequence) >= BigInt(r.throughSequence)) ||
    r.events.some(
      (e, i) =>
        BigInt(e.sourceSequence) > BigInt(r.scannedThroughSequence) ||
        (i > 0 && BigInt(e.sourceSequence) <= BigInt((r.events[i - 1] as typeof e).sourceSequence)),
    )
  )
    return invalid()
  return r
}
function item(value: unknown) {
  const i = object(value, {
    originSide: (v: unknown) => choice(v, ['dsh', 'slark']),
    originActorRef: reference,
    sourceEventId: reference,
    sourceRevision: revision,
    kind: (v: unknown) => choice(v, ['operation', 'result', 'experience', 'suggestion', 'tombstone']),
    snippet: (v: unknown) => utf8(v, 0, 2048),
    rightId: (v: unknown) => nullable(v, identifier),
    rightGeneration: (v: unknown) => nullable(v, revision),
  })
  if ((i.rightId === null) !== (i.rightGeneration === null)) return invalid()
  return i
}
function search(value: unknown) {
  const r = object(value, {
    items: (v: unknown) => list(v, 20, item),
    searchSnapshotId: reference,
    resumeRef: (v: unknown) =>
      object(v, {
        journalEpoch: reference,
        snapshotId: reference,
        throughSequence: sequence,
        checkpoint,
        queryDigest: sha,
      }),
    nextCursor: cursor,
    eof: boolean,
    coverage,
    materialVersions: (v: unknown) => parseHostProjectMemoryMaterialVersions(v, 20),
  })
  terminal(r)
  if (
    r.resumeRef.snapshotId !== r.searchSnapshotId ||
    r.resumeRef.journalEpoch !== r.resumeRef.checkpoint.journalEpoch ||
    r.resumeRef.throughSequence !== r.coverage.throughSequence ||
    BigInt(r.resumeRef.checkpoint.sequence) > BigInt(r.resumeRef.throughSequence) ||
    r.items.some(
      i =>
        i.rightId !== null &&
        !r.materialVersions.some(
          m => m.rightId === i.rightId && m.generation === i.rightGeneration && m.sourceRevision === i.sourceRevision,
        ),
    )
  )
    return invalid()
  return r
}
function evidence(value: unknown) {
  if (choice(discriminant(value, 'status'), ['missing', 'ready']) === 'missing')
    return object(value, { status: (v: unknown) => choice(v, ['missing']) })
  const r = object(value, {
    status: (v: unknown) => choice(v, ['ready']),
    sourceEventId: reference,
    sourceRevision: revision,
    payloadDigest: sha,
    offset: (v: unknown) => integer(v, 0, 1048576),
    totalBytes: (v: unknown) => integer(v, 0, 1048576),
    chunkDigest: sha,
    bytesBase64url: (v: unknown) => base64(v, 0, 16384),
    nextOffset: (v: unknown) => nullable(v, i => integer(i, 0, 1048576)),
    eof: boolean,
  })
  const bytes = Buffer.from(r.bytesBase64url, 'base64url'),
    end = r.offset + bytes.length
  if (
    r.offset > r.totalBytes ||
    end > r.totalBytes ||
    createHash('sha256').update(bytes).digest('hex') !== r.chunkDigest ||
    (r.eof
      ? r.nextOffset !== null || end !== r.totalBytes
      : bytes.length === 0 || r.nextOffset !== end || end >= r.totalBytes) ||
    (r.offset === 0 && r.eof && r.payloadDigest !== r.chunkDigest)
  )
    return invalid()
  return r
}
/** Exact successful results for the five read operations. */
export type HostProjectMemoryReadResults = Readonly<{
  prepare_snapshot: ReturnType<typeof prepare>
  history_page: ReturnType<typeof page>
  delta_page: ReturnType<typeof page>
  search: ReturnType<typeof search>
  evidence: ReturnType<typeof evidence>
}>
/** Read result data without signed-envelope verification. */
export type HostProjectMemoryReadResult = HostProjectMemoryReadResults[HostProjectMemoryReadOperation]
const parsers = { prepare_snapshot: prepare, history_page: page, delta_page: page, search, evidence }
/**
 * Parse intrinsic result consistency.
 * @param operation - Read selector.
 * @param value - Untrusted result.
 * @returns Detached bounded result, without durable progress or permission.
 */
export function parseHostProjectMemoryReadResult(operation: unknown, value: unknown): HostProjectMemoryReadResult {
  return budget(
    parsers[choice(operation, ['prepare_snapshot', 'history_page', 'delta_page', 'search', 'evidence'])](value),
    32768,
  )
}
function resultFields(op: HostProjectMemoryReadOperation, value: HostProjectMemoryReadResult): readonly unknown[] {
  if (op === 'prepare_snapshot') {
    const r = value as HostProjectMemoryReadResults['prepare_snapshot']
    return [
      r.journalEpoch,
      r.snapshotId,
      [r.historyCut.from, r.historyCut.to, r.historyCut.timeZone],
      r.syncStartSequence,
      r.activationSequence,
      r.throughSequence,
      checkpointFields(r.checkpoint),
      coverageFields(r.coverage),
      r.resumeCursor,
    ]
  }
  if (op === 'history_page' || op === 'delta_page') {
    const r = value as HostProjectMemoryReadResults['history_page']
    return [
      r.events.map(eventFields),
      r.scannedThroughSequence,
      r.throughSequence,
      checkpointFields(r.checkpoint),
      r.nextCursor,
      r.eof,
      coverageFields(r.coverage),
    ]
  }
  if (op === 'search') {
    const r = value as HostProjectMemoryReadResults['search'],
      c = r.resumeRef
    return [
      r.items.map(i => [
        i.originSide,
        i.originActorRef,
        i.sourceEventId,
        i.sourceRevision,
        i.kind,
        i.snippet,
        i.rightId,
        i.rightGeneration,
      ]),
      r.searchSnapshotId,
      [c.journalEpoch, c.snapshotId, c.throughSequence, checkpointFields(c.checkpoint), c.queryDigest],
      r.nextCursor,
      r.eof,
      coverageFields(r.coverage),
      r.materialVersions.map(m => [m.rightId, m.generation, m.sourceRevision]),
    ]
  }
  const r = value as HostProjectMemoryReadResults['evidence']
  return r.status === 'missing'
    ? [r.status]
    : [
      r.status,
      r.sourceEventId,
      r.sourceRevision,
      r.payloadDigest,
      r.offset,
      r.totalBytes,
      r.chunkDigest,
      r.bytesBase64url,
      r.nextOffset,
      r.eof,
    ]
}
/**
 * Digest every successful read field, excluding proofs.
 * @param operation - Read selector.
 * @param value - Untrusted result.
 * @returns Frozen read-result digest.
 */
export function hostProjectMemoryReadResultDigest(operation: unknown, value: unknown): ReturnType<typeof sha> {
  const op = choice(operation, ['prepare_snapshot', 'history_page', 'delta_page', 'search', 'evidence'])
  return hash('read-result', [op, resultFields(op, parseHostProjectMemoryReadResult(op, value))])
}
const codes = [
  'unauthorized',
  'binding_inactive',
  'scope_changed',
  'source_changed',
  'material_revoked',
  'journal_epoch_changed',
  'cursor_invalid',
  'cursor_expired',
  'capability_unavailable',
  'payload_too_large',
  'conflict',
  'timeout',
] as const
function failure(value: unknown) {
  return object(value, {
    status: (v: unknown) => choice(v, ['error']),
    code: (v: unknown) => choice(v, codes),
    requestId,
    retryable: boolean,
  })
}
function readEnvelope(request: unknown, value: unknown, options: unknown) {
  const req = parseHostProjectMemoryRequest(request),
    d = req.directive,
    s = d.scope
  const op = choice(d.operation, ['prepare_snapshot', 'history_page', 'delta_page', 'search', 'evidence'])
  if (discriminant(value, 'status') === 'error') {
    const f = failure(value)
    if (f.requestId !== d.requestId) return invalid()
    return f
  }
  const r = object(value, {
    status: (v: unknown) => choice(v, ['ok']),
    operation: (v: unknown) => choice(v, [op]),
    result: (v: unknown) => parseHostProjectMemoryReadResult(op, v),
    sourceProof: (v: unknown) => nullable(v, parseHostProjectMemorySourceProof),
    projectionProof: (v: unknown) => nullable(v, parseHostProjectMemoryProjectionProof),
  })
  const p = r.sourceProof ?? r.projectionProof,
    recipient = hostProjectMemoryRecipientDigest(d)
  if (p === null || (r.sourceProof !== null && r.projectionProof !== null)) return invalid()
  if (r.sourceProof === null && op === 'prepare_snapshot') return invalid()
  if (r.sourceProof === null && (op === 'history_page' || op === 'delta_page')) return invalid()
  if (
    p.operation !== op ||
    p.authorityEnvironmentId !== d.authorityEnvironmentId ||
    p.readDirectiveDigest !== hostProjectMemoryDirectiveDigest(d) ||
    p.scopeDigest !== s.scopeDigest ||
    p.recipientDigest !== recipient ||
    p.resultDigest !== hostProjectMemoryReadResultDigest(op, r.result) ||
    p.issuedAt < d.issuedAt ||
    p.expiresAt > d.expiresAt
  )
    return invalid()
  const source = r.sourceProof,
    projection = r.projectionProof
  if (
    source !== null &&
    (source.side !== s.sourceRef.side ||
      source.sourceActorRef !== s.sourceRef.actorRef ||
      source.bindingId !== s.bindingId ||
      source.bindingGeneration !== s.bindingGeneration ||
      source.scopeVersion !== s.scopeVersion)
  )
    return invalid()
  const check = (c: HostProjectMemoryCheckpoint): void => {
    if (
      c.scopeDigest !== s.scopeDigest ||
      c.recipientDigest !== recipient ||
      (source !== null && c.journalEpoch !== source.journalEpoch)
    )
      invalid()
  }
  if (op === 'prepare_snapshot') {
    const result = r.result as HostProjectMemoryReadResults['prepare_snapshot'],
      c = req.commandBody as HostProjectMemoryCommands['prepare_snapshot']
    check(result.checkpoint)
    if (
      result.historyCut.from !== s.historyFrom ||
      result.historyCut.to !== s.historyTo ||
      result.historyCut.timeZone !== s.timeZone ||
      (source as NonNullable<typeof source>).snapshotId !== result.snapshotId
    )
      return invalid()
    if (c.mode === 'resume') {
      if (
        result.resumeCursor === null ||
        result.journalEpoch !== c.journalEpoch ||
        result.snapshotId !== c.snapshotId ||
        result.throughSequence !== c.throughSequence ||
        JSON.stringify(checkpointFields(result.checkpoint)) !== JSON.stringify(checkpointFields(c.checkpoint))
      )
        return invalid()
    } else if (result.resumeCursor !== null || (c.mode === 'delta') !== (result.snapshotId === null)) return invalid()
  } else if (op === 'history_page' || op === 'delta_page') {
    const result = r.result as HostProjectMemoryReadResults['history_page'],
      c = req.commandBody as HostProjectMemoryCommands['history_page'] | HostProjectMemoryCommands['delta_page']
    const previous = object(options, { previousCheckpoint: checkpoint }).previousCheckpoint
    check(result.checkpoint)
    check(previous)
    if (
      previous.journalEpoch !== c.journalEpoch ||
      result.checkpoint.journalEpoch !== c.journalEpoch ||
      result.throughSequence !== c.throughSequence ||
      BigInt(result.scannedThroughSequence) < BigInt(previous.sequence) ||
      (!result.eof && BigInt(result.scannedThroughSequence) <= BigInt(previous.sequence)) ||
      result.events.length > c.pageSize ||
      Buffer.byteLength(JSON.stringify(result)) > c.maxBytes ||
      (source as NonNullable<typeof source>).snapshotId !==
        (op === 'history_page' ? (c as HostProjectMemoryCommands['history_page']).snapshotId : null) ||
      result.events.some(
        e =>
          BigInt(e.sourceSequence) <= BigInt(previous.sequence) ||
          e.originSide !== s.sourceRef.side ||
          e.originActorRef !== s.sourceRef.actorRef ||
          e.projectId !== s.projectId ||
          !s.materialKinds.includes(e.kind) ||
          (op === 'history_page' && (e.occurredAt < s.historyFrom || e.occurredAt > s.historyTo)),
      )
    )
      return invalid()
  } else if (op === 'search') {
    const result = r.result as HostProjectMemoryReadResults['search'],
      c = req.commandBody as HostProjectMemoryCommands['search']
    check(result.resumeRef.checkpoint)
    if (
      result.resumeRef.queryDigest !== c.queryDigest ||
      result.items.length > c.limit ||
      Buffer.byteLength(JSON.stringify(result)) > c.maxBytes ||
      result.items.some(
        i =>
          !s.materialKinds.includes(i.kind) ||
          (source !== null && (i.originSide !== s.sourceRef.side || i.originActorRef !== s.sourceRef.actorRef)),
      ) ||
      (source !== null && source.snapshotId !== result.searchSnapshotId) ||
      (projection !== null && JSON.stringify(projection.materialVersions) !== JSON.stringify(result.materialVersions))
    )
      return invalid()
  } else {
    const result = r.result as HostProjectMemoryReadResults['evidence'],
      c = req.commandBody as HostProjectMemoryCommands['evidence']
    if (
      result.status === 'ready' &&
      (result.sourceEventId !== c.sourceEventId ||
        result.sourceRevision !== c.sourceRevision ||
        result.offset !== c.offset ||
        Buffer.from(result.bytesBase64url, 'base64url').length > c.maxBytes ||
        (projection !== null &&
          (c.rightId === null ||
            !projection.materialVersions.some(
              m =>
                m.rightId === c.rightId && m.generation === c.rightGeneration && m.sourceRevision === c.sourceRevision,
            ))))
    )
      return invalid()
  }
  return r
}
/** A source or retained-read envelope, or one closed error; all authority checks remain external. */
export type HostProjectMemoryReadEnvelope = ReturnType<typeof readEnvelope>
/**
 * Cross-bind request, proof and result bytes.
 * @param request - Untrusted request.
 * @param value - Untrusted envelope.
 * @param options - Exact previous checkpoint required for pages.
 * @returns Detached consistent fields; no key verification, current permission, or durable progress.
 */
export function parseHostProjectMemoryReadEnvelope(
  request: unknown,
  value: unknown,
  options: unknown = {},
): HostProjectMemoryReadEnvelope {
  return readEnvelope(request, value, options)
}
function finalizeResult(value: unknown) {
  return object(value, {
    deliveryId: identifier,
    batchId: identifier,
    batchDigest: sha,
    status: (v: unknown) => choice(v, ['activated', 'already_activated', 'reconciliation_only']),
    checkpoint,
    activatedAt: (v: unknown) => nullable(v, time),
  })
}
/** Host activation result fields from Doc21558; decoding is not activation or current permission. */
export type HostProjectMemoryFinalizeResult = ReturnType<typeof finalizeResult>
/**
 * Parse the Doc-defined finalize success.
 * @param value - Untrusted exact fields.
 * @returns Detached activation claim without permission verification.
 */
export function parseHostProjectMemoryFinalizeResult(value: unknown): HostProjectMemoryFinalizeResult {
  return finalizeResult(value)
}
function receiptResult(value: unknown) {
  if (choice(discriminant(value, 'status'), ['missing', 'found']) === 'missing')
    return object(value, { status: (v: unknown) => choice(v, ['missing']) })
  return object(value, {
    status: (v: unknown) => choice(v, ['found']),
    hostApplyAck: parseHostProjectMemoryHostAck,
    cloudMaterialReceipt: (v: unknown) => nullable(v, parseHostProjectMemoryReceipt),
    effectiveState: (v: unknown) => choice(v, ['staged', 'active', 'reconciliation_only']),
  })
}
/** Exact receipt status; staged is distinct from Cloud commit and target activation. */
export type HostProjectMemoryReceiptResult = ReturnType<typeof receiptResult>
/**
 * Parse the Doc-defined receipt result.
 * @param value - Untrusted exact fields.
 * @returns Detached receipt claims without verifying keys or current effective state.
 */
export function parseHostProjectMemoryReceiptResult(value: unknown): HostProjectMemoryReceiptResult {
  return receiptResult(value)
}
